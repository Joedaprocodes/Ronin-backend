// Redirect the project's @whiskeysockets/baileys imports to the in-memory stub
import "./helpers/loader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { WhatsAppConnection } = await import("../src/whatsapp/connection.js");
const { createMediaStore } = await import("../src/media/store.js");
const { __reset, __sockets, __setGroupMetas, __downloadCalls, DEF_MEDIA_HOST } = await import(
  "./helpers/baileys-stub.mjs"
);

const tick = () => new Promise((r) => setTimeout(r, 5));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 2000, step = 5) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(step);
  }
}

function makeAuth(creds = {}) {
  const state = { cleared: 0 };
  return {
    state,
    load: async () => ({ state: { creds, keys: {} }, saveCreds: async () => {} }),
    clear: async () => {
      state.cleared++;
    },
  };
}

function openConnection(wa) {
  return new Promise((resolve) => {
    wa.once("ready", () => resolve());
    const sock = __sockets().at(-1);
    sock.ev.emit("connection.update", { connection: "open" });
  });
}

test("start() connects and emits ready/open", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth() });
  const states = [];
  wa.on("state", (s) => states.push(s));

  await wa.start();
  assert.equal(states[0], "connecting");
  await openConnection(wa);
  assert.equal(wa.getStatus().state, "open");
  assert.deepEqual(wa.getStatus().user, { id: "1234@s.whatsapp.net", name: "Tester" });
});

test("messages.upsert de-duplicates and extracts text", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth() });
  await wa.start();
  await openConnection(wa);

  const seen = [];
  wa.on("message", (m) => seen.push(m));
  const mk = (id, message) => ({
    key: { id, remoteJid: "111@s.whatsapp.net", fromMe: false },
    message,
  });
  __sockets().at(-1).ev.emit("messages.upsert", {
    type: "notify",
    messages: [mk("A", { conversation: "hi" }), mk("A", { conversation: "hi" }), mk("B", { imageMessage: { caption: "pic" } })],
  });
  await tick(); // the upsert handler awaits media detection before emitting
  assert.equal(seen.length, 2, "duplicate id should be dropped");
  assert.equal(seen[0].text, "hi");
  assert.equal(seen[1].text, "pic");
});

test("messages.upsert captures the quoted reply snapshot", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth() });
  await wa.start();
  await openConnection(wa);

  const seen = [];
  wa.on("message", (m) => seen.push(m));
  __sockets().at(-1).ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "Q", remoteJid: "111@s.whatsapp.net", fromMe: false },
        message: {
          extendedTextMessage: {
            text: "sure",
            contextInfo: {
              stanzaId: "ORIG",
              participant: "111@s.whatsapp.net",
              quotedMessage: { conversation: "are you there?" },
            },
          },
        },
      },
    ],
  });
  await tick();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].quoted, {
    id: "ORIG",
    text: "are you there?",
    sender: "111@s.whatsapp.net",
    fromMe: false,
  });
});

test("sendMessage snapshots an outgoing quoted reply", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth() });
  await wa.start();
  await openConnection(wa);

  const target = {
    key: { id: "ORIG", remoteJid: "111@s.whatsapp.net", fromMe: false },
    message: { conversation: "original" },
  };
  const res = await wa.sendMessage("111@s.whatsapp.net", { text: "re" }, null, {
    quoted: target,
  });
  assert.deepEqual(res.persisted.quoted, { id: "ORIG", text: "original" });
});

test("stop() ends the socket, waits, and reaches closed", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth() });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  await wa.stop();
  assert.equal(sock.ended, true, "end() should be called");
  assert.equal(wa.getStatus().state, "closed");
  assert.equal(wa.sock, null);
});

test("resolveJid caches lookups and sendMessage uses it", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth() });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  const a = await wa.resolveJid("15551230000");
  const b = await wa.resolveJid("15551230000");
  assert.equal(a, b);
  assert.equal(sock.onWhatsAppCalls, 1, "second lookup should hit the cache");

  const sent = await wa.sendText("15551230000", "yo");
  assert.equal(sent.message.text, "yo");
  assert.ok(sent.key.id, "sent message carries a key id");
});

test("auto pairing emits a code once and refreshes after TTL", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth(), phoneNumber: "15551230000" });
  const codes = [];
  wa.on("pairing_code", (c) => codes.push(c));

  await wa.start();
  const sock = __sockets().at(-1);
  sock.ev.emit("connection.update", { qr: "QR1" });
  await tick();
  assert.equal(codes.length, 1, "first QR should request a code");

  sock.ev.emit("connection.update", { qr: "QR2" });
  await tick();
  assert.equal(codes.length, 1, "a fresh QR within the TTL must not re-request");

  wa.pairingCodeAt = 0; // simulate the code expiring
  sock.ev.emit("connection.update", { qr: "QR3" });
  await tick();
  assert.equal(codes.length, 2, "an expired code should be refreshed");
});

test("loggedOut clears the session and relinks", async () => {
  __reset();
  const auth = makeAuth();
  const wa = new WhatsAppConnection({ auth });
  const events = [];
  wa.on("logged_out", () => events.push("logged_out"));

  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);
  sock.ev.emit("connection.update", {
    connection: "close",
    lastDisconnect: { error: { output: { statusCode: 401 } } }, // loggedOut
  });
  await tick();
  assert.equal(wa.getStatus().state, "logged_out");
  assert.equal(auth.state.cleared, 1, "session should be wiped");
  assert.deepEqual(events, ["logged_out"]);
});

test("logout() with no socket wipes the stored session", async () => {
  const auth = makeAuth();
  const wa = new WhatsAppConnection({ auth });
  await wa.logout();
  assert.equal(auth.state.cleared, 1);
});

test("start() failure emits failure and schedules a retry", async () => {
  const auth = { load: async () => { throw new Error("db down"); }, clear: async () => {} };
  const wa = new WhatsAppConnection({ auth });
  const failures = [];
  wa.on("failure", (e) => failures.push(e.message));

  await wa.start().catch(() => {});
  assert.ok(failures.includes("db down"), "failure should be emitted");
  assert.ok(wa.reconnectTimer, "a retry should be scheduled");
  await wa.stop(); // clear the timer
});

test("messages.upsert persists every message to the store in order", async () => {
  __reset();
  const auth = makeAuth();
  const saved = [];
  const store = {
    save: async (m) => {
      await sleep(2); // simulate latency to prove ordering is maintained
      saved.push(m);
    },
  };
  const wa = new WhatsAppConnection({ auth, messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  const mk = (id, chat, conversation, fromMe = false) => ({
    key: { id, remoteJid: chat, fromMe, participant: chat === "grp@g.us" ? "999@s.whatsapp.net" : undefined },
    pushName: "Alice",
    message: { conversation },
  });
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [mk("1", "123@s.whatsapp.net", "first"), mk("2", "grp@g.us", "second")],
  });
  sock.ev.emit("messages.upsert", { type: "notify", messages: [mk("1", "123@s.whatsapp.net", "dup")] });

  await waitFor(() => saved.length >= 2);
  assert.equal(saved.length, 2, "only unique messages are saved");

  assert.equal(saved[0].id, "1");
  assert.equal(saved[0].chat, "123@s.whatsapp.net");
  assert.equal(saved[0].fromMe, false);
  assert.equal(saved[0].text, "first");
  assert.equal(saved[0].raw.message.conversation, "first", "raw Baileys message passed along");

  assert.equal(saved[1].id, "2");
  assert.equal(saved[1].chat, "grp@g.us");
  assert.equal(saved[1].isGroup, true);
  assert.equal(saved[1].sender, "999@s.whatsapp.net");
});

test("messages.upsert ignores WhatsApp Channel traffic entirely", async () => {
  __reset();
  const saved = [];
  const store = { save: async (m) => saved.push(m) };
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  await openConnection(wa);

  const seen = [];
  wa.on("message", (m) => seen.push(m));
  __sockets().at(-1).ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "chan-1", remoteJid: "120363000000000000@newsletter" },
        message: { imageMessage: { caption: "channel post" } },
      },
      {
        key: { id: "dm-1", remoteJid: "111@s.whatsapp.net", fromMe: false },
        message: { conversation: "hello" },
      },
    ],
  });
  await waitFor(() => saved.length >= 1);
  await tick();
  assert.equal(saved.length, 1, "only the DM is persisted");
  assert.equal(saved[0].id, "dm-1");
  assert.deepEqual(seen.map((m) => m.id), ["dm-1"], "no event for channel traffic");
  assert.equal(__downloadCalls.length, 0, "channel media is never downloaded");
});

test("store.save failures surface as failure events without crashing", async () => {
  __reset();
  const auth = makeAuth();
  const store = {
    save: async () => {
      throw new Error("db down");
    },
  };
  const wa = new WhatsAppConnection({ auth, messageStore: store });
  const failures = [];
  wa.on("failure", (e) => failures.push(e.message));

  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { id: "x", remoteJid: "123@s.whatsapp.net" }, message: { conversation: "hi" } }],
  });

  await waitFor(() => failures.length >= 1);
  assert.deepEqual(failures, ["db down"]);

  // the chain must still work after a failure
  const saved = [];
  wa.messageStore = { save: async (m) => saved.push(m.id) };
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { id: "y", remoteJid: "123@s.whatsapp.net" }, message: { conversation: "yo" } }],
  });
  await waitFor(() => saved.length >= 1);
  assert.deepEqual(saved, ["y"]);
});

test("no messageStore -> no persistence calls", async () => {
  __reset();
  const auth = makeAuth();
  let saved = 0;
  const store = { save: async () => saved++ };
  const wa = new WhatsAppConnection({ auth }); // no store on purpose
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [{ key: { id: "z", remoteJid: "123@s.whatsapp.net" }, message: { conversation: "hi" } }],
  });
  await tick();
  assert.equal(saved, 0);
});

test("sent messages persist immediately without waiting for the echo", async () => {
  __reset();
  const auth = makeAuth();
  const saved = [];
  const store = { save: async (m) => saved.push(m) };
  const wa = new WhatsAppConnection({ auth, messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  const result = await wa.sendText("15551230000", "hello", "sender@gmail.com");
  const id = result.key.id;
  assert.ok(id, "sent message has a key id");

  // No echo anywhere — the send itself must persist the outgoing message.
  await waitFor(() => saved.length >= 1);
  assert.equal(saved[0].id, id);
  assert.equal(saved[0].chat, "15551230000@s.whatsapp.net", "resolved jid is stored");
  assert.equal(saved[0].fromMe, true);
  assert.equal(saved[0].text, "hello");
  assert.equal(saved[0].senderEmail, "sender@gmail.com", "email persisted at send time");

  // A delayed echo from WhatsApp must not duplicate the row.
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id, remoteJid: "15551230000@s.whatsapp.net", fromMe: true },
        pushName: null,
        message: { conversation: "hello" },
      },
    ],
  });
  await tick();
  assert.equal(saved.length, 1, "the echo is deduped, no second save");
});

test("media captions persist as the sent message text", async () => {
  __reset();
  const auth = makeAuth();
  const saved = [];
  const store = { save: async (m) => saved.push(m) };
  const wa = new WhatsAppConnection({ auth, messageStore: store });
  await wa.start();
  await openConnection(wa);

  await wa.sendMessage("15551230000", { image: Buffer.from("abc"), caption: "look at that" }, "jane@gmail.com");
  await waitFor(() => saved.length >= 1);
  assert.equal(saved[0].text, "look at that", "caption is stored as the message text");
  assert.equal(saved[0].senderEmail, "jane@gmail.com", "email persisted for media sends too");
  assert.equal(saved[0].media, null, "no media ref when no media store is configured");
});

test("sendMessage awaits persistence and exposes the persisted message", async () => {
  __reset();
  const auth = makeAuth();
  let committed = false;
  const saved = [];
  const store = {
    save: async (m) => {
      await sleep(5); // simulate a slow write
      committed = true;
      saved.push(m);
    },
  };
  const wa = new WhatsAppConnection({ auth, messageStore: store });
  await wa.start();
  await openConnection(wa);

  let sendReturned;
  const result = await wa.sendText("15551230000", "deterministic", "a@gmail.com");
  sendReturned = true;

  assert.equal(sendReturned, true);
  assert.equal(committed, true, "the save committed before sendMessage resolved");
  assert.equal(saved.length, 1);
  assert.equal(result.persisted.text, "deterministic", "the persisted message is returned");
  assert.equal(result.persisted.fromMe, true);
  assert.equal(result.persisted.senderEmail, "a@gmail.com");
  assert.equal(result.key.id, result.persisted.id);
  assert.equal(typeof result.message, "object", "the Baileys content is preserved on the result");
});

test("outgoing messages emit a message event (feeds realtime consumers)", async () => {
  __reset();
  const auth = makeAuth();
  const wa = new WhatsAppConnection({ auth });
  const events = [];
  wa.on("message", (m) => events.push(m));
  await wa.start();
  await openConnection(wa);

  const result = await wa.sendText("15551230000", "realtime me");
  assert.equal(events.length, 1, "send triggers exactly one message event");
  assert.equal(events[0].id, result.persisted.id);
  assert.equal(events[0].chat, "15551230000@s.whatsapp.net");
  assert.equal(events[0].fromMe, true);
  assert.equal(events[0].text, "realtime me");

  // A delayed echo must not emit again (id already handled).
  __sockets().at(-1).ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: result.persisted.id, remoteJid: "15551230000@s.whatsapp.net", fromMe: true },
        pushName: null,
        message: { conversation: "realtime me" },
      },
    ],
  });
  await tick();
  assert.equal(events.length, 1, "echo is deduped");
});

test("outgoing media bytes are stored via the media store and referenced by key", async () => {
  __reset();
  const auth = makeAuth();
  const dir = mkdtempSync(join(tmpdir(), "wa-media-"));
  const mediaStore = createMediaStore({ dir });
  const stored = [];
  const store = { save: async (m) => stored.push(m) };
  const wa = new WhatsAppConnection({ auth, messageStore: store, mediaStore });
  await wa.start();
  await openConnection(wa);

  const bytes = Buffer.from("jpegbytes");
  const result = await wa.sendMessage("15551230000", {
    image: bytes,
    caption: "hi",
    mimetype: "image/jpeg",
  });
  const ref = result.persisted.media;
  assert.equal(ref.key, result.persisted.id, "stored under the message id");
  assert.equal(ref.type, "image");
  assert.equal(ref.mimeType, "image/jpeg");
  assert.deepEqual(readFileSync(join(dir, ref.key)), bytes, "bytes on disk");
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, `${ref.key}.json`), "utf-8")),
    { type: "image", mimeType: "image/jpeg", fileName: null },
    "sidecar metadata written"
  );
  assert.equal(result.persisted.text, "hi");
});

test("incoming media is downloaded, stored and persisted with the message", async () => {
  __reset();
  const auth = makeAuth();
  const dir = mkdtempSync(join(tmpdir(), "wa-media-"));
  const saved = [];
  const wa = new WhatsAppConnection({
    auth,
    messageStore: { save: async (m) => saved.push(m) },
    mediaStore: createMediaStore({ dir }),
  });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "in-media-1", remoteJid: "123@s.whatsapp.net", fromMe: false },
        pushName: "Ada",
        message: { imageMessage: { caption: "pic!", mimetype: "image/jpeg", url: "https://x/img" } },
      },
    ],
  });
  await waitFor(() => saved.length >= 1);
  const m = saved[0];
  assert.equal(m.id, "in-media-1");
  assert.equal(m.media.key, "in-media-1", "stored under the message id");
  assert.equal(m.media.type, "image");
  assert.equal(m.media.mimeType, "image/jpeg");
  assert.equal(m.media.fileName, null);
  // stub downloadMediaMessage returns `${kind}:${caption}`
  assert.deepEqual(readFileSync(join(dir, "in-media-1")), Buffer.from("imageMessage:pic!"));
});

test("incoming stickers are stored under the sticker bucket (not image)", async () => {
  __reset();
  const auth = makeAuth();
  const dir = mkdtempSync(join(tmpdir(), "wa-media-"));
  const saved = [];
  const wa = new WhatsAppConnection({
    auth,
    messageStore: { save: async (m) => saved.push(m) },
    mediaStore: createMediaStore({ dir }),
  });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "in-sticker-1", remoteJid: "123@s.whatsapp.net", fromMe: false },
        pushName: "Ada",
        message: { stickerMessage: { mimetype: "image/webp", url: "https://x/st" } },
      },
    ],
  });
  await waitFor(() => saved.length >= 1);
  const m = saved[0];
  assert.equal(m.id, "in-sticker-1");
  assert.equal(m.media.type, "sticker");
  assert.equal(m.media.mimeType, "image/webp");
  // stub downloadMediaMessage returns `${kind}:${url}`
  assert.deepEqual(readFileSync(join(dir, "in-sticker-1")), Buffer.from("stickerMessage:https://x/st"));
});

test("the a.whatsapp.net placeholder host is swapped for the default media CDN", async () => {
  __reset();
  const auth = makeAuth();
  const dir = mkdtempSync(join(tmpdir(), "wa-media-"));
  const saved = [];
  const wa = new WhatsAppConnection({
    auth,
    messageStore: { save: async (m) => saved.push(m) },
    mediaStore: createMediaStore({ dir }),
  });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  // WhatsApp stamps stickers (and some other media) with this host, which does
  // not resolve; Baileys would prefer it over its own default and the download
  // would fail with ENOTFOUND, leaving the message without media.
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "in-sticker-lid", remoteJid: "123@s.whatsapp.net", fromMe: false },
        pushName: "Ada",
        message: {
          stickerMessage: {
            mimetype: "image/webp",
            url: "https://a.whatsapp.net",
            directPath: "/v/t62.15575-24/845679714_n.enc?ccb=11-4",
            mediaKey: "WkzRJB+6YXQmXxAfinJgulHT/Jb0ZC3udcMFFT4zFVM=",
          },
          messageContextInfo: { messageSecret: "s3cret" },
        },
      },
    ],
  });
  await waitFor(() => saved.length >= 1);

  assert.deepEqual(__downloadCalls.at(-1), { host: DEF_MEDIA_HOST }, "fetched from the real CDN");
  assert.equal(DEF_MEDIA_HOST, "mmg.whatsapp.net");
  const m = saved[0];
  assert.equal(m.media.type, "sticker", "media stored despite the placeholder host");
  assert.equal(m.media.mimeType, "image/webp");
  assert.deepEqual(
    readFileSync(join(dir, "in-sticker-lid")),
    Buffer.from("stickerMessage:https://a.whatsapp.net")
  );
});

test("a resolvable media host is passed through untouched", async () => {
  __reset();
  const auth = makeAuth();
  const saved = [];
  const wa = new WhatsAppConnection({
    auth,
    messageStore: { save: async (m) => saved.push(m) },
    mediaStore: createMediaStore({ dir: mkdtempSync(join(tmpdir(), "wa-media-")) }),
  });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "in-media-cdn", remoteJid: "123@s.whatsapp.net", fromMe: false },
        message: {
          imageMessage: {
            caption: "hi",
            mimetype: "image/jpeg",
            url: `https://${DEF_MEDIA_HOST}/v/t62/abc.enc`,
            directPath: "/v/t62/abc.enc",
          },
        },
      },
    ],
  });
  await waitFor(() => saved.length >= 1);

  assert.deepEqual(__downloadCalls.at(-1), {}, "no host override for a real host");
  assert.equal(saved[0].media.type, "image");
});

test("outgoing stickers persist under the sticker bucket", async () => {
  __reset();
  const auth = makeAuth();
  const dir = mkdtempSync(join(tmpdir(), "wa-media-"));
  const stored = [];
  const wa = new WhatsAppConnection({
    auth,
    messageStore: { save: async (m) => stored.push(m) },
    mediaStore: createMediaStore({ dir }),
  });
  await wa.start();
  await openConnection(wa);

  const bytes = Buffer.from("webpbytes");
  const result = await wa.sendMessage("15551230000", {
    sticker: bytes,
    mimetype: "image/webp",
  });
  const ref = result.persisted.media;
  assert.equal(ref.type, "sticker");
  assert.equal(ref.mimeType, "image/webp");
  assert.equal(result.persisted.text, null, "stickers carry no text");
  assert.deepEqual(readFileSync(join(dir, ref.key)), bytes, "bytes on disk");
});

/** Minimal in-memory message store the connection's edit/revoke paths write to. */
function makeMemoryStore() {
  const rows = new Map();
  return {
    rows,
    save: async (m) => {
      if (rows.has(m.id)) return;
      rows.set(m.id, {
        id: m.id,
        chat: m.chat,
        fromMe: Boolean(m.fromMe),
        sender: m.sender ?? null,
        text: m.text ?? null,
        tsMs: m.receivedAt ?? Date.now(),
        deleted: false,
        edited: false,
        reactions: {},
        system: m.system ?? m.raw?.system ?? null,
        rawKey: m.rawKey ?? m.raw?.key ?? null,
      });
    },
    markMessageDeleted: async (chat, id) => {
      const row = rows.get(id);
      if (row) row.deleted = true;
      return Boolean(row);
    },
    updateMessageText: async (chat, id, text) => {
      const row = rows.get(id);
      if (row) {
        row.text = text;
        row.edited = true;
      }
      return Boolean(row);
    },
    setMessageReaction: async (chat, id, reactor, entry) => {
      const row = rows.get(id);
      if (!row) return null;
      const next = { ...(row.reactions ?? {}) };
      if (entry && entry.text) next[reactor] = entry;
      else delete next[reactor];
      row.reactions = next;
      return next;
    },
    getMessageRaw: async (chat, id) => {
      const row = rows.get(id);
      if (!row) return null;
      return {
        id: row.id,
        chat: row.chat,
        fromMe: row.fromMe,
        key: row.rawKey,
        deleted: row.deleted,
      };
    },
    getMessage: async (chat, id) => rows.get(id) ?? null,
  };
}

test("deleteMessage/editMessage send the right Baileys content", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth() });
  await wa.start();
  await openConnection(wa);
  const sock = __sockets().at(-1);

  const key = { id: "m1", remoteJid: "123@s.whatsapp.net", fromMe: true };
  await wa.deleteMessage("123@s.whatsapp.net", key);
  await wa.editMessage("123@s.whatsapp.net", key, "new text");

  assert.equal(sock.sent.length, 2);
  assert.deepEqual(sock.sent[0].content, { delete: key });
  assert.deepEqual(sock.sent[1].content, { text: "new text", edit: key });
});

test("editMessage rejects empty text and a missing key", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth() });
  await wa.start();
  await openConnection(wa);
  await assert.rejects(() => wa.editMessage("123@s.whatsapp.net", { id: "m1" }, "   "), /empty/);
  await assert.rejects(() => wa.editMessage("123@s.whatsapp.net", null, "hi"), /key/);
});

test("an incoming REVOKE protocol message tombstones the stored message", async () => {
  __reset();
  const store = makeMemoryStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);
  const updates = [];
  wa.on("message:update", (m) => updates.push(m));

  await store.save({ id: "m1", chat: "123@s.whatsapp.net", fromMe: false, sender: "123@s.whatsapp.net", text: "hi" });
  store.rows.get("m1").tsMs = Date.now();

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "rev-1", remoteJid: "123@s.whatsapp.net", fromMe: false },
        message: { protocolMessage: { type: 0, key: { id: "m1", remoteJid: "123@s.whatsapp.net" } } },
      },
    ],
  });
  await waitFor(() => store.rows.get("m1")?.deleted);
  assert.equal(store.rows.get("m1").deleted, true, "flagged deleted");
  assert.equal(store.rows.size, 1, "the protocol message itself was not stored");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, "m1");
  assert.equal(updates[0].deleted, true);
});

test("an incoming MESSAGE_EDIT protocol message updates the stored text", async () => {
  __reset();
  const store = makeMemoryStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);
  const updates = [];
  wa.on("message:update", (m) => updates.push(m));

  await store.save({ id: "m1", chat: "123@s.whatsapp.net", fromMe: false, sender: "123@s.whatsapp.net", text: "hi" });
  store.rows.get("m1").tsMs = Date.now();

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "edit-1", remoteJid: "123@s.whatsapp.net", fromMe: false },
        message: {
          protocolMessage: {
            type: 14,
            key: { id: "m1", remoteJid: "123@s.whatsapp.net" },
            editedMessage: { conversation: "edited text" },
          },
        },
      },
    ],
  });
  await waitFor(() => store.rows.get("m1")?.edited);
  assert.equal(store.rows.get("m1").text, "edited text");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].text, "edited text");
  assert.equal(updates[0].edited, true);
});

test("a messages.update revoke (message: null) tombstones the stored message", async () => {
  __reset();
  const store = makeMemoryStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  await store.save({ id: "m1", chat: "123@s.whatsapp.net", fromMe: false, sender: "123@s.whatsapp.net", text: "hi" });
  store.rows.get("m1").tsMs = Date.now();

  sock.ev.emit("messages.update", [
    { key: { id: "m1", remoteJid: "123@s.whatsapp.net" }, update: { message: null } },
  ]);
  await waitFor(() => store.rows.get("m1")?.deleted);
  assert.equal(store.rows.get("m1").deleted, true);
});

test("messages.reaction stores and clears reactions without new traffic", async () => {
  __reset();
  const store = makeMemoryStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);
  const updates = [];
  const messages = [];
  wa.on("message:update", (m) => updates.push(m));
  wa.on("message", (m) => messages.push(m));

  await store.save({
    id: "m1",
    chat: "123@s.whatsapp.net",
    fromMe: false,
    sender: "123@s.whatsapp.net",
    text: "hi",
  });

  sock.ev.emit("messages.reaction", [
    {
      key: { id: "m1", remoteJid: "123@s.whatsapp.net" },
      reaction: {
        text: "👍",
        key: { remoteJid: "123@s.whatsapp.net", fromMe: false, id: "r1" },
        senderTimestampMs: 111,
      },
    },
  ]);
  await waitFor(() => updates.length >= 1);
  assert.deepEqual(store.rows.get("m1").reactions["123@s.whatsapp.net"], {
    text: "👍",
    at: 111,
  });
  assert.equal(updates[0].reactions["123@s.whatsapp.net"].text, "👍");

  // An empty text removes that reactor's reaction again.
  sock.ev.emit("messages.reaction", [
    {
      key: { id: "m1", remoteJid: "123@s.whatsapp.net" },
      reaction: { text: "", key: { remoteJid: "123@s.whatsapp.net", fromMe: false, id: "r2" } },
    },
  ]);
  await waitFor(() => updates.length >= 2);
  assert.deepEqual(store.rows.get("m1").reactions, {});
  assert.deepEqual(messages, [], "reactions never look like new messages");

  // A reaction to a message we never stored is ignored (no crash, no row).
  sock.ev.emit("messages.reaction", [
    {
      key: { id: "missing", remoteJid: "123@s.whatsapp.net" },
      reaction: { text: "🔥", key: { remoteJid: "123@s.whatsapp.net", fromMe: false, id: "r3" } },
    },
  ]);
  await tick();
  assert.equal(store.rows.size, 1);
  assert.equal(updates.length, 2);
});

test("a reactionMessage arriving via upsert is applied, not stored as a message", async () => {
  __reset();
  const store = makeMemoryStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);
  const updates = [];
  wa.on("message:update", (m) => updates.push(m));

  await store.save({
    id: "m1",
    chat: "123@s.whatsapp.net",
    fromMe: false,
    sender: "123@s.whatsapp.net",
    text: "hi",
  });

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "react-msg-1", remoteJid: "123@s.whatsapp.net", fromMe: false },
        message: {
          reactionMessage: {
            key: { id: "m1", remoteJid: "123@s.whatsapp.net" },
            text: "🎉",
          },
        },
      },
    ],
  });
  await waitFor(() => updates.length >= 1);
  assert.equal(store.rows.get("m1").reactions["123@s.whatsapp.net"].text, "🎉");
  assert.equal(store.rows.size, 1, "the reaction never becomes its own message row");
});

test("sendReaction sends the Baileys react payload and writes it to the store", async () => {
  __reset();
  const store = makeMemoryStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  await openConnection(wa);
  const sock = __sockets().at(-1);

  await store.save({
    id: "m1",
    chat: "123@s.whatsapp.net",
    fromMe: false,
    sender: "123@s.whatsapp.net",
    text: "hi",
    raw: { key: { id: "m1", remoteJid: "123@s.whatsapp.net", fromMe: false } },
  });

  await wa.sendReaction("123@s.whatsapp.net", "m1", "❤️");
  assert.equal(sock.sent.length, 1);
  assert.deepEqual(sock.sent[0].content, {
    react: { text: "❤️", key: { id: "m1", remoteJid: "123@s.whatsapp.net", fromMe: false } },
  });
  assert.equal(store.rows.get("m1").reactions.me.text, "❤️");

  // Clearing sends an empty text and drops our entry.
  await wa.sendReaction("123@s.whatsapp.net", "m1", "");
  assert.deepEqual(sock.sent[1].content.react.text, "");
  assert.deepEqual(store.rows.get("m1").reactions, {});

  await assert.rejects(() => wa.sendReaction("123@s.whatsapp.net", "nope", "👍"), /not found/);
});

test("group-participants.update becomes a persisted system line", async () => {
  __reset();
  const store = makeMemoryStore();
  store.resolveChatName = async (jid) => (jid === "999@s.whatsapp.net" ? "Alice" : null);
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);
  const updates = [];
  const messages = [];
  wa.on("message:update", (m) => updates.push(m));
  wa.on("message", (m) => messages.push(m));

  sock.ev.emit("group-participants.update", {
    id: "grp@g.us",
    author: "999@s.whatsapp.net",
    participants: [
      { id: "555@s.whatsapp.net", notify: "Bob" },
      { id: "666@s.whatsapp.net", notify: "Carol" },
    ],
    action: "add",
  });

  await waitFor(() => updates.length >= 1);
  const row = [...store.rows.values()].find((r) => r.system);
  assert.ok(row, "system row stored");
  assert.equal(row.chat, "grp@g.us");
  assert.equal(row.fromMe, false);
  assert.equal(row.text, "Alice added Bob and Carol");
  assert.deepEqual(row.system, {
    action: "add",
    actor: "999@s.whatsapp.net",
    participants: ["555@s.whatsapp.net", "666@s.whatsapp.net"],
  });
  assert.equal(updates[0].system.action, "add");
  assert.equal(store.rows.size, 1);
  // Never announced as new traffic, so auto-replies/guards ignore it.
  assert.deepEqual(messages, []);
});

test("membership lines phrase remove, leave, promote and demote correctly", async () => {
  __reset();
  const store = makeMemoryStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);
  const updates = [];
  wa.on("message:update", (m) => updates.push(m));

  const emit = (update) => sock.ev.emit("group-participants.update", update);
  const waitForCount = (n) => waitFor(() => updates.length >= n);

  emit({
    id: "grp@g.us",
    author: "999@s.whatsapp.net",
    authorUsername: "alice",
    participants: [{ id: "555@s.whatsapp.net", notify: "Bob" }],
    action: "remove",
  });
  await waitForCount(1);

  emit({
    id: "grp@g.us",
    author: "1234@s.whatsapp.net",
    participants: [{ id: "666@s.whatsapp.net", notify: "Carol" }],
    action: "remove",
  });
  await waitForCount(2);

  emit({
    id: "grp@g.us",
    author: "555@s.whatsapp.net",
    participants: [{ id: "555@s.whatsapp.net", notify: "Bob" }],
    action: "remove",
  });
  await waitForCount(3);

  emit({
    id: "grp@g.us",
    author: "1234@s.whatsapp.net",
    participants: [{ id: "777@s.whatsapp.net", notify: "Dan" }],
    action: "promote",
  });
  await waitForCount(4);

  emit({
    id: "grp@g.us",
    author: "1234@s.whatsapp.net",
    participants: [{ id: "777@s.whatsapp.net", notify: "Dan" }],
    action: "demote",
  });
  await waitForCount(5);

  assert.deepEqual(
    updates.map((u) => u.text),
    [
      "alice removed Bob",
      "You removed Carol",
      "Bob left",
      "You promoted Dan to admin",
      "You demoted Dan",
    ]
  );
});

test("a failed media download never drops the message (media stays null)", async () => {
  __reset();
  const auth = makeAuth();
  const saved = [];
  const failures = [];
  const wa = new WhatsAppConnection({
    auth,
    messageStore: { save: async (m) => saved.push(m) },
    mediaStore: createMediaStore({ dir: mkdtempSync(join(tmpdir(), "wa-media-")) }),
  });
  wa.on("failure", (e) => failures.push(e.message));
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "in-fail", remoteJid: "123@s.whatsapp.net", fromMe: false },
        message: { imageMessage: { url: "fail" } }, // stub throws for url === "fail"
      },
    ],
  });
  await waitFor(() => saved.length >= 1);
  assert.equal(saved[0].id, "in-fail");
  assert.equal(saved[0].media, null, "message saved regardless of download failure");
  assert.ok(failures.includes("download failed"), "failure surfaced over the event");
});

test("incoming messages have no sender email", async () => {
  __reset();
  const auth = makeAuth();
  const saved = [];
  const store = { save: async (m) => saved.push(m) };
  const wa = new WhatsAppConnection({ auth, messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "inc-1", remoteJid: "123@s.whatsapp.net", fromMe: false },
        message: { conversation: "hey" },
      },
    ],
  });
  await waitFor(() => saved.length >= 1);
  assert.equal(saved[0].senderEmail, null, "incoming senders have no known email");
});

/* ------------------------------------------------------------------ */
/*  Identity: one chat per person (LID <-> phone number)               */
/* ------------------------------------------------------------------ */

const LID = "225159969521788@lid";
const PN = "2348052928072@s.whatsapp.net";

/** Minimal store exposing just the identity hooks the connection calls. */
function identityStore({ saved = [], merged = [], names = [] } = {}) {
  return {
    saved,
    merged,
    names,
    save: async (m) => saved.push(m),
    canonicalizeChat: async (alias, canonical) => {
      merged.push([alias, canonical]);
      return canonical;
    },
    resolveChatJid: async (jid) => jid,
    setChatName: async (jid, name, username) => names.push([jid, name, username]),
  };
}

test("incoming LID messages canonicalize the chat and record the alias once", async () => {
  __reset();
  const store = identityStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  const seen = [];
  wa.on("message", (m) => seen.push(m));
  const incoming = (id) => ({
    key: { id, remoteJid: LID, remoteJidAlt: PN, fromMe: false },
    pushName: "Ada",
    message: { conversation: "hey" },
  });
  sock.ev.emit("messages.upsert", { type: "notify", messages: [incoming("lid-1")] });
  await waitFor(() => store.saved.length >= 1);

  assert.equal(seen[0].chat, LID, "message is attached to the LID chat");
  assert.equal(seen[0].sender, LID, "1:1 sender matches the canonical chat");
  assert.equal(store.saved[0].chat, LID);
  assert.deepEqual(store.merged, [[PN, LID]], "the phone number is folded onto the LID");

  sock.ev.emit("messages.upsert", { type: "notify", messages: [incoming("lid-2")] });
  await waitFor(() => store.saved.length >= 2);
  assert.equal(store.merged.length, 1, "the same pair is only folded once per process");
});

test("contacts.upsert stores the saved name and folds lid/pn together", async () => {
  __reset();
  const store = identityStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("contacts.upsert", [
    { id: PN, lid: LID, name: "Ada Lovelace", username: "ada" },
    { id: "15550000000@s.whatsapp.net", name: "Bob" },
  ]);
  await waitFor(() => store.names.length >= 2);

  assert.deepEqual(store.merged, [[PN, LID]]);
  assert.deepEqual(store.names, [
    [LID, "Ada Lovelace", "ada"],
    ["15550000000@s.whatsapp.net", "Bob", ""],
  ]);
});

test("contacts.update only learns pairs, never overwrites the saved name", async () => {
  __reset();
  const store = identityStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("contacts.update", [{ id: PN, notify: "pushed name" }]);
  await tick();
  assert.deepEqual(store.names, [], "profile (notify) names are ignored");
  assert.deepEqual(store.merged, []);
});

test("lid-mapping.update folds the announced pair together", async () => {
  __reset();
  const store = identityStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("lid-mapping.update", { lid: LID, pn: PN });
  await waitFor(() => store.merged.length >= 1);
  assert.deepEqual(store.merged, [[PN, LID]]);
});

test("the account's own LID/PN pair is folded at startup (self-chats merge)", async () => {
  __reset();
  const store = identityStore();
  const me = {
    id: "2348146858279:11@s.whatsapp.net",
    lid: "50153088094314:11@lid",
    name: "Joshua",
  };
  const wa = new WhatsAppConnection({ auth: makeAuth({ me }), messageStore: store });

  await wa.start();
  // Folded from creds.me alone: no open socket and no remoteJidAlt required.
  await waitFor(() => store.merged.length >= 1);
  assert.deepEqual(store.merged, [["2348146858279@s.whatsapp.net", "50153088094314@lid"]]);
});

test("self-identity fold is a no-op without a LID", async () => {
  __reset();
  const store = identityStore();
  const me = { id: "2348146858279:11@s.whatsapp.net", name: "Joshua" };
  const wa = new WhatsAppConnection({ auth: makeAuth({ me }), messageStore: store });

  await wa.start();
  await tick();
  assert.deepEqual(store.merged, []);
});

test("outgoing sends are stored under the recipient's canonical chat", async () => {
  __reset();
  const saved = [];
  const store = {
    save: async (m) => saved.push(m),
    resolveChatJid: async (jid) => (jid === "15551230000@s.whatsapp.net" ? LID : jid),
  };
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  await openConnection(wa);

  const result = await wa.sendText("15551230000", "yo");
  await waitFor(() => saved.length >= 1);
  assert.equal(result.persisted.chat, LID, "resolved PN is stored under the LID");
  assert.equal(saved[0].chat, LID);
  assert.equal(saved[0].sender, "15551230000@s.whatsapp.net", "the real recipient jid is kept");
});

test("group messages canonicalize the participant (LID preferred)", async () => {
  __reset();
  const saved = [];
  const wa = new WhatsAppConnection({
    auth: makeAuth(),
    messageStore: { save: async (m) => saved.push(m) },
  });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: {
          id: "grp-1",
          remoteJid: "123-456@g.us",
          participant: LID,
          participantAlt: PN,
          fromMe: false,
        },
        message: { conversation: "group hi" },
      },
    ],
  });
  await waitFor(() => saved.length >= 1);
  assert.equal(saved[0].isGroup, true);
  assert.equal(saved[0].chat, "123-456@g.us", "groups are never aliased");
  assert.equal(saved[0].sender, LID, "participant uses the LID form");
});

test("groups.update/upsert persist the group subject", async () => {
  __reset();
  const store = identityStore();
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  const sock = __sockets().at(-1);
  await openConnection(wa);

  sock.ev.emit("groups.update", [{ id: "123-456@g.us", subject: "Renamed" }]);
  await waitFor(() => store.names.some((n) => n[0] === "123-456@g.us"));
  assert.deepEqual(store.names.at(-1).slice(0, 2), ["123-456@g.us", "Renamed"]);

  sock.ev.emit("groups.update", [{ id: "123-456@g.us", subject: "   " }]);
  await tick();
  assert.equal(store.names.length, 1, "blank subjects are skipped");

  sock.ev.emit("groups.upsert", [{ id: "777@g.us", subject: "Fresh" }]);
  await waitFor(() => store.names.some((n) => n[0] === "777@g.us"));
  assert.deepEqual(store.names.at(-1).slice(0, 2), ["777@g.us", "Fresh"]);
});

test("opening the socket backfills group subjects", async () => {
  __reset();
  __setGroupMetas({
    "123-456@g.us": { id: "123-456@g.us", subject: "Friends" },
    "777@g.us": { id: "777@g.us" }, // no subject -> skipped
  });
  try {
    const store = identityStore();
    const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
    await wa.start();
    await openConnection(wa);

    await waitFor(() => store.names.some((n) => n[0] === "123-456@g.us"));
    assert.deepEqual(store.names.at(-1).slice(0, 2), ["123-456@g.us", "Friends"]);
    assert.equal(store.names.length, 1, "groups without a subject are skipped");
  } finally {
    __setGroupMetas({});
  }
});

test("groupMetadata proxies the open socket", async () => {
  __reset();
  __setGroupMetas({
    "123-456@g.us": { id: "123-456@g.us", subject: "Friends", size: 3, participants: [{ id: LID, admin: "admin" }] },
  });
  try {
    const wa = new WhatsAppConnection({ auth: makeAuth() });
    await wa.start();
    await openConnection(wa);

    const meta = await wa.groupMetadata("123-456@g.us");
    assert.equal(meta.subject, "Friends");
    assert.equal(meta.participants[0].id, LID);
    assert.equal(meta.participants[0].admin, "admin");
  } finally {
    __setGroupMetas({});
  }
});

test("groupMetadata throws when the socket is not open", async () => {
  __reset();
  const wa = new WhatsAppConnection({ auth: makeAuth() });
  await wa.start();
  await assert.rejects(() => wa.groupMetadata("123-456@g.us"), /not connected/);
});