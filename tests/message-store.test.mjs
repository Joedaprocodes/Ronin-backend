import { test } from "node:test";
import assert from "node:assert/strict";

const { createPostgresMessageStore } = await import("../src/db/messages.js");
const { decodeCursor } = await import("../src/db/inbox.js");

function makePool(failOnMessageInsert = false) {
  const calls = [];
  const transactions = [];
  const client = {
    query: async (text, params) => {
      const t = text.trim();
      calls.push({ text: t, params });
      if (t === "begin" || t === "commit" || t === "rollback") transactions.push(t);
      if (failOnMessageInsert && t.startsWith("insert into \"public\".\"messages\"")) {
        throw new Error("insert boom");
      }
      return { rows: [] };
    },
    release: () => {
      client.released = true;
    },
  };
  return {
    query: async (text) => {
      calls.push({ text: text.trim() });
      return { rows: [] };
    },
    connect: async () => client,
    client,
    calls,
    transactions,
  };
}

test("store creates schema on first save", async () => {
  const pool = makePool();
  const store = createPostgresMessageStore({ pool });
  await store.save({
    id: "A",
    chat: "123@s.whatsapp.net",
    isGroup: false,
    fromMe: false,
    sender: "123@s.whatsapp.net",
    text: "hi",
    receivedAt: Date.now(),
    raw: { key: { id: "A" }, message: { conversation: "hi" } },
  });
  const ddl = pool.calls[0].text;
  assert.ok(ddl.includes("create table if not exists \"public\".\"chats\""), "chats DDL");
  assert.ok(ddl.includes("create table if not exists \"public\".\"messages\""), "messages DDL");
  assert.ok(ddl.includes("create table if not exists \"public\".\"templates\""), "templates DDL");
  assert.ok(ddl.includes("sender_email text"), "sender_email column");
  assert.ok(ddl.includes("add column if not exists sender_email"), "migration for existing tables");
  assert.ok(ddl.includes("media jsonb"), "media column");
  assert.ok(ddl.includes("add column if not exists media jsonb"), "media column migration");
  assert.ok(ddl.includes("quoted jsonb"), "quoted column");
  assert.ok(ddl.includes("add column if not exists quoted jsonb"), "quoted column migration");
  assert.ok(ddl.includes("reactions jsonb"), "reactions column");
  assert.ok(ddl.includes("add column if not exists reactions jsonb"), "reactions column migration");
  assert.ok(ddl.includes("edits jsonb"), "edits column");
  assert.ok(ddl.includes("add column if not exists edits jsonb"), "edits column migration");
  assert.ok(ddl.includes("references \"public\".\"chats\"(jid)"), "FK to chats");
  assert.ok(ddl.includes("create index if not exists idx_messages_chat_time"), "chat time index");
  assert.ok(ddl.includes("create index if not exists idx_messages_from_me"), "from_me index");
  assert.ok(ddl.includes("create table if not exists \"public\".\"contacts\""), "contacts DDL");
  assert.ok(ddl.includes("create unique index if not exists idx_contacts_phone"), "unique phone index");
  assert.ok(ddl.includes("create table if not exists \"public\".\"lists\""), "lists DDL");
  assert.ok(ddl.includes("create table if not exists \"public\".\"list_contacts\""), "list_contacts DDL");
  assert.ok(ddl.includes("on delete cascade"), "membership FKs cascade");
});

test("chat upsert runs before message insert, inside a transaction", async () => {
  const pool = makePool();
  const store = createPostgresMessageStore({ pool });
  await store.save({
    id: "A",
    chat: "123@s.whatsapp.net",
    isGroup: false,
    fromMe: true,
    sender: null,
    text: "hi",
    receivedAt: 123,
    raw: { key: { id: "A" }, message: { conversation: "hi" } },
  });

  const list = pool.calls.map((c) => c.text);
  const chatIdx = list.findIndex((t) => t.startsWith("insert into \"public\".\"chats\""));
  const msgIdx = list.findIndex((t) => t.startsWith("insert into \"public\".\"messages\""));
  assert.ok(chatIdx > -1 && msgIdx > -1, "both inserts present");
  assert.ok(chatIdx < msgIdx, "chat row must exist before message row");
  assert.deepEqual(pool.transactions, ["begin", "commit"], "save must begin and commit");
  assert.equal(pool.client.released, true, "client must be released");
});

test("raw payload jsonb survives Buffers (BufferJSON)", async () => {
  const pool = makePool();
  const store = createPostgresMessageStore({ pool });
  await store.save({
    id: "B",
    chat: "123@s.whatsapp.net",
    isGroup: false,
    fromMe: false,
    sender: "123@s.whatsapp.net",
    text: null,
    receivedAt: Date.now(),
    raw: {
      key: { id: "B" },
      message: {
        imageMessage: { url: "x", jpegThumbnail: Buffer.from("abc") },
      },
    },
  });

  const insert = pool.calls.find((c) => c.text.startsWith("insert into \"public\".\"messages\""));
  const parsed = JSON.parse(insert.params[9]);
  assert.equal(parsed.message.imageMessage.jpegThumbnail.type, "Buffer");
  assert.equal(parsed.message.imageMessage.jpegThumbnail.data, "YWJj");
  assert.equal(parsed.message.imageMessage.url, "x");
});

test("message insert maps columns correctly", async () => {
  const pool = makePool();
  const store = createPostgresMessageStore({ pool });
  const receivedAt = 1700000000000;
  await store.save({
    id: "C",
    chat: "grp@g.us",
    isGroup: true,
    fromMe: false,
    sender: "999@s.whatsapp.net",
    text: "yo",
    senderEmail: "sender@gmail.com",
    receivedAt,
    raw: { key: { id: "C" } },
  });

  const insert = pool.calls.find((c) => c.text.startsWith("insert into \"public\".\"messages\""));
  assert.ok(insert.text.includes("media"), "media column written");
  assert.ok(insert.text.includes("quoted"), "quoted column written");
  assert.deepEqual(
    // id, chat_jid, from_me, sender_jid, content
    insert.params.slice(0, 5),
    ["C", "grp@g.us", false, "999@s.whatsapp.net", "yo"]
  );
  assert.equal(insert.params[5], null, "media stays null for text messages");
  assert.equal(insert.params[6], null, "quoted stays null without a reply");
  assert.equal(insert.params[7], new Date(receivedAt).toISOString(), "timestamp");
  assert.equal(insert.params[8], "sender@gmail.com", "sender_email column");
  assert.equal(insert.params[9], "{\"key\":{\"id\":\"C\"}}", "raw payload param");
  assert.ok(insert.text.includes("on conflict (id) do nothing"), "id dedupe");
});

test("saving media writes the jsonb ref and views expose a working url", async () => {
  const pool = makePool();
  const store = createPostgresMessageStore({ pool });
  await store.save({
    id: "C",
    chat: "grp@g.us",
    isGroup: true,
    fromMe: false,
    sender: "999@s.whatsapp.net",
    text: null,
    senderEmail: null,
    receivedAt: Date.now(),
    media: { key: "C", type: "image", mimeType: "image/jpeg", fileName: null },
    raw: { key: { id: "C" } },
  });

  const insert = pool.calls.find((c) => c.text.startsWith("insert into \"public\".\"messages\""));
  assert.deepEqual(insert.params[5], {
    key: "C",
    type: "image",
    mimeType: "image/jpeg",
    fileName: null,
  });

  const rowPool = makeRowPool({
    messages: [
      {
        id: "C",
        chat_jid: "grp@g.us",
        from_me: false,
        sender_jid: "999@s.whatsapp.net",
        content: null,
        timestamp: new Date(1000),
        raw_payload: { key: {}, pushName: "Tunde" },
        media: { key: "C", type: "image", mimeType: "image/jpeg", fileName: "shot.jpg" },
      },
    ],
    chats: [{ jid: "grp@g.us", name: null, is_group: true, flagged: false, read_at: null }],
  });
  const store2 = createPostgresMessageStore({ pool: rowPool, autoMigrate: false });
  const [conversation] = await store2.listConversations();
  assert.deepEqual(conversation.lastMessage.media, {
    type: "image",
    mimeType: "image/jpeg",
    fileName: "shot.jpg",
    url: "/api/media/C",
  });
});

test("a failed insert rolls back and releases", async () => {
  const pool = makePool(true);
  const store = createPostgresMessageStore({ pool });
  await assert.rejects(
    store.save({
      id: "D",
      chat: "123@s.whatsapp.net",
      isGroup: false,
      fromMe: true,
      sender: null,
      text: "x",
      receivedAt: Date.now(),
      raw: { key: { id: "D" } },
    }),
    /insert boom/
  );
  assert.ok(pool.transactions.includes("rollback"), "rollback on failure");
  assert.equal(pool.client.released, true, "release on failure");
});

test("store is idempotent across saves (no repeated migration)", async () => {
  const pool = makePool();
  const store = createPostgresMessageStore({ pool });
  const mk = (id) => ({
    id,
    chat: "123@s.whatsapp.net",
    isGroup: false,
    fromMe: false,
    sender: "123@s.whatsapp.net",
    text: "x",
    receivedAt: Date.now(),
    raw: { key: { id } },
  });
  await store.save(mk("1"));
  await store.save(mk("2"));
  const ddlCalls = pool.calls.filter((c) => c.text.includes("create table if not exists"));
  assert.equal(ddlCalls.length, 1, "DDL (both tables in one query) runs only once");
  assert.ok(ddlCalls[0].text.includes("create table if not exists \"public\".\"chats\""));
  assert.ok(ddlCalls[0].text.includes("create table if not exists \"public\".\"messages\""));
  assert.ok(ddlCalls[0].text.includes("create table if not exists \"public\".\"templates\""));
});

test("pg getMessageRaw returns the stored key and content for replies", async () => {
  const pool = makeRowPool({
    messages: [
      {
        id: "src",
        chat_jid: "123@s.whatsapp.net",
        from_me: false,
        raw_payload: {
          key: { id: "src", remoteJid: "123@s.whatsapp.net" },
          message: { conversation: "hello" },
        },
        deleted: false,
      },
    ],
  });
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  const raw = await store.getMessageRaw("123@s.whatsapp.net", "src");
  assert.equal(raw.id, "src");
  assert.equal(raw.fromMe, false);
  assert.equal(raw.key.id, "src");
  assert.equal(raw.message.conversation, "hello");
  assert.equal(raw.deleted, false);

  const call = pool.calls.find((c) => c.text.includes("raw_payload"));
  assert.deepEqual(call.params, ["123@s.whatsapp.net", "src"]);
});

function makeRowPool({ messages = [], chats = [] } = {}) {
  const calls = [];
  return {
    query: async (text, params) => {
      const t = text.trim();
      calls.push({ text: t, params });
      if (t.includes("from \"public\".\"messages\"")) return { rows: messages };
      if (t.includes("from \"public\".\"chats\"")) return { rows: chats };
      return { rows: [] };
    },
    calls,
  };
}

test("pg save folds a system payload into raw_payload", async () => {
  const pool = makePool();
  const store = createPostgresMessageStore({ pool });
  await store.save({
    id: "sys-1",
    chat: "grp@g.us",
    isGroup: true,
    fromMe: false,
    sender: "999@s.whatsapp.net",
    text: "Alice added Bob",
    receivedAt: Date.now(),
    raw: null,
    system: {
      action: "add",
      actor: "999@s.whatsapp.net",
      participants: ["555@s.whatsapp.net"],
    },
  });
  const insert = pool.calls.find((c) => c.text.startsWith("insert into \"public\".\"messages\""));
  assert.deepEqual(JSON.parse(insert.params[9]), {
    system: {
      action: "add",
      actor: "999@s.whatsapp.net",
      participants: ["555@s.whatsapp.net"],
    },
  });
});

test("pg setMessageReaction merges, replaces and clears per reactor", async () => {
  const pool = makeRowPool({
    messages: [{ reactions: { me: { text: "👍", at: 1 } } }],
  });
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const added = await store.setMessageReaction("123@s.whatsapp.net", "m1", "234@s.whatsapp.net", {
    text: "❤️",
    at: 2,
    name: "Ada",
  });
  assert.deepEqual(added, {
    me: { text: "👍", at: 1 },
    "234@s.whatsapp.net": { text: "❤️", at: 2, name: "Ada" },
  });
  const updates = pool.calls.filter((c) => c.text.includes("set reactions"));
  assert.deepEqual(JSON.parse(updates[0].params[0]), {
    me: { text: "👍", at: 1 },
    "234@s.whatsapp.net": { text: "❤️", at: 2, name: "Ada" },
  });

  // Clearing the only entry stores null rather than an empty object.
  const cleared = await store.setMessageReaction("123@s.whatsapp.net", "m1", "me", null);
  assert.deepEqual(cleared, {});
  const updates2 = pool.calls.filter((c) => c.text.includes("set reactions"));
  assert.equal(updates2[1].params[0], null, "empty map stored as null");

  // An unknown message is a no-op.
  const empty = createPostgresMessageStore({ pool: makePool(), autoMigrate: false });
  assert.equal(
    await empty.setMessageReaction("123@s.whatsapp.net", "nope", "me", { text: "x" }),
    null
  );
});

test("listConversations maps pg rows into conversations", async () => {
  const pool = makeRowPool({
    messages: [
      {
        id: "g1",
        chat_jid: "grp@g.us",
        from_me: false,
        sender_jid: "1@s.whatsapp.net",
        content: "hello",
        timestamp: new Date(1000),
        raw_payload: { key: {}, pushName: "Tunde" },
      },
      {
        id: "d1",
        chat_jid: "15551234567@s.whatsapp.net",
        from_me: false,
        sender_jid: "15551234567@s.whatsapp.net",
        content: "hi",
        timestamp: new Date(2000),
        raw_payload: { pushName: "Ada Okafor" },
      },
    ],
    chats: [
      { jid: "grp@g.us", name: null, is_group: true, flagged: false, read_at: null },
      { jid: "15551234567@s.whatsapp.net", name: null, is_group: false, flagged: true, read_at: null },
    ],
  });
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const list = await store.listConversations();
  assert.equal(list.length, 2);
  assert.equal(list[0].jid, "15551234567@s.whatsapp.net", "most recent first");
  assert.equal(list[0].name, "Ada Okafor", "name from raw_payload pushName");
  assert.equal(list[0].flagged, true);

  assert.equal(list[1].jid, "grp@g.us");
  assert.equal(list[1].name, "Group", "group fallback name");
  assert.equal(list[1].isGroup, true);
  assert.equal(Object.hasOwn(list[1], "messages"), false, "list is lightweight: no embedded thread");
  assert.equal(list[1].lastMessage.sender, "Tunde");
});

test("markRead and setFlagged run the right updates", async () => {
  const pool = makeRowPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  await store.markRead("c@s.whatsapp.net");
  await store.setFlagged("c@s.whatsapp.net", true);

  const texts = pool.calls.map((c) => c.text);
  assert.ok(texts.some((t) => t.includes("set read_at = now()")), "read_at update");
  assert.ok(texts.some((t) => t.includes("set flagged = $2")), "flag update");
  const upsertIdx = texts.findIndex((t) => t.startsWith("insert into \"public\".\"chats\""));
  const readIdx = texts.findIndex((t) => t.includes("set read_at = now()"));
  assert.ok(upsertIdx > -1 && upsertIdx < readIdx, "chat upsert precedes the update");
});

test("getMessages degrades to an empty thread for unknown chats", async () => {
  const pool = makeRowPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  const empty = await store.getMessages("nope@s.whatsapp.net");
  assert.equal(empty.jid, "nope@s.whatsapp.net");
  assert.deepEqual(empty.messages, []);
  // A malformed id (no @domain) is still not found.
  assert.equal(await store.getMessages("nope"), null);
});

/**
 * A pool mock that actually implements the store's keyset SQL in JS, so the
 * Postgres pagination path runs end-to-end (newest query, unread count, page
 * fetch, hasMore +1 trick, nextBefore cursors) against in-memory rows.
 */
function keysetPool({ rows, chats }) {
  const calls = [];
  const desc = (list) =>
    [...list].sort((a, b) => {
      const at = a.timestamp instanceof Date ? a.timestamp.getTime() : new Date(a.timestamp).getTime();
      const bt = b.timestamp instanceof Date ? b.timestamp.getTime() : new Date(b.timestamp).getTime();
      return bt - at || String(b.id).localeCompare(String(a.id));
    });
  const tsOf = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
  return {
    calls,
    query: async (text, params = []) => {
      const t = text.trim();
      calls.push({ text: t, params });
      if (t.includes('from "public"."messages"')) {
        if (t.startsWith("select count(")) {
          const [jid, readAt] = params;
          let list = rows.filter((m) => m.chat_jid === jid && !m.from_me);
          if (readAt != null) list = list.filter((m) => tsOf(m.timestamp) > tsOf(readAt));
          return { rows: [{ c: list.length }] };
        }
        const jid = params[0];
        let list = rows.filter((m) => m.chat_jid === jid);
        if (t.includes("and from_me = false")) list = list.filter((m) => !m.from_me);
        if (t.includes("(timestamp < $2 or")) {
          const [, ts, id, take] = params;
          const at = tsOf(ts);
          list = list.filter(
            (m) => tsOf(m.timestamp) < at || (tsOf(m.timestamp) === at && String(m.id) < String(id))
          );
          return { rows: desc(list).slice(0, take) };
        }
        const take = t.includes("limit $2") ? params[1] : 1; // literal limit 1 = newest query
        return { rows: desc(list).slice(0, take) };
      }
      if (t.includes('from "public"."chats"')) {
        const list = t.includes("where jid") ? chats.filter((c) => c.jid === params[0]) : chats;
        return { rows: list };
      }
      return { rows: [] };
    },
  };
}

test("getMessages pages pg rows with keyset cursors (parity with sqlite)", async () => {
  const now = 1_700_000_000_000;
  const rows = [4, 3, 2, 1, 0].map((i) => ({
    id: `m${i}`,
    chat_jid: "p@s.whatsapp.net",
    from_me: false,
    sender_jid: "p@s.whatsapp.net",
    content: `t${i}`,
    timestamp: new Date(now + i * 1000),
    raw_payload: { key: {}, pushName: "Ada Okafor" },
    media: null,
  }));
  const chats = [
    { jid: "p@s.whatsapp.net", name: null, is_group: false, flagged: false, read_at: null },
  ];
  const pool = keysetPool({ rows, chats });
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const p1 = await store.getMessages("p@s.whatsapp.net", { limit: 2 });
  assert.equal(p1.hasMore, true);
  assert.deepEqual(p1.conversation.messages.map((m) => m.id), ["m3", "m4"], "newest page, ascending");
  assert.ok(p1.nextBefore);
  assert.equal(p1.conversation.name, "Ada Okafor");
  assert.equal(p1.conversation.unread, 5, "unread counts the whole thread, not the page");

  const p2 = await store.getMessages("p@s.whatsapp.net", { limit: 2, before: decodeCursor(p1.nextBefore) });
  assert.deepEqual(p2.conversation.messages.map((m) => m.id), ["m1", "m2"]);
  assert.equal(p2.hasMore, true);

  const p3 = await store.getMessages("p@s.whatsapp.net", { limit: 2, before: decodeCursor(p2.nextBefore) });
  assert.deepEqual(p3.conversation.messages.map((m) => m.id), ["m0"], "oldest page");
  assert.equal(p3.hasMore, false);
  assert.equal(p3.nextBefore, null);

  const union = [...p1.conversation.messages, ...p2.conversation.messages, ...p3.conversation.messages].map((m) => m.id);
  const order = new Map(["m0", "m1", "m2", "m3", "m4"].map((id, i) => [id, i]));
  assert.deepEqual(
    [...union].sort((a, b) => order.get(a) - order.get(b)),
    ["m0", "m1", "m2", "m3", "m4"],
    "pg pages tile the whole thread (same set, no gaps, no overlaps)"
  );

  // The keyset predicate is sent verbatim with the cursor params.
  const beforeCall = pool.calls.find((c) => c.text.includes("(timestamp < $2 or"));
  assert.ok(beforeCall, "keyset page query issued");
  assert.deepEqual(beforeCall.params.slice(0, 3), [
    "p@s.whatsapp.net",
    decodeCursor(p1.nextBefore).timestamp,
    "m3",
  ]);

  const emptyPage = await store.getMessages("nope@s.whatsapp.net", { limit: 2 });
  assert.deepEqual(emptyPage.conversation.messages, [], "unknown chat with limit -> empty page");
  assert.equal(emptyPage.hasMore, false);
  assert.equal(emptyPage.nextBefore, null);
  assert.equal(await store.getMessages("nope", { limit: 2 }), null, "malformed id with limit -> null");
});

/**
 * A pool mock that actually implements the template store's SQL in JS, so save,
 * list, get, update (keep/replace/clear) and delete run against in-memory rows
 * with the same result shape Postgres returns.
 */
function templatePool(start = []) {
  const rows = start.map((r) => ({ ...r }));
  const calls = [];
  const find = (id) => rows.find((r) => r.id === id);
  return {
    calls,
    rows,
    query: async (text, params = []) => {
      const t = text.trim();
      calls.push({ text: t, params });
      if (t.startsWith('insert into "public"."templates"')) {
        // (id, title, body, media, fallback_name, created_at, updated_at)
        const existing = find(params[0]);
        if (existing) {
          // on conflict (id) do update: created_at is preserved
          existing.title = params[1];
          existing.body = params[2];
          existing.media = params[3];
          existing.fallback_name = params[4];
          existing.updated_at = params[6];
        } else {
          rows.push({
            id: params[0],
            title: params[1],
            body: params[2],
            media: params[3],
            fallback_name: params[4],
            created_at: params[5],
            updated_at: params[6],
          });
        }
        return { rows: [], rowCount: 1 };
      }
      if (t.startsWith('update "public"."templates"')) {
        // set title=$2, body=$3, media=$4, fallback_name=$5, updated_at=$6
        const row = find(params[0]);
        if (!row) return { rows: [], rowCount: 0 };
        row.title = params[1];
        row.body = params[2];
        row.media = params[3];
        row.fallback_name = params[4];
        row.updated_at = params[5];
        return { rows: [{ ...row }], rowCount: 1 }; // returning id, title...
      }
      if (t.startsWith('delete from "public"."templates"')) {
        const i = rows.findIndex((r) => r.id === params[0]);
        if (i === -1) return { rows: [], rowCount: 0 };
        rows.splice(i, 1);
        return { rows: [], rowCount: 1 };
      }
      if (t.includes('from "public"."templates"')) {
        if (t.includes("where id = $1")) {
          const row = find(params[0]);
          return { rows: row ? [{ ...row }] : [] };
        }
        const sorted = [...rows].sort(
          (a, b) =>
            String(b.created_at).localeCompare(String(a.created_at)) ||
            String(b.id).localeCompare(String(a.id))
        );
        return { rows: sorted.map((r) => ({ ...r })) };
      }
      return { rows: [] };
    },
  };
}

test("pg templates: save/list/get round-trip with jsonb media refs (newest first)", async () => {
  const pool = templatePool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const first = await store.saveTemplate({ id: "t1", title: "Welcome", body: "Hi!" });
  assert.equal(first.id, "t1");
  assert.equal(first.title, "Welcome");
  assert.equal(first.body, "Hi!");
  assert.equal(first.media, null);
  assert.ok(first.createdAt);

  const withMedia = await store.saveTemplate({
    id: "t2",
    title: "Pic",
    body: "",
    media: { key: "k2", type: "image", mimeType: "image/png", fileName: null },
  });
  assert.equal(withMedia.body, "");
  assert.deepEqual(withMedia.media, {
    type: "image",
    mimeType: "image/png",
    fileName: null,
    url: "/api/media/k2",
  });

  assert.deepEqual(
    (await store.listTemplates()).map((t) => t.id),
    ["t2", "t1"],
    "newest first"
  );
  assert.deepEqual(await store.getTemplate("t1"), first);
  assert.equal(await store.getTemplate("missing"), null);

  // The media ref goes to Postgres as a jsonb param (object, not a string).
  const insert = pool.calls.find(
    (c) => c.text.startsWith('insert into "public"."templates"') && c.params[0] === "t2"
  );
  assert.deepEqual(insert.params[3], { key: "k2", type: "image", mimeType: "image/png", fileName: null });

  // saveTemplate upserts on an existing id and keeps the original createdAt.
  const again = await store.saveTemplate({ id: "t1", title: "Welcome v2", body: "Hi again" });
  assert.equal(again.title, "Welcome v2");
  assert.equal(again.createdAt, first.createdAt, "createdAt is preserved on conflict");
  assert.equal((await store.listTemplates()).filter((t) => t.id === "t1").length, 1, "no duplicate row");
});

test("pg templates: updateTemplate keeps/replaces/clears media and preserves createdAt", async () => {
  const pool = templatePool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  const original = await store.saveTemplate({
    id: "t1",
    title: "Pic",
    body: "cap",
    media: { key: "k1", type: "image", mimeType: "image/png", fileName: null },
  });

  // media omitted -> keep
  const kept = await store.updateTemplate("t1", { title: "Renamed", body: "new cap" });
  assert.equal(kept.title, "Renamed");
  assert.equal(kept.media.url, "/api/media/k1");
  assert.equal(kept.createdAt, original.createdAt, "createdAt survives updates");

  // media null -> clear
  assert.equal((await store.updateTemplate("t1", { title: "Renamed", body: "new cap", media: null })).media, null);

  // media ref -> replace
  const replaced = await store.updateTemplate("t1", {
    title: "Renamed",
    body: "new cap",
    media: { key: "k2", type: "video", mimeType: "video/mp4", fileName: null },
  });
  assert.equal(replaced.media.url, "/api/media/k2");
  assert.equal(replaced.media.type, "video");

  // The keep-media update preserves the stored attachment: updateTemplate
  // reads the current row and writes the same media ref back.
  const keepCall = pool.calls.find(
    (c) => c.text.startsWith('update "public"."templates"') && c.params.length === 6
  );
  assert.ok(keepCall, "keep update is applied");
  assert.deepEqual(
    keepCall.params[3],
    { key: "k1", type: "image", mimeType: "image/png", fileName: null },
    "keep update rewrites the existing media ref"
  );

  assert.equal(await store.updateTemplate("missing", { title: "x", body: "y" }), null);
});

test("pg templates: deleteTemplate reports whether a row was removed", async () => {
  const pool = templatePool([
    { id: "t1", title: "A", body: "a", media: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ]);
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  assert.equal(await store.deleteTemplate("t1"), true);
  assert.equal(await store.deleteTemplate("t1"), false);
  assert.deepEqual(await store.listTemplates(), []);
});

/**
 * A pool mock that implements the contact / broadcast-list SQL in JS (including
 * the transactions importContacts and the list writes use), so the Postgres
 * parity of the SQLite store can be exercised against in-memory rows.
 */
function contactsPool({ contacts = [], lists = [], members = [], broadcasts = [], recipients = [] } = {}) {
  const contactRows = contacts.map((c) => ({ ...c }));
  const listRows = lists.map((l) => ({ ...l }));
  const memberRows = members.map((m) => ({ ...m })); // { list_id, contact_id }
  const broadcastRows = broadcasts.map((b) => ({ ...b }));
  const recipientRows = recipients.map((r) => ({ ...r })); // { broadcast_id, phone, ... }
  const calls = [];
  const transactions = [];
  const findContact = (id) => contactRows.find((c) => c.id === id);
  const findList = (id) => listRows.find((l) => l.id === id);
  const findBroadcast = (id) => broadcastRows.find((b) => b.id === id);
  const memberCount = (id) => memberRows.filter((m) => m.list_id === id).length;
  const newestFirst = (a, b) =>
    String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id));
  // Pulls the `col = $n` assignments out of an UPDATE's SET clause.
  const setColumns = (sql) => {
    const from = sql.indexOf("set") + 3;
    const to = sql.indexOf(" where ");
    return [...sql.slice(from, to).matchAll(/([a-z_]+)\s*=/g)].map((m) => m[1]);
  };

  async function run(text, params = []) {
    const t = text.trim();
    calls.push({ text: t, params });

    // contacts -------------------------------------------------------------
    if (t.startsWith('insert into "public"."contacts"')) {
      contactRows.push({ id: params[0], name: params[1], phone: params[2], created_at: params[3], updated_at: params[4] });
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('update "public"."contacts"')) {
      const row = findContact(params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.name = params[1];
      row.phone = params[2];
      row.updated_at = params[3];
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('delete from "public"."contacts"')) {
      if (t.includes("any(")) {
        const set = new Set(params[0]);
        const before = contactRows.length;
        for (let i = contactRows.length - 1; i >= 0; i--) {
          if (set.has(contactRows[i].id)) contactRows.splice(i, 1);
        }
        return { rows: [], rowCount: before - contactRows.length };
      }
      const i = contactRows.findIndex((c) => c.id === params[0]);
      if (i === -1) return { rows: [], rowCount: 0 };
      contactRows.splice(i, 1);
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('from "public"."contacts"')) {
      if (t.includes("id = any(")) {
        const set = new Set(params[0]);
        return { rows: contactRows.filter((c) => set.has(c.id)).map((c) => ({ id: c.id })) };
      }
      if (t.startsWith("select phone")) {
        return { rows: contactRows.map((c) => ({ phone: c.phone })) };
      }
      if (t.includes("where phone = $1")) {
        const row = contactRows.find((c) => c.phone === params[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (t.includes("where id = $1")) {
        const row = findContact(params[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (t.includes("lower(name) like")) {
        const q = String(params[0]).replace(/%/g, "").toLowerCase();
        return {
          rows: contactRows
            .filter(
              (c) =>
                String(c.name ?? "").toLowerCase().includes(q) || String(c.phone).includes(q)
            )
            .map((c) => ({ ...c })),
        };
      }
      return { rows: [...contactRows].sort(newestFirst).map((c) => ({ ...c })) };
    }

    // lists ----------------------------------------------------------------
    if (t.startsWith('insert into "public"."lists"')) {
      listRows.push({ id: params[0], name: params[1], description: params[2], created_at: params[3], updated_at: params[4] });
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('update "public"."lists"')) {
      const row = findList(params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      row.name = params[1];
      row.description = params[2];
      row.updated_at = params[3];
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('delete from "public"."lists"')) {
      const i = listRows.findIndex((l) => l.id === params[0]);
      if (i === -1) return { rows: [], rowCount: 0 };
      listRows.splice(i, 1);
      return { rows: [], rowCount: 1 };
    }
    if (t.includes('from "public"."lists"')) {
      const withCount = (l) => ({ ...l, member_count: memberCount(l.id) });
      if (t.includes("contact_id = $1")) {
        const listIds = new Set(
          memberRows.filter((m) => m.contact_id === params[0]).map((m) => m.list_id)
        );
        return {
          rows: [...listRows].filter((l) => listIds.has(l.id)).sort(newestFirst).map(withCount),
        };
      }
      if (t.includes("where id = $1")) {
        const row = findList(params[0]);
        return { rows: row ? [withCount(row)] : [] };
      }
      return { rows: [...listRows].sort(newestFirst).map(withCount) };
    }

    // list_contacts --------------------------------------------------------
    if (t.startsWith('insert into "public"."list_contacts"')) {
      const [listId, contactId] = params;
      if (!memberRows.some((m) => m.list_id === listId && m.contact_id === contactId)) {
        memberRows.push({ list_id: listId, contact_id: contactId });
      }
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('delete from "public"."list_contacts"')) {
      const key = t.includes("contact_id") ? "contact_id" : "list_id";
      const wanted = new Set(Array.isArray(params[0]) ? params[0] : [params[0]]);
      const before = memberRows.length;
      for (let i = memberRows.length - 1; i >= 0; i--) {
        if (wanted.has(memberRows[i][key])) memberRows.splice(i, 1);
      }
      return { rows: [], rowCount: before - memberRows.length };
    }
    if (t.includes('from "public"."list_contacts"')) {
      const ids = memberRows
        .filter((m) => m.list_id === params[0])
        .map((m) => m.contact_id)
        .sort();
      return { rows: ids.map((id) => ({ contact_id: id })) };
    }

    // broadcasts -----------------------------------------------------------
    if (t.startsWith('insert into "public"."broadcasts"')) {
      broadcastRows.push({
        id: params[0],
        template_id: params[1],
        template_title: params[2],
        list_ids: params[3],
        sender_email: params[4],
        min_delay: params[5],
        max_delay: params[6],
        send_at: params[7],
        status: params[8],
        total: params[9],
        sent: params[10],
        failed: params[11],
        created_at: params[12],
        started_at: params[13],
        finished_at: params[14],
        error: params[15],
      });
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('select * from "public"."broadcasts"')) {
      if (t.includes("where id = $1")) {
        const row = findBroadcast(params[0]);
        return { rows: row ? [{ ...row }] : [] };
      }
      if (t.includes("status = 'sending'")) {
        return {
          rows: broadcastRows.filter((b) => b.status === "sending").map((b) => ({ ...b })),
        };
      }
      return { rows: [...broadcastRows].sort(newestFirst).map((b) => ({ ...b })) };
    }
    if (t.startsWith('update "public"."broadcasts"')) {
      // claimDueBroadcasts: bulk flip scheduled -> sending, returning the rows.
      if (t.includes("send_at <= ")) {
        const claimed = broadcastRows.filter(
          (b) => b.status === "scheduled" && b.send_at != null && b.send_at <= params[0]
        );
        for (const b of claimed) {
          b.status = "sending";
          b.started_at = params[1];
        }
        return { rows: claimed.map((b) => ({ ...b })) };
      }
      // updateBroadcast: set ... where id = $1 returning *.
      const row = findBroadcast(params[0]);
      if (!row) return { rows: [], rowCount: 0 };
      setColumns(t).forEach((col, i) => {
        row[col] = params[i + 1];
      });
      return { rows: [{ ...row }], rowCount: 1 };
    }

    // broadcast_recipients -------------------------------------------------
    if (t.startsWith('insert into "public"."broadcast_recipients"')) {
      recipientRows.push({
        broadcast_id: params[0],
        phone: params[1],
        name: params[2],
        jid: params[3],
        status: params[4],
        error: params[5],
        sent_at: params[6],
      });
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('select * from "public"."broadcast_recipients"')) {
      const rows = recipientRows
        .filter((r) => r.broadcast_id === params[0])
        .sort((a, b) => String(a.phone).localeCompare(String(b.phone)))
        .map((r) => ({ ...r }));
      return { rows };
    }
    if (t.startsWith('update "public"."broadcast_recipients"')) {
      const row = recipientRows.find(
        (r) => r.broadcast_id === params[0] && r.phone === params[1]
      );
      if (!row) return { rows: [], rowCount: 0 };
      setColumns(t).forEach((col, i) => {
        row[col] = params[i + 2];
      });
      return { rows: [], rowCount: 1 };
    }

    return { rows: [] };
  }

  const client = {
    query: async (text, params = []) => {
      const t = text.trim();
      if (t === "begin" || t === "commit" || t === "rollback") {
        transactions.push(t);
        return { rows: [] };
      }
      return run(text, params);
    },
    release: () => {
      client.released = true;
    },
  };

  return {
    query: run,
    connect: async () => client,
    client,
    calls,
    transactions,
    contactRows,
    listRows,
    memberRows,
    broadcastRows,
    recipientRows,
  };
}

test("pg contacts: create/list/get/update/delete with canonical phones", async () => {
  const pool = contactsPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const ada = await store.createContact({ name: "  Ada Lovelace ", phone: "+234-814-685-8279" });
  assert.equal(ada.phone, "+2348146858279", "phone canonicalized before insert");
  assert.equal(ada.name, "Ada Lovelace", "name trimmed");
  assert.ok(ada.id && ada.createdAt);
  assert.equal(pool.contactRows[0].phone, "+2348146858279", "canonical phone reaches Postgres");

  assert.equal((await store.getContactByPhone("+2348146858279")).id, ada.id);
  assert.equal(await store.getContactByPhone("+10000000000"), null);

  await store.createContact({ name: "Grace Hopper", phone: "15551234567" });
  assert.deepEqual(
    (await store.listContacts()).map((c) => c.name).sort(),
    ["Ada Lovelace", "Grace Hopper"]
  );
  assert.deepEqual((await store.listContacts("grace")).map((c) => c.name), ["Grace Hopper"]);
  assert.deepEqual((await store.listContacts("1555")).map((c) => c.name), ["Grace Hopper"]);

  const updated = await store.updateContact(ada.id, { name: "Ada L", phone: "2348146858279" });
  assert.equal(updated.name, "Ada L");
  assert.equal(await store.updateContact("missing", { name: "x", phone: "15550000000" }), null);

  assert.equal(await store.deleteContact(ada.id), true);
  assert.equal(await store.deleteContact(ada.id), false);
  assert.equal(await store.getContact(ada.id), null);
});

test("pg contacts: importContacts reports imported/skipped and runs in a transaction", async () => {
  const pool = contactsPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  await store.createContact({ name: "Existing", phone: "15550000000" });

  const result = await store.importContacts([
    { name: "A", phone: "2348011111111" },
    { phone: "234-801-111-1111" }, // in-batch duplicate
    { phone: "15550000000" }, // stored duplicate
    { phone: "bad" }, // invalid
  ]);
  assert.equal(result.imported, 1);
  assert.deepEqual(result.skipped.map((s) => s.reason).sort(), [
    "already exists",
    "already exists",
    "invalid number",
  ]);
  assert.equal(pool.contactRows.length, 2, "existing + the one imported");
  assert.deepEqual(pool.transactions, ["begin", "commit"], "the valid rows are inserted in one transaction");
  assert.equal(pool.client.released, true);
});

test("pg lists: create/get/list/update/delete with memberCount and contactIds", async () => {
  const pool = contactsPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  const a = await store.createContact({ name: "A", phone: "2348011111111" });
  const b = await store.createContact({ name: "B", phone: "2348022222222" });
  const c = await store.createContact({ name: "C", phone: "2348033333333" });

  const list = await store.createList({
    name: "  Automotive Leads ",
    description: "warm",
    contactIds: [a.id, b.id, "ghost"],
  });
  assert.equal(list.name, "Automotive Leads", "name trimmed");
  assert.equal(list.description, "warm");
  assert.equal(list.memberCount, 2, "unknown ids dropped");
  assert.equal(Object.hasOwn(list, "contactIds"), false, "createList returns List, not ListDetail");

  const detail = await store.getList(list.id);
  assert.deepEqual([...detail.contactIds].sort(), [a.id, b.id].sort());
  assert.equal(detail.memberCount, 2);

  const all = await store.listLists();
  assert.equal(all.length, 1);
  assert.equal(all[0].memberCount, 2);

  // contactIds present -> replaces membership (unknown ids dropped, dupes collapsed).
  const updated = await store.updateList(list.id, {
    name: "Leads",
    description: "",
    contactIds: [b.id, c.id, c.id, "ghost"],
  });
  assert.equal(updated.memberCount, 2);
  assert.deepEqual([...(await store.getList(list.id)).contactIds].sort(), [b.id, c.id].sort());

  // contactIds absent -> membership kept.
  const renamed = await store.updateList(list.id, { name: "Leads v2", description: "x" });
  assert.equal(renamed.memberCount, 2, "membership kept when contactIds is omitted");

  assert.equal(await store.updateList("missing", { name: "x" }), null);

  assert.equal(await store.deleteList(list.id), true);
  assert.equal(await store.deleteList(list.id), false);
  assert.equal((await store.listLists()).length, 0);
  assert.equal((await store.listContacts()).length, 3, "deleting a list keeps its contacts");
});

test("pg lists: deleting a contact removes memberships but keeps the list", async () => {
  const pool = contactsPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  const a = await store.createContact({ name: "A", phone: "2348011111111" });
  const b = await store.createContact({ name: "B", phone: "2348022222222" });
  const list = await store.createList({ name: "L", contactIds: [a.id, b.id] });
  assert.equal((await store.getList(list.id)).memberCount, 2);

  assert.equal(await store.deleteContact(a.id), true);
  assert.equal((await store.getList(list.id)).memberCount, 1);
  assert.deepEqual((await store.getList(list.id)).contactIds, [b.id]);
  assert.equal((await store.listLists()).length, 1, "the list survives a contact deletion");
});

test("pg contacts: deleteContacts bulk-removes memberships and keeps lists", async () => {
  const pool = contactsPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  const a = await store.createContact({ name: "A", phone: "2348011111111" });
  const b = await store.createContact({ name: "B", phone: "2348022222222" });
  const c = await store.createContact({ name: "C", phone: "2348033333333" });
  const list = await store.createList({ name: "L", contactIds: [a.id, b.id, c.id] });
  assert.equal((await store.getList(list.id)).memberCount, 3);

  pool.transactions.length = 0; // ignore createList's transaction
  // Unknown + repeated ids are ignored; only the real ones count.
  const deleted = await store.deleteContacts([a.id, b.id, a.id, "ghost"]);
  assert.equal(deleted, 2, "counts only contacts that existed");
  assert.equal(await store.deleteContacts(["ghost"]), 0, "unknown ids delete nothing");

  assert.deepEqual(pool.transactions, ["begin", "commit", "begin", "commit"]);
  assert.equal((await store.listContacts()).length, 1, "C survives");
  assert.deepEqual((await store.getList(list.id)).contactIds, [c.id]);
  assert.equal((await store.listLists()).length, 1, "the list survives a bulk deletion");
});

test("pg lists: listListsForContact returns only the lists containing the contact, newest first", async () => {
  const pool = contactsPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  const a = await store.createContact({ name: "A", phone: "2348011111111" });
  const b = await store.createContact({ name: "B", phone: "2348022222222" });

  await store.createList({ name: "First", contactIds: [a.id] });
  await new Promise((r) => setTimeout(r, 5));
  await store.createList({ name: "Second", contactIds: [a.id, b.id] });
  await new Promise((r) => setTimeout(r, 5));
  await store.createList({ name: "Other", contactIds: [b.id] });

  const lists = await store.listListsForContact(a.id);
  assert.deepEqual(lists.map((l) => l.name), ["Second", "First"], "newest first");
  assert.deepEqual(lists.map((l) => l.memberCount), [2, 1], "memberCount per list");
  assert.equal(Object.hasOwn(lists[0], "contactIds"), false, "list view omits contactIds");
  assert.equal((await store.listListsForContact(b.id)).length, 2, "B is in Second + Other");
  assert.deepEqual(await store.listListsForContact("ghost"), [], "unknown contact has no lists");
});

test("pg templates: fallbackName defaults, round-trips and survives partial updates", async () => {
  const pool = templatePool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const plain = await store.saveTemplate({ id: "t1", title: "Plain", body: "hi" });
  assert.equal(plain.fallbackName, "");

  const named = await store.saveTemplate({ id: "t2", title: "Named", body: "hi", fallbackName: "Friend" });
  assert.equal(named.fallbackName, "Friend");
  assert.equal((await store.getTemplate("t2")).fallbackName, "Friend");

  assert.equal(
    (await store.updateTemplate("t1", { title: "Plain", body: "hi", fallbackName: "Pal" })).fallbackName,
    "Pal"
  );
  assert.equal(
    (await store.updateTemplate("t1", { title: "Plain v2", body: "hi" })).fallbackName,
    "Pal",
    "omitting fallbackName keeps the current value"
  );
  assert.equal(
    (await store.updateTemplate("t1", { title: "Plain v3", body: "hi", fallbackName: "" })).fallbackName,
    "",
    "an explicit empty string clears it"
  );
});

test("pg broadcasts: createBroadcast persists the row and deduped recipients", async () => {
  const pool = contactsPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const broadcast = await store.createBroadcast({
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

  assert.equal(broadcast.templateTitle, "Welcome");
  assert.deepEqual(broadcast.listIds, ["l1", "l2"]);
  assert.equal(broadcast.senderEmail, "ops@example.com");
  assert.equal(broadcast.total, 2, "recipients deduped by phone");
  assert.equal(broadcast.status, "sending");
  assert.equal(broadcast.startedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(pool.transactions, ["begin", "commit"], "createBroadcast writes in one transaction");
  assert.equal(pool.client.released, true);

  const recipients = await store.listBroadcastRecipients("b1");
  assert.deepEqual(recipients.map((r) => r.phone), ["+2348011111111", "+2348022222222"]);
  assert.equal(recipients[0].name, "Ada Lovelace", "first name wins on dedupe");
  assert.ok(recipients.every((r) => r.status === "pending"));

  assert.deepEqual(await store.getBroadcast("b1"), broadcast);
  assert.deepEqual((await store.listBroadcasts()).map((b) => b.id), ["b1"]);
  assert.equal(await store.getBroadcast("missing"), null);
  assert.equal(await store.updateBroadcast("missing", { status: "done" }), null);
});

test("pg broadcasts: patching, claiming due rows and listing interrupted rows", async () => {
  const pool = contactsPool({
    broadcasts: [
      { id: "past", template_id: "t1", list_ids: "[]", status: "scheduled", send_at: "2026-01-01T00:00:00.000Z", total: 0, sent: 0, failed: 0, created_at: "2026-01-01T00:00:00.000Z" },
      { id: "future", template_id: "t1", list_ids: "[]", status: "scheduled", send_at: "2027-01-01T00:00:00.000Z", total: 0, sent: 0, failed: 0, created_at: "2026-01-02T00:00:00.000Z" },
      { id: "immediate", template_id: "t1", list_ids: "[]", status: "sending", send_at: null, total: 0, sent: 0, failed: 0, created_at: "2026-01-03T00:00:00.000Z" },
    ],
    recipients: [
      { broadcast_id: "past", phone: "+2348011111111", name: "A", jid: null, status: "pending", error: null, sent_at: null },
    ],
  });
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const claimed = await store.claimDueBroadcasts("2026-06-01T00:00:00.000Z");
  assert.deepEqual(claimed.map((b) => b.id), ["past"]);
  assert.equal(claimed[0].status, "sending");
  assert.equal(claimed[0].startedAt, "2026-06-01T00:00:00.000Z");
  assert.deepEqual(await store.claimDueBroadcasts("2026-06-01T00:00:00.000Z"), []);
  assert.equal((await store.getBroadcast("future")).status, "scheduled");
  assert.deepEqual(
    (await store.listInterruptedBroadcasts()).map((b) => b.id).sort(),
    ["immediate", "past"]
  );

  assert.equal(
    await store.markBroadcastRecipient("past", "+2348011111111", {
      status: "sent",
      jid: "2348011111111@s.whatsapp.net",
      sentAt: "2026-06-01T00:00:01.000Z",
    }),
    true
  );
  assert.equal(await store.markBroadcastRecipient("past", "ghost", { status: "sent" }), false);
  const [recipient] = await store.listBroadcastRecipients("past");
  assert.equal(recipient.status, "sent");
  assert.equal(recipient.sentAt, "2026-06-01T00:00:01.000Z");

  const updated = await store.updateBroadcast("past", {
    status: "done",
    sent: 1,
    failed: 0,
    finishedAt: "2026-06-01T00:00:02.000Z",
  });
  assert.equal(updated.status, "done");
  assert.equal(updated.sent, 1);
  assert.equal(updated.finishedAt, "2026-06-01T00:00:02.000Z");
});

test("pg broadcasts: listBroadcasts returns newest first", async () => {
  const pool = contactsPool({
    broadcasts: [
      { id: "b1", template_id: "t1", list_ids: "[]", status: "done", send_at: null, total: 0, sent: 0, failed: 0, created_at: "2026-01-01T00:00:00.000Z" },
      { id: "b2", template_id: "t1", list_ids: "[]", status: "done", send_at: null, total: 0, sent: 0, failed: 0, created_at: "2026-02-01T00:00:00.000Z" },
    ],
  });
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  assert.deepEqual((await store.listBroadcasts()).map((b) => b.id), ["b2", "b1"]);
});

/* ------------------------------------------------------------------ */
/*  Identity: one chat per person (LID <-> phone number)               */
/* ------------------------------------------------------------------ */

const PG_LID = "225159969521788@lid";
const PG_PN = "2348052928072@s.whatsapp.net";

/**
 * Minimal in-memory Postgres pool handling exactly the queries the identity
 * methods issue: schema DDL (no-op), the raw-payload scan, alias lookups,
 * chat row reads, message moves and chat merges.
 */
function identityPool({ messages = [], chats = [] } = {}) {
  const msgs = messages.map((m) => ({ ...m }));
  const chatRows = chats.map((c) => ({ ...c }));
  const aliases = [];
  const transactionStack = [];
  const calls = [];
  const run = async (text, params = []) => {
    const t = text.trim();
    calls.push({ text: t, params });
    if (t === "begin" || t === "commit" || t === "rollback") {
      transactionStack.push(t);
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith("create table") || t.startsWith("alter table") || t.startsWith("create index")) {
      return { rows: [], rowCount: 0 };
    }
    if (t.startsWith("select chat_jid, raw_payload")) {
      return { rows: msgs.map((m) => ({ chat_jid: m.chat_jid, raw_payload: m.raw_payload })) };
    }
    if (t.startsWith("select canonical_jid from")) {
      return {
        rows: aliases.filter((a) => a.alias_jid === params[0]).map((a) => ({ canonical_jid: a.canonical_jid })),
      };
    }
    if (t.startsWith("select jid, name, username")) {
      const ids = params[0] ?? [];
      return { rows: chatRows.filter((c) => ids.includes(c.jid)).map((c) => ({ ...c })) };
    }
    if (t.startsWith("select name from")) {
      const row = chatRows.find((c) => c.jid === params[0]);
      return { rows: row ? [{ name: row.name }] : [] };
    }
    if (t.startsWith('insert into "public"."chats"')) {
      if (!chatRows.some((c) => c.jid === params[0])) {
        chatRows.push({ jid: params[0], name: null, username: null, is_group: Boolean(params[1]), flagged: false });
      }
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('update "public"."messages"')) {
      for (const m of msgs) if (m.chat_jid === params[1]) m.chat_jid = params[0];
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('update "public"."chats"') && t.includes("coalesce")) {
      const row = chatRows.find((c) => c.jid === params[0]);
      if (row) {
        if (params[1] != null) row.name = params[1];
        if (params[2] != null) row.username = params[2];
        if (params[3] != null) row.is_group = Boolean(params[3]);
      }
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('update "public"."chats"')) {
      const row = chatRows.find((c) => c.jid === params[0]);
      if (row) {
        row.name = params[1];
        row.username = params[2];
        row.read_at = params[3];
        row.flagged = Boolean(params[4]);
      }
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('delete from "public"."chats"')) {
      const idx = chatRows.findIndex((c) => c.jid === params[0]);
      if (idx >= 0) chatRows.splice(idx, 1);
      return { rows: [], rowCount: 1 };
    }
    if (t.startsWith('insert into "public"."chat_aliases"')) {
      const idx = aliases.findIndex((a) => a.alias_jid === params[0]);
      if (idx >= 0) aliases.splice(idx, 1);
      aliases.push({ alias_jid: params[0], canonical_jid: params[1], updated_at: new Date() });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const client = { query: run, release: () => {} };
  return {
    query: run,
    connect: async () => client,
    calls,
    transactionStack,
    _state: { msgs, chatRows, aliases },
  };
}

test("pg identities: resolveChatJid maps the phone number to the LID", async () => {
  const pool = identityPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });
  pool._state.aliases.push({ alias_jid: PG_PN, canonical_jid: PG_LID });

  assert.equal(await store.resolveChatJid(PG_PN), PG_LID);
  assert.equal(await store.resolveChatJid(PG_LID), PG_LID);
  assert.equal(await store.resolveChatJid("999@s.whatsapp.net"), "999@s.whatsapp.net");
});

test("pg identities: canonicalizeChat moves messages and merges chat rows", async () => {
  const pool = identityPool({
    messages: [
      { id: "in-1", chat_jid: PG_LID, raw_payload: { key: { remoteJid: PG_LID, remoteJidAlt: PG_PN } } },
      { id: "out-1", chat_jid: PG_PN, raw_payload: { key: { remoteJid: PG_PN, fromMe: true } } },
    ],
    chats: [
      { jid: PG_LID, name: null, username: null, is_group: false, flagged: true, read_at: new Date("2026-01-02T00:00:00Z"), updated_at: new Date("2026-01-02T00:00:00Z") },
      { jid: PG_PN, name: "Ada Lovelace", username: "ada", is_group: false, flagged: false, read_at: new Date("2026-01-01T00:00:00Z"), updated_at: new Date("2026-01-01T00:00:00Z") },
    ],
  });
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const canonical = await store.canonicalizeChat(PG_PN, PG_LID);
  assert.equal(canonical, PG_LID);

  assert.ok(pool._state.msgs.every((m) => m.chat_jid === PG_LID), "messages move onto the LID chat");
  const lid = pool._state.chatRows.find((c) => c.jid === PG_LID);
  assert.equal(lid.name, "Ada Lovelace", "the saved name on the alias is merged");
  assert.equal(lid.username, "ada");
  assert.equal(lid.flagged, true, "flagged is OR-ed");
  assert.equal(pool._state.chatRows.length, 1, "the alias row is deleted");
  assert.deepEqual(
    pool._state.aliases.map((a) => [a.alias_jid, a.canonical_jid]),
    [[PG_PN, PG_LID]]
  );
  assert.deepEqual(pool.transactionStack, ["begin", "commit"], "merge runs in one transaction");
});

test("pg identities: setChatName is a coalesce update", async () => {
  const pool = identityPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  await store.setChatName(PG_PN, "Saved Name", "user");
  assert.equal(pool._state.chatRows.find((c) => c.jid === PG_PN).name, "Saved Name");

  await store.setChatName(PG_PN, "", "");
  assert.equal(pool._state.chatRows.find((c) => c.jid === PG_PN).name, "Saved Name", "empty sync keeps the name");
});

test("pg identities: setChatName flags group chats and resolveChatName returns names", async () => {
  const pool = identityPool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  await store.setChatName("123-456@g.us", "Family");
  await store.setChatName(PG_PN, "Ada Lovelace", "ada");

  const group = pool._state.chatRows.find((c) => c.jid === "123-456@g.us");
  assert.equal(group.is_group, true, "group jids are flagged as groups");
  assert.equal(group.name, "Family");
  assert.equal(
    pool._state.chatRows.find((c) => c.jid === PG_PN).is_group,
    false,
    "1:1 chats stay unflagged"
  );

  assert.equal(await store.resolveChatName("123-456@g.us"), "Family");
  assert.equal(await store.resolveChatName(PG_PN), "Ada Lovelace");
  assert.equal(await store.resolveChatName("nobody@s.whatsapp.net"), null, "unknown jids are null");
});

test("pg identities: existing split chats are merged during migration", async () => {
  const pool = identityPool({
    messages: [
      { id: "legacy-lid", chat_jid: PG_LID, raw_payload: { key: { remoteJid: PG_LID, remoteJidAlt: PG_PN } } },
      { id: "legacy-pn", chat_jid: PG_PN, raw_payload: { key: { remoteJid: PG_PN, fromMe: true } } },
    ],
    chats: [
      { jid: PG_LID, name: null, username: null, is_group: false, flagged: false, read_at: null, updated_at: new Date("2026-01-01T00:00:00Z") },
      { jid: PG_PN, name: "Ada", username: "ada", is_group: false, flagged: false, read_at: null, updated_at: new Date("2026-01-01T00:00:00Z") },
    ],
  });
  const store = createPostgresMessageStore({ pool });

  // First op triggers the schema migration + identity backfill.
  await store.resolveChatJid(PG_PN);

  assert.ok(pool._state.msgs.every((m) => m.chat_jid === PG_LID), "the merge heals the split");
  assert.equal(pool._state.chatRows.length, 1, "alias chat row dropped");
  assert.equal(pool._state.chatRows[0].name, "Ada");
  assert.equal(
    pool._state.aliases.find((a) => a.alias_jid === PG_PN)?.canonical_jid,
    PG_LID,
    "the old PN id still resolves to the LID"
  );
});

/* ------------------------------------------------------------------ */
/*  Clear all data                                                     */
/* ------------------------------------------------------------------ */

test("pg clearAll deletes every table in one transaction", async () => {
  const pool = makePool();
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const tables = [
    "broadcast_recipients",
    "broadcasts",
    "list_contacts",
    "lists",
    "contacts",
    "templates",
    "messages",
    "chat_aliases",
    "chats",
    "moderation_log",
    "guard_strikes",
    "guard_settings",
    "auto_reply_groups",
    "auto_reply_rules",
    "away_replies",
    "away_settings",
  ];

  assert.equal(await store.clearAll(), tables.length);

  const deletes = pool.calls
    .filter((c) => c.text.startsWith("delete from "))
    .map((c) => c.text);
  for (const table of tables) {
    assert.ok(deletes.includes(`delete from "public"."${table}"`), `${table} is cleared`);
  }
  assert.equal(deletes.length, tables.length, "one delete per table, no extras");
  assert.deepEqual(pool.transactions, ["begin", "commit"], "clearAll runs in one transaction");
  assert.equal(pool.client.released, true, "client must be released");
});

test("pg group snapshots migrate the chats table and upsert on save", async () => {
  const pool = makeRowPool();
  const store = createPostgresMessageStore({ pool });
  const snapshot = { jid: "grp@g.us", name: "Family", participants: [{ id: "1@s.whatsapp.net" }] };
  await store.saveGroupSnapshot("grp@g.us", snapshot);

  const ddl = pool.calls[0].text;
  assert.ok(
    ddl.includes("add column if not exists group_snapshot jsonb"),
    "snapshot column migration"
  );
  assert.ok(
    ddl.includes("add column if not exists group_snapshot_at timestamptz"),
    "snapshot timestamp migration"
  );

  const insert = pool.calls.find(
    (c) => c.text.startsWith('insert into "public"."chats"') && c.text.includes("group_snapshot")
  );
  assert.ok(insert, "snapshot upsert issued");
  assert.ok(insert.text.includes("on conflict (jid) do update"), "upsert semantics");
  assert.equal(insert.params[0], "grp@g.us");
  assert.deepEqual(JSON.parse(insert.params[1]), snapshot);

  // A 1:1 jid is refused so a stray event can't seed a snapshot.
  const before = pool.calls.length;
  await store.saveGroupSnapshot("123@s.whatsapp.net", snapshot);
  assert.equal(pool.calls.length, before, "non-group jid is a no-op");
});

test("pg getGroupSnapshot round-trips the snapshot and fetchedAt", async () => {
  const fetchedAt = new Date("2026-02-01T10:00:00Z");
  const pool = makeRowPool({
    chats: [
      {
        group_snapshot: { jid: "grp@g.us", name: "Family" },
        group_snapshot_at: fetchedAt,
      },
    ],
  });
  const store = createPostgresMessageStore({ pool, autoMigrate: false });

  const stored = await store.getGroupSnapshot("grp@g.us");
  assert.deepEqual(stored.snapshot, { jid: "grp@g.us", name: "Family" });
  assert.equal(stored.fetchedAt, fetchedAt.getTime());

  // A chat without a snapshot resolves to null rather than throwing.
  const emptyPool = makeRowPool({ chats: [{ group_snapshot: null, group_snapshot_at: null }] });
  const empty = createPostgresMessageStore({ pool: emptyPool, autoMigrate: false });
  assert.equal(await empty.getGroupSnapshot("grp@g.us"), null);
});