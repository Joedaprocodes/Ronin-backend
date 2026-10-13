// Redirect the project's @whiskeysockets/baileys imports to the in-memory stub
import "./helpers/loader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { WhatsAppConnection } = await import("../src/whatsapp/connection.js");
const { createMediaStore } = await import("../src/media/store.js");
const { __reset, __sockets, __setGroupMetas } = await import("./helpers/baileys-stub.mjs");

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