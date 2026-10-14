import { test } from "node:test";
import assert from "node:assert/strict";

const {
  relativeTime,
  shortJid,
  groupConversations,
  conversationThread,
  encodeCursor,
  decodeCursor,
} = await import("../src/db/inbox.js");

test("shortJid strips the @suffix", () => {
  assert.equal(shortJid("15551234567@s.whatsapp.net"), "15551234567");
  assert.equal(shortJid("grp@g.us"), "grp");
  assert.equal(shortJid(""), "");
});

test("relativeTime formats like the inbox mock", () => {
  const now = Date.now();
  assert.equal(relativeTime(now - 2_000), "2s");
  assert.equal(relativeTime(now - 120_000), "2m");
  assert.equal(relativeTime(now - 14 * 60_000), "14m");
  assert.equal(relativeTime(now - 3_600_000), "1h");
  assert.equal(relativeTime(now - 26 * 3_600_000), "Yesterday");
  assert.equal(relativeTime(now - 3 * 86_400_000), "3d");
});

function meta(jid, over = {}) {
  return {
    name: null,
    isGroup: false,
    flagged: false,
    readAtMs: 0,
    ...over,
  };
}

test("groupConversations groups, sorts and names conversations", () => {
  const now = Date.now();
  const conversations = groupConversations({
    messages: [
      {
        id: "g1",
        chat: "grp@g.us",
        fromMe: false,
        sender: "1@s.whatsapp.net",
        text: "hello",
        tsMs: now - 60_000,
        pushName: "Tunde",
      },
      {
        id: "g2",
        chat: "grp@g.us",
        fromMe: true,
        sender: null,
        text: "hey",
        tsMs: now - 30_000,
        pushName: null,
      },
      {
        id: "d1",
        chat: "15551234567@s.whatsapp.net",
        fromMe: false,
        sender: "15551234567@s.whatsapp.net",
        text: "hi",
        tsMs: now - 5_000,
        pushName: "Ada Okafor",
      },
    ],
    chats: new Map([
      ["grp@g.us", meta("grp@g.us", { isGroup: true })],
      ["15551234567@s.whatsapp.net", meta("15551234567@s.whatsapp.net", { flagged: true })],
    ]),
  });

  assert.equal(conversations.length, 2);
  // most recent activity first
  assert.equal(conversations[0].id, "15551234567@s.whatsapp.net");
  assert.equal(conversations[1].id, "grp@g.us");

  const dm = conversations[0];
  assert.equal(dm.name, "Ada Okafor", "1:1 name uses the last known pushName");
  assert.equal(dm.isGroup, false);
  assert.equal(dm.unread, 1, "incoming message newer than read_at counts");
  assert.equal(dm.flagged, true);
  assert.ok(dm.time, "relative time label present");
  assert.equal(dm.messages[0].from, "them");
  assert.equal(Object.hasOwn(dm.messages[0], "sender"), false, "1:1 rows carry no sender");

  const grp = conversations[1];
  assert.equal(grp.name, "Group");
  assert.equal(grp.isGroup, true);
  assert.equal(grp.messages.length, 2);
  assert.equal(grp.messages[0].sender, "Tunde", "group sender from pushName");
  assert.equal(Object.hasOwn(grp.messages[1], "sender"), false, "fromMe without pushName has no sender");
});

test("unread honors read_at", () => {
  const now = Date.now();
  const mk = () =>
    groupConversations({
      messages: [
        {
          id: "m1",
          chat: "c@s.whatsapp.net",
          fromMe: false,
          sender: "c@s.whatsapp.net",
          text: "old",
          tsMs: now - 60_000,
          pushName: "Cara",
        },
        {
          id: "m2",
          chat: "c@s.whatsapp.net",
          fromMe: false,
          sender: "c@s.whatsapp.net",
          text: "new",
          tsMs: now - 1_000,
          pushName: "Cara",
        },
      ],
      chats: new Map([["c@s.whatsapp.net", meta("c@s.whatsapp.net")]]),
    })[0];

  assert.equal(mk().unread, 2, "nothing read yet");

  const readLater = groupConversations({
    messages: [
      {
        id: "m1",
        chat: "c@s.whatsapp.net",
        fromMe: false,
        sender: "c@s.whatsapp.net",
        text: "old",
        tsMs: now - 60_000,
        pushName: "Cara",
      },
      {
        id: "m2",
        chat: "c@s.whatsapp.net",
        fromMe: false,
        sender: "c@s.whatsapp.net",
        text: "new",
        tsMs: now - 1_000,
        pushName: "Cara",
      },
    ],
    chats: new Map([["c@s.whatsapp.net", meta("c@s.whatsapp.net", { readAtMs: now - 10_000 })]]),
  })[0];
  assert.equal(readLater.unread, 1, "only messages after read_at count");
});

test("system lines and reactions map onto views, and system rows aren't unread", () => {
  const now = Date.now();
  const conv = groupConversations({
    messages: [
      {
        id: "m1",
        chat: "grp@g.us",
        fromMe: false,
        sender: "1@s.whatsapp.net",
        text: "hi",
        tsMs: now - 5_000,
        pushName: "Tunde",
        reactions: {
          me: { text: "👍", at: 1 },
          "234@s.whatsapp.net": { text: "❤️", at: 2, name: "Ada" },
          "345@s.whatsapp.net": { text: "" }, // cleared — never surfaces
        },
      },
      {
        id: "sys-1",
        chat: "grp@g.us",
        fromMe: false,
        sender: "999@s.whatsapp.net",
        text: "Alice added Bob",
        tsMs: now - 1_000,
        pushName: null,
        system: {
          action: "add",
          actor: "999@s.whatsapp.net",
          participants: ["555@s.whatsapp.net"],
        },
      },
    ],
    chats: new Map([["grp@g.us", meta("grp@g.us", { isGroup: true })]]),
  })[0];

  assert.equal(conv.unread, 1, "system rows never inflate the unread badge");
  const [first, second] = conv.messages;
  assert.deepEqual(first.reactions, [
    { text: "👍", from: "me" },
    { text: "❤️", from: "them", sender: "Ada" },
  ]);
  assert.deepEqual(second.system, {
    action: "add",
    actor: "999@s.whatsapp.net",
    participants: ["555@s.whatsapp.net"],
  });
  assert.equal(second.text, "Alice added Bob", "system text is the display line");
});

test("conversationThread builds a single ascending thread or null", () => {
  const now = Date.now();
  const thread = conversationThread({
    jid: "c@s.whatsapp.net",
    chats: new Map([["c@s.whatsapp.net", meta("c@s.whatsapp.net")]]),
    messages: [
      { id: "a", chat: "c@s.whatsapp.net", fromMe: true, sender: null, text: "1", tsMs: now - 1000, pushName: null },
      { id: "b", chat: "c@s.whatsapp.net", fromMe: false, sender: "c@s.whatsapp.net", text: "2", tsMs: now - 2000, pushName: null },
    ],
  });
  assert.equal(thread.jid, "c@s.whatsapp.net");
  assert.equal(thread.messages.map((m) => m.id).join(","), "b,a", "ascending order");
  assert.equal(conversationThread({ jid: "nope" }), null);
});

test("media messages expose a media object on their message view", () => {
  const now = Date.now();
  const [c] = groupConversations({
    messages: [
      {
        id: "m1",
        chat: "c@s.whatsapp.net",
        fromMe: true,
        sender: null,
        text: "",
        tsMs: now - 1000,
        pushName: null,
        media: { type: "image", mimeType: "image/jpeg", fileName: null, url: "/api/media/m1" },
      },
      {
        id: "m2",
        chat: "c@s.whatsapp.net",
        fromMe: true,
        sender: null,
        text: "plain",
        tsMs: now - 500,
        pushName: null,
      },
    ],
    chats: new Map([["c@s.whatsapp.net", meta("c@s.whatsapp.net")]]),
  });

  assert.deepEqual(c.messages[0].media, {
    type: "image",
    mimeType: "image/jpeg",
    fileName: null,
    url: "/api/media/m1",
  });
  assert.equal(Object.hasOwn(c.messages[1], "media"), false, "no media key for plain text");
});

test("media without a url is omitted from the view", () => {
  const now = Date.now();
  const [c] = groupConversations({
    messages: [
      {
        id: "m1",
        chat: "c@s.whatsapp.net",
        fromMe: true,
        sender: null,
        text: "",
        tsMs: now - 1000,
        pushName: null,
        media: { type: "audio", mimeType: "audio/ogg", fileName: null, url: null },
      },
    ],
    chats: new Map([["c@s.whatsapp.net", meta("c@s.whatsapp.net")]]),
  });
  assert.equal(Object.hasOwn(c.messages[0], "media"), false, "url-less media is not exposed");
});

test("connection-style media refs ({ key, ... }) derive their url in the view", () => {
  const now = Date.now();
  const [c] = groupConversations({
    messages: [
      {
        id: "m1",
        chat: "c@s.whatsapp.net",
        fromMe: false,
        sender: "c@s.whatsapp.net",
        text: "",
        tsMs: now - 1000,
        name: "Cara",
        media: { key: "m1", type: "document", mimeType: "application/pdf", fileName: "guide.pdf" },
      },
    ],
    chats: new Map([["c@s.whatsapp.net", meta("c@s.whatsapp.net")]]),
  });
  assert.deepEqual(c.messages[0].media, {
    type: "document",
    mimeType: "application/pdf",
    fileName: "guide.pdf",
    url: "/api/media/m1",
  });
});

test("keyset cursors round-trip and reject garbage", () => {
  const cur = encodeCursor("2026-10-13T12:00:00.000Z", "3EB0ABC9A1DEF");
  assert.deepEqual(decodeCursor(cur), {
    timestamp: "2026-10-13T12:00:00.000Z",
    id: "3EB0ABC9A1DEF",
  });

  assert.equal(decodeCursor(""), null, "empty");
  assert.equal(decodeCursor(null), null, "null");
  assert.equal(decodeCursor("not-a-cursor"), null, "not base64url");
  assert.equal(decodeCursor(Buffer.from("hello!").toString("base64url")), null, "no separator");
  assert.equal(decodeCursor(Buffer.from("|").toString("base64url")), null, "separator, no parts");
  assert.equal(decodeCursor(Buffer.from("|id").toString("base64url")), null, "empty timestamp");
  assert.equal(
    decodeCursor(Buffer.from("2026-13-99T00:00:00.000Z|id").toString("base64url")),
    null,
    "timestamp that doesn't parse"
  );
});

test("groupConversations summary mode exposes lastMessage instead of messages", () => {
  const now = Date.now();
  const [c] = groupConversations(
    {
      messages: [
        { id: "a", chat: "c@s.whatsapp.net", fromMe: true, sender: null, text: "first", tsMs: now - 3000, pushName: null },
        { id: "b", chat: "c@s.whatsapp.net", fromMe: false, sender: "c@s.whatsapp.net", text: "second", tsMs: now - 1000, pushName: "Cara" },
      ],
      chats: new Map([["c@s.whatsapp.net", meta("c@s.whatsapp.net")]]),
    },
    { summary: true }
  );
  assert.equal(Object.hasOwn(c, "messages"), false, "no embedded thread in summary mode");
  assert.equal(c.lastMessage.id, "b", "lastMessage is the newest message");
  assert.equal(c.lastMessage.from, "them");
  assert.equal(c.lastMessage.text, "second");
  assert.equal(c.name, "Cara");
  assert.equal(c.unread, 1);
  assert.equal(c.lastMessageAt, new Date(now - 1000).toISOString());
});

test("groupConversations q= filters by name and by message text", () => {
  const now = Date.now();
  const messages = [
    { id: "a1", chat: "a@s.whatsapp.net", fromMe: true, sender: null, text: "", tsMs: now - 2000, pushName: null },
    { id: "a2", chat: "a@s.whatsapp.net", fromMe: false, sender: "a@s.whatsapp.net", text: "premium package?", tsMs: now - 1000, pushName: "Ada Okafor" },
    { id: "b1", chat: "b@s.whatsapp.net", fromMe: true, sender: null, text: "", tsMs: now - 2000, pushName: null },
    { id: "b2", chat: "b@s.whatsapp.net", fromMe: false, sender: "b@s.whatsapp.net", text: "see you tomorrow", tsMs: now - 1000, pushName: "Ben Carter" },
  ];
  const chats = new Map([
    ["a@s.whatsapp.net", meta("a@s.whatsapp.net")],
    ["b@s.whatsapp.net", meta("b@s.whatsapp.net")],
  ]);
  const byText = groupConversations({ messages, chats }, { q: "premium" });
  assert.deepEqual(byText.map((c) => c.id), ["a@s.whatsapp.net"], "message text matches");
  const byName = groupConversations({ messages, chats }, { q: "ben" });
  assert.deepEqual(byName.map((c) => c.id), ["b@s.whatsapp.net"], "contact name matches");
  const none = groupConversations({ messages, chats }, { q: "zzz" });
  assert.equal(none.length, 0, "no match -> empty list");
  const all = groupConversations({ messages, chats }, { q: "" });
  assert.equal(all.length, 2, "empty q keeps everything");
});