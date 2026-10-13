import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const { createSqliteMessageStore } = await import("../src/db/sqlite.js");
const { decodeCursor } = await import("../src/db/inbox.js");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "wa-sqlite-"));
}

function open(file) {
  return new DatabaseSync(file);
}

function base(over = {}) {
  return {
    id: "A",
    chat: "123@s.whatsapp.net",
    isGroup: false,
    fromMe: true,
    sender: null,
    text: "hi",
    senderEmail: null,
    receivedAt: Date.now(),
    raw: { key: { id: "A" }, message: { conversation: "hi" } },
    ...over,
  };
}

test("creates chats/messages schema and persists a message", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  store.save(base());

  const db = open(file);
  const messages = db.prepare("select id, chat_jid, from_me, content from messages").all();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "A");
  assert.equal(messages[0].chat_jid, "123@s.whatsapp.net");
  assert.equal(messages[0].from_me, 1);
  assert.equal(messages[0].content, "hi");

  const chats = db.prepare("select jid, is_group from chats").all();
  assert.equal(chats.length, 1, "chat row upserted alongside the message");
  assert.equal(chats[0].jid, "123@s.whatsapp.net");
  assert.equal(chats[0].is_group, 0);

  db.close();
  store.close();
});

test("duplicate message ids are ignored (insert or ignore)", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  store.save(base());
  store.save(base({ text: "second delivery" }));

  const db = open(file);
  const c = db.prepare("select count(*) as c from messages").get();
  assert.equal(c.c, 1, "redelivery with the same id must not duplicate");
  db.close();
  store.close();
});

test("maps columns: sender_email, iso timestamp, null media, raw json", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  const receivedAt = 1700000000000;
  store.save(
    base({
      chat: "grp@g.us",
      isGroup: true,
      fromMe: false,
      sender: "999@s.whatsapp.net",
      text: "yo",
      senderEmail: "sender@gmail.com",
      receivedAt,
      raw: { key: { id: "A" } },
    })
  );

  const db = open(file);
  const m = db.prepare("select * from messages").get();
  assert.equal(m.chat_jid, "grp@g.us");
  assert.equal(m.from_me, 0);
  assert.equal(m.sender_jid, "999@s.whatsapp.net", "sender_jid saved");
  assert.equal(m.content, "yo");
  assert.equal(m.sender_email, "sender@gmail.com", "sender_email saved");
  assert.equal(m.timestamp, new Date(receivedAt).toISOString(), "ISO-8601 timestamp");
  assert.equal(m.media, null, "media stays null for text messages");
  assert.equal(m.raw_payload, JSON.stringify({ key: { id: "A" } }));

  const chat = db.prepare("select is_group from chats").get();
  assert.equal(chat.is_group, 1, "group flag stored on the chat row");
  db.close();
  store.close();
});

test("media refs round-trip through the media column into the view url", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  store.save(
    base({
      id: "m1",
      chat: "c@s.whatsapp.net",
      text: null,
      media: { key: "m1", type: "document", mimeType: "application/pdf", fileName: "guide.pdf" },
    })
  );

  const db = open(file);
  const row = db.prepare("select media from messages where id = ?").get("m1");
  assert.deepEqual(JSON.parse(row.media), {
    key: "m1",
    type: "document",
    mimeType: "application/pdf",
    fileName: "guide.pdf",
  });
  db.close();

  const thread = store.getMessages("c@s.whatsapp.net");
  assert.deepEqual(thread.messages[0].media, {
    type: "document",
    mimeType: "application/pdf",
    fileName: "guide.pdf",
    url: "/api/media/m1",
  });
  store.close();
});

test("raw payload survives Buffers (BufferJSON)", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  store.save(
    base({
      raw: {
        key: { id: "A" },
        message: { imageMessage: { url: "x", jpegThumbnail: Buffer.from("abc") } },
      },
    })
  );

  const db = open(file);
  const m = db.prepare("select raw_payload from messages").get();
  const parsed = JSON.parse(m.raw_payload);
  assert.equal(parsed.message.imageMessage.jpegThumbnail.type, "Buffer");
  assert.equal(parsed.message.imageMessage.jpegThumbnail.data, "YWJj");
  assert.equal(parsed.message.imageMessage.url, "x");
  db.close();
  store.close();
});

test("a serialization failure leaves nothing behind", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  const circular = {};
  circular.self = circular;

  assert.throws(() => store.save(base({ raw: circular })), TypeError);

  const db = open(file);
  assert.equal(db.prepare("select count(*) as c from chats").get().c, 0);
  assert.equal(db.prepare("select count(*) as c from messages").get().c, 0);
  db.close();
  store.close();
});

test("a failed insert rolls the whole save back", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });

  // Break the messages table so the message insert throws mid-transaction
  const db = open(file);
  db.exec("drop table messages");

  assert.throws(() => store.save(base()), Error);

  const c = db.prepare("select count(*) as c from chats").get();
  assert.equal(c.c, 0, "chat insert (first in the transaction) must be undone too");
  db.close();
  store.close();
});

test("creates parent directories for the db file", () => {
  const dir = tempDir();
  const file = join(dir, "nested", "deep", "messages.db");
  const store = createSqliteMessageStore({ file });
  store.save(base({ id: "B" }));
  assert.ok(existsSync(file), "the db file exists after first save");
  store.close();
});

test("loadConfig wires a SQLite store when DATABASE_URL is unset", async () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  process.env.LOCAL_DB = file;
  process.env.MEDIA_DIR = join(dir, "media"); // avoid touching ./data/media
  delete process.env.DATABASE_URL;

  try {
    const { loadConfig } = await import("../src/config.js");
    // delete the module cache so the store is re-created for this env
    // (safe: the import above is fresh for this test run)
    const { pool, messageStore, mediaStore } = loadConfig();
    assert.equal(pool, null, "no pg pool without DATABASE_URL");
    assert.ok(messageStore, "a message store is provided without Postgres");
    assert.equal(typeof messageStore.save, "function");
    assert.ok(mediaStore, "a media store is always provided");
    assert.equal(typeof mediaStore.save, "function");

    messageStore.save(
      base({ id: "cfg-1", raw: { key: { id: "cfg-1" } } })
    );
    const db = open(file);
    assert.equal(db.prepare("select count(*) as c from messages").get().c, 1);
    db.close();
    messageStore.close();
  } finally {
    delete process.env.LOCAL_DB;
    delete process.env.MEDIA_DIR;
  }
});

test("listConversations groups chats, names them and counts unread", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  const now = Date.now();
  store.save(
    base({
      id: "a1",
      chat: "15551234567@s.whatsapp.net",
      isGroup: false,
      fromMe: false,
      sender: "15551234567@s.whatsapp.net",
      text: "hi",
      receivedAt: now - 60_000,
      raw: { key: { id: "a1" }, pushName: "Ada Okafor" },
    })
  );
  store.save(
    base({
      id: "a2",
      chat: "15551234567@s.whatsapp.net",
      isGroup: false,
      fromMe: true,
      sender: null,
      text: "hey",
      receivedAt: now - 30_000,
      raw: { key: { id: "a2" } },
    })
  );
  store.save(
    base({
      id: "g1",
      chat: "grp@g.us",
      isGroup: true,
      fromMe: false,
      sender: "1@s.whatsapp.net",
      text: "home?",
      receivedAt: now - 10_000,
      raw: { key: { id: "g1" }, pushName: "Tunde" },
    })
  );

  const list = store.listConversations();
  assert.equal(list.length, 2);
  assert.equal(list[0].jid, "grp@g.us", "most recent first");
  assert.equal(list[0].isGroup, true);
  assert.equal(list[0].name, "Group");
  assert.equal(list[0].unread, 1);
  assert.equal(Object.hasOwn(list[0], "messages"), false, "list is lightweight: no embedded thread");
  assert.equal(list[0].lastMessage.sender, "Tunde", "group sender from raw pushName");
  assert.equal(list[0].lastMessage.time, new Date(now - 10_000).toISOString());

  assert.equal(list[1].jid, "15551234567@s.whatsapp.net");
  assert.equal(list[1].name, "Ada Okafor", "1:1 name from raw pushName");
  assert.equal(list[1].isGroup, false);
  assert.equal(list[1].unread, 1, "one incoming after readAt=null");
  assert.equal(list[1].flagged, false);
  assert.equal(Object.hasOwn(list[1].lastMessage, "sender"), false, "1:1 rows have no sender");
  store.close();
});

test("markRead and setFlagged update the conversation", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  store.save(
    base({
      id: "m1",
      chat: "c@s.whatsapp.net",
      fromMe: false,
      sender: "c@s.whatsapp.net",
      text: "hi",
      receivedAt: Date.now() - 5_000,
      raw: { key: { id: "m1" }, pushName: "Cara" },
    })
  );
  assert.equal(store.listConversations()[0].unread, 1);

  store.markRead("c@s.whatsapp.net");
  assert.equal(store.listConversations()[0].unread, 0, "read clears the badge");

  assert.equal(store.listConversations()[0].flagged, false);
  store.setFlagged("c@s.whatsapp.net", true);
  assert.equal(store.listConversations()[0].flagged, true, "flag persists");
  store.setFlagged("c@s.whatsapp.net", false);
  assert.equal(store.listConversations()[0].flagged, false, "flag can be cleared");
  store.close();
});

test("getMessages returns an ascending thread or null", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  store.save(
    base({ id: "m1", chat: "z@s.whatsapp.net", text: "first", receivedAt: 1000 })
  );
  store.save(
    base({ id: "m2", chat: "z@s.whatsapp.net", text: "second", receivedAt: 2000 })
  );

  const thread = store.getMessages("z@s.whatsapp.net");
  assert.equal(thread.jid, "z@s.whatsapp.net");
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.messages[0].id, "m1");
  assert.equal(thread.messages[1].id, "m2");
  // An unknown-but-valid JID degrades to an empty thread so a new chat can be
  // started; a malformed id (no @domain) is still "not found".
  const empty = store.getMessages("nope@s.whatsapp.net");
  assert.equal(empty.jid, "nope@s.whatsapp.net");
  assert.deepEqual(empty.messages, []);
  assert.equal(store.getMessages("nope"), null);
  store.close();
});

test("getMessages pages through a thread with keyset cursors", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  const now = 1_700_000_000_000;
  for (let i = 0; i < 5; i++) {
    store.save(
      base({
        id: `m${i}`,
        chat: "p@s.whatsapp.net",
        fromMe: false,
        sender: "p@s.whatsapp.net",
        text: `t${i}`,
        receivedAt: now + i * 1000,
        raw: { key: { id: `m${i}` } },
      })
    );
  }

  const full = store.getMessages("p@s.whatsapp.net");
  assert.deepEqual(full.messages.map((m) => m.id), ["m0", "m1", "m2", "m3", "m4"], "no limit = full thread");

  const p1 = store.getMessages("p@s.whatsapp.net", { limit: 2 });
  assert.equal(p1.hasMore, true, "older rows exist past the newest page");
  assert.deepEqual(p1.conversation.messages.map((m) => m.id), ["m3", "m4"], "page is the newest, ascending");
  assert.equal(p1.conversation.id, "p@s.whatsapp.net");
  assert.equal(p1.conversation.jid, "p@s.whatsapp.net");
  assert.ok(p1.nextBefore, "cursor while older rows exist");

  const p2 = store.getMessages("p@s.whatsapp.net", { limit: 2, before: decodeCursor(p1.nextBefore) });
  assert.deepEqual(p2.conversation.messages.map((m) => m.id), ["m1", "m2"]);
  assert.equal(p2.hasMore, true);

  const p3 = store.getMessages("p@s.whatsapp.net", { limit: 2, before: decodeCursor(p2.nextBefore) });
  assert.deepEqual(p3.conversation.messages.map((m) => m.id), ["m0"], "oldest page");
  assert.equal(p3.hasMore, false);
  assert.equal(p3.nextBefore, null, "no more rows -> null cursor");

  const union = [...p1.conversation.messages, ...p2.conversation.messages, ...p3.conversation.messages].map((m) => m.id);
  const order = new Map(store.getMessages("p@s.whatsapp.net").messages.map((m, i) => [m.id, i]));
  assert.deepEqual(
    [...union].sort((a, b) => order.get(a) - order.get(b)),
    ["m0", "m1", "m2", "m3", "m4"],
    "pages tile the whole thread (same set, no gaps, no overlaps)"
  );

  const emptyPage = store.getMessages("nope@s.whatsapp.net", { limit: 2 });
  assert.deepEqual(emptyPage.conversation.messages, [], "unknown chat with limit -> empty page");
  assert.equal(emptyPage.hasMore, false);
  assert.equal(emptyPage.nextBefore, null);
  assert.equal(store.getMessages("nope", { limit: 2 }), null, "malformed id with limit -> null");
  store.close();
});

test("migrates existing sqlite files with the read_at/flagged columns", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");

  // Create an "old" database without the new columns
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    create table chats (jid text primary key, name text, is_group integer not null default 0, updated_at text not null default (datetime('now')));
    create table messages (
      id text primary key, chat_jid text references chats(jid), from_me integer not null,
      sender_jid text, content text, media_url text, sender_email text, timestamp text,
      raw_payload text
    );
  `);
  legacy.close();

  const store = createSqliteMessageStore({ file });
  store.save(base({ id: "old1", chat: "c@s.whatsapp.net", fromMe: false, sender: "c@s.whatsapp.net", text: "hi", raw: { key: { id: "old1" } } }));
  store.markRead("c@s.whatsapp.net");
  store.setFlagged("c@s.whatsapp.net", true);

  const db = open(file);
  const cols = db.prepare("pragma table_info(chats)").all().map((c) => c.name);
  assert.ok(cols.includes("read_at") && cols.includes("flagged"), "columns added");
  const messageCols = db.prepare("pragma table_info(messages)").all().map((c) => c.name);
  assert.ok(messageCols.includes("media"), "media column added to existing databases");
  const templateCols = db.prepare("pragma table_info(templates)").all().map((c) => c.name);
  assert.ok(templateCols.includes("title"), "templates table added to existing databases");
  const chat = db.prepare("select flagged from chats where jid = ?").get("c@s.whatsapp.net");
  assert.equal(chat.flagged, 1);
  db.close();
  store.close();
});

test("templates: save/list/get round-trip with media refs (newest first)", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });

  const first = store.saveTemplate({ id: "t1", title: "Welcome", body: "Hi!" });
  assert.equal(first.id, "t1");
  assert.equal(first.title, "Welcome");
  assert.equal(first.body, "Hi!");
  assert.equal(first.media, null);
  assert.ok(first.createdAt, "createdAt is stamped");

  const withMedia = store.saveTemplate({
    id: "t2",
    title: "Pic",
    body: "",
    media: { key: "k2", type: "image", mimeType: "image/png", fileName: null },
  });
  assert.equal(withMedia.body, "", "media-only template keeps an empty body");
  assert.deepEqual(withMedia.media, {
    type: "image",
    mimeType: "image/png",
    fileName: null,
    url: "/api/media/k2",
  });

  // Raw storage keeps the media ref (with the key) for the media route.
  const db = open(file);
  const row = db.prepare("select media from templates where id = ?").get("t2");
  assert.deepEqual(JSON.parse(row.media), {
    key: "k2",
    type: "image",
    mimeType: "image/png",
    fileName: null,
  });
  db.close();

  assert.deepEqual(
    store.listTemplates().map((t) => t.id),
    ["t2", "t1"],
    "newest first"
  );
  assert.deepEqual(store.getTemplate("t1"), first);
  assert.equal(store.getTemplate("missing"), null);

  // A missing id gets a generated one.
  const auto = store.saveTemplate({ title: "Auto", body: "x" });
  assert.ok(auto.id && auto.id !== "t1");

  // saveTemplate upserts on an existing id, keeping the original createdAt.
  const again = store.saveTemplate({ id: "t1", title: "Welcome v2", body: "Hi again" });
  assert.equal(again.title, "Welcome v2");
  assert.equal(again.body, "Hi again");
  assert.equal(again.createdAt, first.createdAt, "createdAt is preserved on conflict");
  assert.deepEqual(
    store.listTemplates().filter((t) => t.id === "t1").length,
    1,
    "no duplicate row"
  );

  store.close();
});

test("templates: updateTemplate keeps, replaces and clears the attachment", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });

  const original = store.saveTemplate({
    id: "t1",
    title: "Pic",
    body: "cap",
    media: { key: "k1", type: "image", mimeType: "image/png", fileName: null },
  });

  // media omitted (undefined) -> keep
  const kept = store.updateTemplate("t1", { title: "Renamed", body: "new cap" });
  assert.equal(kept.title, "Renamed");
  assert.equal(kept.body, "new cap");
  assert.deepEqual(kept.media, {
    type: "image",
    mimeType: "image/png",
    fileName: null,
    url: "/api/media/k1",
  });
  assert.equal(kept.createdAt, original.createdAt, "createdAt survives updates");

  // media null -> clear
  assert.equal(store.updateTemplate("t1", { title: "Renamed", body: "new cap", media: null }).media, null);

  // media ref -> replace
  const replaced = store.updateTemplate("t1", {
    title: "Renamed",
    body: "new cap",
    media: { key: "k2", type: "video", mimeType: "video/mp4", fileName: null },
  });
  assert.equal(replaced.media.url, "/api/media/k2");
  assert.equal(replaced.media.type, "video");

  assert.equal(store.updateTemplate("missing", { title: "x", body: "y" }), null);

  store.close();
});

test("templates: deleteTemplate reports whether a row was removed", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });
  store.saveTemplate({ id: "t1", title: "A", body: "a" });

  assert.equal(store.deleteTemplate("t1"), true);
  assert.equal(store.getTemplate("t1"), null);
  assert.equal(store.deleteTemplate("t1"), false, "deleting twice is a no-op");

  store.close();
});

/* ------------------------------------------------------------------ */
/*  Contacts + broadcast lists                                         */
/* ------------------------------------------------------------------ */

test("contacts: create/get/update/delete with canonical phones", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });

  const ada = store.createContact({ name: "  Ada Lovelace  ", phone: "+234 814 685 8279" });
  assert.equal(ada.phone, "+2348146858279", "phone canonicalized to +<digits>");
  assert.equal(ada.name, "Ada Lovelace", "name trimmed");
  assert.ok(ada.id && ada.createdAt);

  // The same number in another format collides with the unique index.
  assert.throws(() => store.createContact({ name: "Ada again", phone: "234-814-685-8279" }), Error);

  // Invalid numbers (too few / too many digits, or no digits) are rejected.
  assert.throws(() => store.createContact({ name: "x", phone: "12345" }), Error);
  assert.throws(() => store.createContact({ name: "x", phone: "1234567890123456" }), Error);
  assert.throws(() => store.createContact({ name: "x", phone: "bad" }), Error);

  assert.equal(store.getContactByPhone("+2348146858279").id, ada.id);
  assert.equal(store.getContactByPhone("+10000000000"), null);

  const updated = store.updateContact(ada.id, { name: "Ada L", phone: "2348146858279" });
  assert.equal(updated.name, "Ada L");
  assert.equal(updated.phone, "+2348146858279");

  // name is optional and defaults to "".
  assert.equal(store.createContact({ phone: "08031234567" }).name, "");

  assert.equal(store.updateContact("missing", { name: "x", phone: "08031234567" }), null);
  assert.equal(store.deleteContact(ada.id), true);
  assert.equal(store.getContact(ada.id), null);
  assert.equal(store.deleteContact(ada.id), false, "deleting twice is a no-op");

  store.close();
});

test("contacts: deleteContacts bulk-removes memberships and keeps lists", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });

  const a = store.createContact({ name: "A", phone: "2348011111111" });
  const b = store.createContact({ name: "B", phone: "2348022222222" });
  const c = store.createContact({ name: "C", phone: "2348033333333" });
  const list = store.createList({ name: "L", contactIds: [a.id, b.id, c.id] });
  assert.equal(store.getList(list.id).memberCount, 3);

  // Unknown + repeated ids are ignored; only the real ones count.
  assert.equal(store.deleteContacts([a.id, b.id, a.id, "ghost"]), 2, "counts only contacts that existed");
  assert.equal(store.deleteContacts(["ghost"]), 0, "unknown ids delete nothing");
  assert.equal(store.deleteContacts([]), 0, "an empty list is a no-op");

  assert.equal(store.getContact(a.id), null);
  assert.equal(store.getContact(b.id), null);
  assert.ok(store.getContact(c.id), "C survives");
  assert.deepEqual(store.getList(list.id).contactIds, [c.id]);
  assert.equal(store.listLists().length, 1, "the list survives a bulk deletion");

  store.close();
});

test("contacts: listContacts honors q across name and phone", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });
  store.createContact({ name: "Ada Lovelace", phone: "2348146858279" });
  store.createContact({ name: "Grace Hopper", phone: "15551234567" });

  assert.equal(store.listContacts().length, 2);
  assert.deepEqual(store.listContacts("ada").map((c) => c.name), ["Ada Lovelace"]);
  assert.deepEqual(store.listContacts("GRACE").map((c) => c.name), ["Grace Hopper"], "case-insensitive");
  assert.deepEqual(store.listContacts("1555").map((c) => c.name), ["Grace Hopper"], "matches a phone substring");
  assert.equal(store.listContacts("zzz").length, 0);
  assert.equal(store.listContacts("  ").length, 2, "blank q returns everyone");

  store.close();
});

test("contacts: importContacts reports imported and skipped", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });
  store.createContact({ name: "Existing", phone: "15550000000" });

  const result = store.importContacts([
    { name: "A", phone: "2348011111111" },
    { name: "B", phone: "+234-802-222-2222" },
    { name: "dup in batch", phone: "2348011111111" },
    { name: "already there", phone: "15550000000" },
    { name: "broken", phone: "bad" },
    { phone: "08033333333" },
  ]);

  assert.equal(result.imported, 3, "A, B and the nameless valid row");
  const byReason = (a, b) => a.phone.localeCompare(b.phone);
  assert.deepEqual(
    [...result.skipped].sort(byReason),
    [
      { phone: "+2348011111111", reason: "already exists" },
      { phone: "+15550000000", reason: "already exists" },
      { phone: "bad", reason: "invalid number" },
    ].sort(byReason)
  );
  assert.equal(store.listContacts().length, 4, "the existing contact + 3 imported");

  store.close();
});

test("lists: create/get/list/update/delete with memberCount and contactIds", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });

  const a = store.createContact({ name: "A", phone: "2348011111111" });
  const b = store.createContact({ name: "B", phone: "2348022222222" });
  const c = store.createContact({ name: "C", phone: "2348033333333" });

  const list = store.createList({ name: "  Automotive Leads ", description: "warm", contactIds: [a.id, b.id] });
  assert.equal(list.name, "Automotive Leads", "name trimmed");
  assert.equal(list.description, "warm");
  assert.equal(list.memberCount, 2);
  assert.equal(Object.hasOwn(list, "contactIds"), false, "list view omits contactIds");

  const detail = store.getList(list.id);
  assert.deepEqual([...detail.contactIds].sort(), [a.id, b.id].sort());
  assert.equal(detail.memberCount, 2);

  // Unknown ids are dropped, duplicates collapsed; contactIds replaces membership.
  const updated = store.updateList(list.id, {
    name: "Leads",
    description: "",
    contactIds: [b.id, "ghost", c.id, c.id],
  });
  assert.equal(updated.name, "Leads");
  assert.equal(updated.memberCount, 2, "only b and c remain");
  assert.deepEqual([...store.getList(list.id).contactIds].sort(), [b.id, c.id].sort());

  // contactIds omitted -> membership untouched.
  const renamed = store.updateList(list.id, { name: "Leads v2", description: "x" });
  assert.equal(renamed.name, "Leads v2");
  assert.equal(renamed.memberCount, 2, "membership kept when contactIds is absent");

  // contactIds present but empty -> clears membership.
  assert.equal(store.updateList(list.id, { name: "Leads v3", contactIds: [] }).memberCount, 0);

  assert.equal(store.updateList("missing", { name: "x" }), null);

  assert.equal(store.deleteList(list.id), true);
  assert.equal(store.getList(list.id), null);
  assert.equal(store.deleteList(list.id), false, "deleting twice is a no-op");

  store.close();
});

test("lists: deleting a contact drops memberships but keeps lists (and vice versa)", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });
  const a = store.createContact({ name: "A", phone: "2348011111111" });
  const b = store.createContact({ name: "B", phone: "2348022222222" });
  const list = store.createList({ name: "L", contactIds: [a.id, b.id] });
  assert.equal(store.getList(list.id).memberCount, 2);

  // Deleting a contact removes it from lists but keeps the list + other members.
  assert.equal(store.deleteContact(a.id), true);
  assert.equal(store.getList(list.id).memberCount, 1);
  assert.deepEqual(store.getList(list.id).contactIds, [b.id]);
  assert.equal(store.listLists().length, 1, "the list survives");

  // Deleting a list keeps its contacts.
  assert.equal(store.deleteList(list.id), true);
  assert.equal(store.listContacts().length, 1, "contact B is kept");
  assert.equal(store.getContact(b.id).id, b.id);

  store.close();
});

test("lists: listLists returns newest first", async () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });
  const first = store.createList({ name: "First" });
  await new Promise((r) => setTimeout(r, 5));
  const second = store.createList({ name: "Second" });

  assert.deepEqual(store.listLists().map((l) => l.id), [second.id, first.id]);
  store.close();
});

test("lists: listListsForContact returns only the lists containing the contact, newest first", async () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });
  const a = store.createContact({ name: "A", phone: "2348011111111" });
  const b = store.createContact({ name: "B", phone: "2348022222222" });

  store.createList({ name: "First", contactIds: [a.id] });
  await new Promise((r) => setTimeout(r, 5));
  store.createList({ name: "Second", contactIds: [a.id, b.id] });
  await new Promise((r) => setTimeout(r, 5));
  store.createList({ name: "Other", contactIds: [b.id] });

  const lists = store.listListsForContact(a.id);
  assert.deepEqual(lists.map((l) => l.name), ["Second", "First"], "newest first");
  assert.deepEqual(lists.map((l) => l.memberCount), [2, 1], "memberCount per list");
  assert.equal(Object.hasOwn(lists[0], "contactIds"), false, "list view omits contactIds");
  assert.equal(store.listListsForContact(b.id).length, 2, "B is in Second + Other");
  assert.deepEqual(store.listListsForContact("ghost"), [], "unknown contact has no lists");

  store.close();
});

test("templates: fallbackName round-trips, defaults to empty and survives partial updates", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });

  const plain = store.saveTemplate({ id: "t1", title: "Plain", body: "hi" });
  assert.equal(plain.fallbackName, "", "fallbackName defaults to empty");

  const named = store.saveTemplate({ id: "t2", title: "Named", body: "hi", fallbackName: "Friend" });
  assert.equal(named.fallbackName, "Friend");
  assert.equal(store.getTemplate("t2").fallbackName, "Friend");
  assert.equal(store.listTemplates().find((t) => t.id === "t2").fallbackName, "Friend");

  // updateTemplate with fallbackName sets it...
  assert.equal(store.updateTemplate("t1", { title: "Plain", body: "hi", fallbackName: "Pal" }).fallbackName, "Pal");
  // ...and omitting it keeps the current value.
  assert.equal(store.updateTemplate("t1", { title: "Plain v2", body: "hi" }).fallbackName, "Pal");
  // ...while an explicit "" clears it.
  assert.equal(store.updateTemplate("t1", { title: "Plain v3", body: "hi", fallbackName: "" }).fallbackName, "");

  store.close();
});

test("templates: migrates an existing table without a fallback_name column", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  // Simulate a pre-broadcast database: a templates table without fallback_name.
  const legacy = open(file);
  legacy.exec(`
    create table templates (
      id         text primary key,
      title      text not null,
      body       text,
      media      text,
      created_at text not null default (datetime('now')),
      updated_at text not null default (datetime('now'))
    );
    insert into templates (id, title, body) values ('t1', 'Old', 'hi');
  `);
  legacy.close();

  const store = createSqliteMessageStore({ file });
  const row = store.getTemplate("t1");
  assert.ok(row, "existing template survives");
  assert.equal(row.title, "Old");
  assert.equal(row.fallbackName, "", "the missing column reads as empty");
  // The migrated column is writable.
  assert.equal(store.updateTemplate("t1", { title: "Old", body: "hi", fallbackName: "X" }).fallbackName, "X");
  store.close();
});

test("automation: migrates existing rules/away tables without a quote column", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  // Simulate a pre-quote automation schema: the tables exist without `quote`.
  const legacy = open(file);
  legacy.exec(`
    create table auto_reply_rules (
      id          text    primary key,
      keyword     text    not null,
      match_type  text    not null default 'contains',
      template_id text,
      enabled     integer not null default 1,
      dm          integer not null default 1,
      created_at  text    not null default (datetime('now')),
      updated_at  text    not null default (datetime('now'))
    );
    create table away_settings (
      id               integer primary key check (id = 1),
      enabled          integer not null default 0,
      start_time       text    not null default '22:00',
      end_time         text    not null default '07:00',
      template_id      text,
      once_per_contact integer not null default 1,
      time_zone        text    not null default '',
      updated_at       text    not null default (datetime('now'))
    );
    insert into auto_reply_rules (id, keyword, template_id) values ('r1', 'OLD', 't1');
    insert into away_settings (id, start_time, end_time) values (1, '22:00', '07:00');
  `);
  legacy.close();

  const store = createSqliteMessageStore({ file });

  const db = open(file);
  const ruleCols = db.prepare("pragma table_info(auto_reply_rules)").all().map((c) => c.name);
  const awayCols = db.prepare("pragma table_info(away_settings)").all().map((c) => c.name);
  db.close();
  assert.ok(ruleCols.includes("quote"), "auto_reply_rules.quote added");
  assert.ok(awayCols.includes("quote"), "away_settings.quote added");

  // Existing rows read with the default (true) and the column is writable.
  assert.equal(store.getAutoReply("r1").quote, true, "existing rule defaults to quoting");
  assert.equal(store.updateAutoReply("r1", { quote: false }).quote, false);
  assert.equal(store.getAwaySettings().quote, true, "existing away row defaults to quoting");
  assert.equal(store.saveAwaySettings({ quote: false }).quote, false);

  store.close();
});

test("broadcasts: createBroadcast persists the row and deduped recipients", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });

  const broadcast = store.createBroadcast({
    id: "b1",
    templateId: "t1",
    templateTitle: "Welcome",
    listIds: ["l1", "l2"],
    senderEmail: "ops@example.com",
    minDelay: 2,
    maxDelay: 5,
    sendAt: null,
    status: "sending",
    startedAt: "2026-01-01T00:00:00.000Z",
    recipients: [
      { phone: "+2348011111111", name: "Ada Lovelace" },
      { phone: "+2348011111111", name: "duplicate phone dropped" },
      { phone: "+2348022222222", name: "" },
    ],
  });

  assert.equal(broadcast.id, "b1");
  assert.equal(broadcast.templateId, "t1");
  assert.equal(broadcast.templateTitle, "Welcome");
  assert.deepEqual(broadcast.listIds, ["l1", "l2"], "listIds round-trips as an array");
  assert.equal(broadcast.senderEmail, "ops@example.com");
  assert.equal(broadcast.minDelay, 2);
  assert.equal(broadcast.maxDelay, 5);
  assert.equal(broadcast.sendAt, null);
  assert.equal(broadcast.status, "sending");
  assert.equal(broadcast.total, 2, "recipients deduped by phone");
  assert.equal(broadcast.sent, 0);
  assert.equal(broadcast.failed, 0);
  assert.ok(broadcast.createdAt);
  assert.equal(broadcast.startedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(broadcast.finishedAt, null);
  assert.equal(broadcast.error, null);

  const recipients = store.listBroadcastRecipients("b1");
  assert.deepEqual(recipients.map((r) => r.phone), ["+2348011111111", "+2348022222222"], "ordered by phone");
  assert.equal(recipients[0].name, "Ada Lovelace", "first name wins on dedupe");
  assert.equal(recipients[1].name, "");
  assert.ok(recipients.every((r) => r.status === "pending" && r.sentAt === null && r.error === null));

  assert.deepEqual(store.getBroadcast("b1"), broadcast);
  assert.deepEqual(store.listBroadcasts().map((b) => b.id), ["b1"]);
  assert.equal(store.getBroadcast("missing"), null);
  assert.equal(store.updateBroadcast("missing", { status: "done" }), null);
  assert.deepEqual(store.listBroadcastRecipients("missing"), []);

  store.close();
});

test("broadcasts: markBroadcastRecipient and updateBroadcast patch rows", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });
  store.createBroadcast({
    id: "b1",
    templateId: "t1",
    status: "sending",
    recipients: [{ phone: "+2348011111111", name: "A" }],
  });

  const marked = store.markBroadcastRecipient("b1", "+2348011111111", {
    status: "sent",
    jid: "2348011111111@s.whatsapp.net",
    sentAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(marked, true);
  const [recipient] = store.listBroadcastRecipients("b1");
  assert.equal(recipient.status, "sent");
  assert.equal(recipient.sentAt, "2026-01-01T00:00:00.000Z");
  assert.equal(store.markBroadcastRecipient("b1", "ghost", { status: "sent" }), false);

  const updated = store.updateBroadcast("b1", {
    status: "done",
    sent: 1,
    failed: 0,
    finishedAt: "2026-01-01T00:00:05.000Z",
    error: null,
  });
  assert.equal(updated.status, "done");
  assert.equal(updated.sent, 1);
  assert.equal(updated.finishedAt, "2026-01-01T00:00:05.000Z");

  store.close();
});

test("broadcasts: claimDueBroadcasts claims only due scheduled rows, once", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });

  store.createBroadcast({ id: "past", templateId: "t1", status: "scheduled", sendAt: "2026-01-01T00:00:00.000Z", recipients: [] });
  store.createBroadcast({ id: "future", templateId: "t1", status: "scheduled", sendAt: "2027-01-01T00:00:00.000Z", recipients: [] });
  store.createBroadcast({ id: "immediate", templateId: "t1", status: "sending", recipients: [] });

  const claimed = store.claimDueBroadcasts("2026-06-01T00:00:00.000Z");
  assert.deepEqual(claimed.map((b) => b.id), ["past"]);
  assert.equal(claimed[0].status, "sending");
  assert.ok(claimed[0].startedAt);

  assert.deepEqual(store.claimDueBroadcasts("2026-06-01T00:00:00.000Z"), [], "a claimed row isn't claimed twice");
  assert.equal(store.getBroadcast("future").status, "scheduled", "a future row stays scheduled");
  assert.deepEqual(store.listInterruptedBroadcasts().map((b) => b.id).sort(), ["immediate", "past"]);

  store.close();
});

test("broadcasts: listBroadcasts returns newest first", async () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });
  store.createBroadcast({ id: "b1", templateId: "t1", recipients: [] });
  await new Promise((r) => setTimeout(r, 5));
  store.createBroadcast({ id: "b2", templateId: "t1", recipients: [] });

  assert.deepEqual(store.listBroadcasts().map((b) => b.id), ["b2", "b1"]);
  store.close();
});

/* ------------------------------------------------------------------ */
/*  Identity: one chat per person (LID <-> phone number)               */
/* ------------------------------------------------------------------ */

const LID = "225159969521788@lid";
const PN = "2348052928072@s.whatsapp.net";

test("identities: canonicalizeChat moves messages and merges chat metadata", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });

  // Same person, split across the LID and PN forms.
  store.save(
    base({
      id: "in-1",
      chat: LID,
      fromMe: false,
      sender: LID,
      text: "hello",
      raw: { key: { id: "in-1", remoteJid: LID, remoteJidAlt: PN }, pushName: "Ada" },
    })
  );
  store.save(
    base({
      id: "out-1",
      chat: PN,
      fromMe: true,
      sender: PN,
      text: "hi back",
      raw: { key: { id: "out-1", remoteJid: PN, fromMe: true } },
    })
  );
  store.setChatName(PN, "Ada Lovelace", "ada");
  store.markRead(LID);

  const canonical = store.canonicalizeChat(PN, LID);
  assert.equal(canonical, LID);

  const list = store.listConversations();
  assert.equal(list.length, 1, "the two chats are now one");
  assert.equal(list[0].jid, LID, "the LID is the surviving chat");
  assert.equal(list[0].name, "Ada Lovelace", "name synced on the alias was merged");
  assert.deepEqual(
    store.getMessages(LID).messages.map((m) => m.text),
    ["hello", "hi back"],
    "messages from both forms share one thread"
  );

  store.close();
});

test("identities: resolveChatJid maps either form to the canonical id", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });
  store.save(
    base({
      id: "m",
      chat: LID,
      fromMe: false,
      sender: LID,
      raw: { key: { id: "m", remoteJid: LID, remoteJidAlt: PN } },
    })
  );
  store.canonicalizeChat(PN, LID);

  assert.equal(store.resolveChatJid(PN), LID);
  assert.equal(store.resolveChatJid(LID), LID);
  assert.equal(store.resolveChatJid("999@s.whatsapp.net"), "999@s.whatsapp.net", "unknown ids pass through");

  const db = open(file);
  const alias = db.prepare("select alias_jid, canonical_jid from chat_aliases").all();
  assert.deepEqual(
    alias.map((a) => [a.alias_jid, a.canonical_jid]),
    [[PN, LID]],
    "the phone-number form is recorded as an alias of the LID"
  );
  db.close();
  store.close();
});

test("identities: setChatName never wipes a name with an empty update", () => {
  const dir = tempDir();
  const store = createSqliteMessageStore({ file: join(dir, "messages.db") });
  store.save(base({ id: "m", chat: PN, raw: { key: { id: "m", remoteJid: PN } } }));

  store.setChatName(PN, "Saved Name", "saveduser");
  store.setChatName(PN, "", ""); // a sync with no name must not clear it
  assert.equal(store.listConversations()[0].name, "Saved Name");

  store.close();
});

test("identities: setChatName flags group chats and resolveChatName reads names", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");
  const store = createSqliteMessageStore({ file });

  store.setChatName("123-456@g.us", "Family");
  store.setChatName(PN, "Ada Lovelace", "ada");

  assert.equal(store.resolveChatName("123-456@g.us"), "Family");
  assert.equal(store.resolveChatName(PN), "Ada Lovelace");
  assert.equal(store.resolveChatName("unknown@s.whatsapp.net"), null, "unknown jids are null");

  // The chat rows carry the right group flags (groups are never 1:1).
  const db = open(file);
  const type = (jid) => db.prepare("select is_group from chats where jid = ?").get(jid).is_group;
  assert.equal(type("123-456@g.us"), 1, "group jids are flagged as groups");
  assert.equal(type(PN), 0, "1:1 chats stay unflagged");
  db.close();

  store.close();
});

test("identities: existing split chats are merged on open (backfill)", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");

  // Seed a legacy database the old way: no alias table / no canonicalization.
  const seed = createSqliteMessageStore({ file });
  seed.save(
    base({
      id: "legacy-lid",
      chat: LID,
      fromMe: false,
      sender: LID,
      text: "old incoming",
      raw: { key: { id: "legacy-lid", remoteJid: LID, remoteJidAlt: PN }, pushName: "Ada" },
    })
  );
  seed.save(
    base({
      id: "legacy-pn",
      chat: PN,
      fromMe: true,
      sender: PN,
      text: "old outgoing",
      raw: { key: { id: "legacy-pn", remoteJid: PN, fromMe: true } },
    })
  );
  seed.close();

  // Reopen: the backfill reads the stored raw payloads and heals the split.
  const store = createSqliteMessageStore({ file });
  const list = store.listConversations();
  assert.equal(list.length, 1);
  assert.equal(list[0].jid, LID);
  assert.deepEqual(
    store.getMessages(LID).messages.map((m) => m.text),
    ["old incoming", "old outgoing"]
  );
  assert.equal(store.resolveChatJid(PN), LID, "the old PN id still resolves");

  // Idempotent: reopening again changes nothing.
  store.close();
  const again = createSqliteMessageStore({ file });
  assert.equal(again.listConversations().length, 1);
  again.close();
});

test("identities: migrates an existing chats table without a username column", () => {
  const dir = tempDir();
  const file = join(dir, "messages.db");

  // Build a pre-identity schema by hand, then let the store migrate it.
  const db = open(file);
  db.exec(`
    create table chats (
      jid text primary key, name text, is_group integer not null default 0,
      updated_at text not null default (datetime('now')), read_at text,
      flagged integer not null default 0
    );
    create table messages (
      id text primary key, chat_jid text references chats(jid), from_me integer not null,
      sender_jid text, content text, media text, sender_email text,
      timestamp text default (datetime('now')), raw_payload text
    );
  `);
  db.close();

  const store = createSqliteMessageStore({ file });
  store.save(base({ id: "m", chat: PN, raw: { key: { id: "m", remoteJid: PN } } }));
  const migrated = open(file);
  const columns = migrated.prepare("pragma table_info(chats)").all().map((c) => c.name);
  assert.ok(columns.includes("username"), "username column added");
  const tables = migrated.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
  assert.ok(tables.includes("chat_aliases"), "alias table added");
  migrated.close();
  store.close();
});
