// Quoted-message display: the extractor, the view mapping, and the store sidecar.
import "./helpers/loader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { extractQuoted, quotedFromTarget } = await import("../src/whatsapp/utils.js");
const { toMessageView } = await import("../src/db/inbox.js");
const { createSqliteMessageStore } = await import("../src/db/sqlite.js");

test("extractQuoted reads a text reply", () => {
  const message = {
    extendedTextMessage: {
      text: "sure",
      contextInfo: {
        stanzaId: "ORIG",
        participant: "123@s.whatsapp.net",
        quotedMessage: { conversation: "are you there?" },
      },
    },
  };
  assert.deepEqual(extractQuoted(message), {
    id: "ORIG",
    text: "are you there?",
    sender: "123@s.whatsapp.net",
    fromMe: false,
  });
});

test("extractQuoted snapshots a quoted image as a media bucket", () => {
  const message = {
    imageMessage: {
      caption: "look",
      contextInfo: {
        stanzaId: "IMG",
        quotedMessage: { imageMessage: { mimetype: "image/jpeg" } },
      },
    },
  };
  assert.deepEqual(extractQuoted(message), { id: "IMG", text: "", media: { type: "image" } });
});

test("extractQuoted marks our own quoted message via ownJid", () => {
  const message = {
    extendedTextMessage: {
      text: "re",
      contextInfo: {
        stanzaId: "MINE",
        participant: "999:2@s.whatsapp.net",
        quotedMessage: { conversation: "mine" },
      },
    },
  };
  assert.equal(extractQuoted(message, "999@s.whatsapp.net").fromMe, true);
  assert.equal(extractQuoted(message, "1234@s.whatsapp.net").fromMe, false);
});

test("extractQuoted unwraps ephemeral messages", () => {
  const message = {
    ephemeralMessage: {
      message: {
        extendedTextMessage: {
          text: "re",
          contextInfo: { stanzaId: "E", quotedMessage: { conversation: "wrapped" } },
        },
      },
    },
  };
  assert.deepEqual(extractQuoted(message), { id: "E", text: "wrapped" });
});

test("extractQuoted returns null when the message isn't a reply", () => {
  assert.equal(extractQuoted({ conversation: "hi" }), null);
  assert.equal(extractQuoted(null), null);
});

test("quotedFromTarget snapshots the send target", () => {
  const target = {
    key: { id: "T", remoteJid: "123@s.whatsapp.net", fromMe: false },
    message: { conversation: "original" },
  };
  assert.deepEqual(quotedFromTarget(target), { id: "T", text: "original" });
  assert.equal(quotedFromTarget(null), null);
});

test("toMessageView exposes quoted and names the author only in groups", () => {
  const storeView = {
    id: "m1",
    chat: "g@g.us",
    fromMe: false,
    sender: "5@s.whatsapp.net",
    text: "reply",
    tsMs: 1000,
    pushName: "Ana",
    quoted: { id: "orig", text: "hello", sender: "9@s.whatsapp.net", fromMe: false },
  };

  const group = toMessageView(storeView, true);
  assert.deepEqual(group.quoted, { id: "orig", text: "hello", sender: "9" });

  const own = toMessageView(
    { ...storeView, quoted: { id: "o2", text: "x", sender: "own@s.whatsapp.net", fromMe: true } },
    true
  );
  assert.equal(own.quoted.sender, "You");

  const dm = toMessageView(storeView, false);
  assert.deepEqual(dm.quoted, { id: "orig", text: "hello" });
});

test("toMessageView omits quoted when there is none", () => {
  const view = toMessageView(
    { id: "m", chat: "c@s.whatsapp.net", fromMe: false, text: "hi", tsMs: 1, quoted: null },
    false
  );
  assert.equal("quoted" in view, false);
});

test("sqlite store round-trips the quoted sidecar", () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  store.save({
    id: "R",
    chat: "123@s.whatsapp.net",
    isGroup: false,
    fromMe: false,
    sender: "123@s.whatsapp.net",
    text: "reply",
    senderEmail: null,
    receivedAt: 1000,
    quoted: { id: "orig", text: "quoted text", media: { type: "image" } },
    raw: { key: { id: "R" }, message: { conversation: "reply" } },
  });

  const thread = store.getMessages("123@s.whatsapp.net");
  assert.deepEqual(thread.messages[0].quoted, {
    id: "orig",
    text: "quoted text",
    media: { type: "image" },
  });
  store.close();
});
