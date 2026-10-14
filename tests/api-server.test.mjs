import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createSqliteMessageStore } from "../src/db/sqlite.js";
import { createMediaStore } from "../src/media/store.js";
import { createApiServer } from "../src/api/server.js";

const JID = "15551234567@s.whatsapp.net";

function listen(api) {
  return new Promise((resolve) => {
    api.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${api.address().port}`));
  });
}

function closeApi(api) {
  // Kill any open SSE sockets first so api.close() doesn't hang waiting.
  api.closeAllConnections?.();
  return new Promise((resolve) => api.close(resolve));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls `fn` until it returns a truthy value (or throws after `timeout`). */
async function waitFor(fn, { timeout = 4000, interval = 15 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(interval);
  }
}

function makeEventConnection() {
  const conn = new EventEmitter();
  conn.getStatus = () => ({ state: "open" });
  conn.sendMessage = async () => ({ key: { id: "x" } });
  return conn;
}

function openEvents(base, { jid, token } = {}) {
  const url = new URL("/api/events", base);
  if (jid) url.searchParams.set("jid", jid);
  if (token) url.searchParams.set("token", token);
  return fetch(url).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const queue = [];
    let pending = null;
    // Pump continuously so frames are queued as they arrive — a next() that is
    // abandoned (e.g. inside a Promise.race) can't steal a later frame.
    function pump() {
      reader.read().then(
        ({ done, value }) => {
          if (done) {
            if (pending) {
              pending.reject(new Error("stream ended"));
              pending = null;
            }
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            if (pending) {
              const p = pending;
              pending = null;
              p.resolve(frame);
            } else {
              queue.push(frame);
            }
          }
          pump();
        },
        (err) => {
          if (pending) {
            pending.reject(err);
            pending = null;
          }
        }
      );
    }
    pump();
    const next = () =>
      new Promise((resolve, reject) => {
        if (queue.length) return resolve(queue.shift());
        pending = { resolve, reject };
      });
    return {
      res,
      next,
      stop: async () => {
        try {
          await reader.cancel();
        } catch {
          /* already closed */
        }
      },
    };
  });
}

function seedMessage(over = {}) {
  return {
    id: "m1",
    chat: JID,
    isGroup: false,
    fromMe: false,
    sender: JID,
    text: "Hi, is the premium package still available?",
    receivedAt: Date.now() - 60_000,
    raw: { key: { id: "m1" }, pushName: "Ada Okafor" },
    ...over,
  };
}

/** Seeds `count` messages into one thread, 1s apart, oldest first. */
function seedThread(store, { count, jid = JID, from = 0 } = {}) {
  const baseTs = 1_700_000_000_000;
  for (let i = 0; i < count; i++) {
    store.save({
      id: `seed-${from + i}`,
      chat: jid,
      isGroup: false,
      fromMe: false,
      sender: jid,
      text: `message ${from + i}`,
      receivedAt: baseTs + (from + i) * 1000,
      raw: { key: { id: `seed-${from + i}` }, pushName: "Ada Okafor" },
    });
  }
}

test("GET /api/inbox returns lightweight conversations shaped for the inbox screen", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    await store.save(seedMessage());

    const res = await fetch(`${base}/api/inbox`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "*", "CORS header");

    const data = await res.json();
    assert.equal(data.conversations.length, 1);
    const c = data.conversations[0];
    assert.equal(c.id, JID);
    assert.equal(c.name, "Ada Okafor");
    assert.equal(c.isGroup, false);
    assert.equal(c.unread, 1);
    assert.ok(c.time, "relative time label present");
    assert.equal(Object.hasOwn(c, "messages"), false, "lightweight list: no embedded thread");
    assert.equal(c.lastMessage.from, "them");
    assert.equal(c.lastMessage.text, "Hi, is the premium package still available?");
    assert.equal(c.lastMessage.id, "m1");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("GET /api/inbox?q= searches message text and conversation name", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    await store.save(seedMessage()); // "...premium package..." from Ada Okafor

    const byText = await (await fetch(`${base}/api/inbox?q=premium`)).json();
    assert.equal(byText.conversations.length, 1, "message text matches");
    assert.equal(byText.conversations[0].name, "Ada Okafor");

    const byName = await (await fetch(`${base}/api/inbox?q=ada`)).json();
    assert.equal(byName.conversations.length, 1, "contact name matches");

    const none = await (await fetch(`${base}/api/inbox?q=zzz`)).json();
    assert.equal(none.conversations.length, 0, "no match -> empty");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("read/flag/thread endpoints and 404s work end to end", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  const jid = encodeURIComponent(JID);
  try {
    await store.save(seedMessage());
    const unread = (await (await fetch(`${base}/api/inbox`)).json()).conversations[0].unread;
    assert.equal(unread, 1);

    // mark read -> unread badge clears
    const read = await fetch(`${base}/api/inbox/${jid}/read`, { method: "POST" });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { ok: true, jid: JID, unread: 0 });
    const afterRead = (await (await fetch(`${base}/api/inbox`)).json()).conversations[0];
    assert.equal(afterRead.unread, 0, "badge cleared after read");

    // flag on/off
    const flagOn = await fetch(`${base}/api/inbox/${jid}/flag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flagged: true }),
    });
    assert.equal((await flagOn.json()).flagged, true);
    assert.equal(
      (await (await fetch(`${base}/api/inbox`)).json()).conversations[0].flagged,
      true,
      "flag persisted"
    );

    // thread detail
    const thread = await fetch(`${base}/api/inbox/${jid}`);
    assert.equal(thread.status, 200);
    assert.equal((await thread.json()).conversation.jid, JID);

    // An unknown-but-valid JID degrades to an empty thread (so a fresh chat can
    // be started); a malformed id is still not found.
    const unknown = await fetch(`${base}/api/inbox/unknown@s.whatsapp.net`);
    assert.equal(unknown.status, 200);
    const unknownBody = await unknown.json();
    assert.equal(unknownBody.conversation.jid, "unknown@s.whatsapp.net");
    assert.deepEqual(unknownBody.conversation.messages, []);
    assert.equal((await fetch(`${base}/api/inbox/not-a-route`)).status, 404);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("inbox routes resolve the phone-number form to the merged LID chat", async () => {
  const LID = "225159969521788@lid";
  const PN = "2348052928072@s.whatsapp.net";
  const store = createSqliteMessageStore({ file: ":memory:" });
  await store.save(
    seedMessage({
      id: "lid-1",
      chat: LID,
      sender: LID,
      raw: { key: { id: "lid-1", remoteJid: LID, remoteJidAlt: PN }, pushName: "Ada" },
    })
  );
  store.canonicalizeChat(PN, LID);

  const sends = [];
  const connection = makeFakeConnection({
    state: "open",
    sendMessage: async (to, content, email) => {
      sends.push({ to, content, email });
      return { key: { id: "sent-1" } };
    },
  });
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  const pn = encodeURIComponent(PN);
  try {
    // Thread detail via the old phone-number id lands on the merged LID chat.
    const thread = await (await fetch(`${base}/api/inbox/${pn}`)).json();
    assert.equal(thread.conversation.jid, LID, "old PN id resolves to the survivor chat");
    assert.equal(thread.conversation.messages.length, 1);

    // read/flag applied through the alias touch the same conversation.
    const read = await fetch(`${base}/api/inbox/${pn}/read`, { method: "POST" });
    assert.deepEqual(await read.json(), { ok: true, jid: LID, unread: 0 });
    const flag = await fetch(`${base}/api/inbox/${pn}/flag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ flagged: true }),
    });
    assert.equal((await flag.json()).flagged, true);
    assert.equal((await (await fetch(`${base}/api/inbox`)).json()).conversations[0].jid, LID);

    // A send to the old PN form targets the canonical chat.
    const res = await fetch(`${base}/api/inbox/${pn}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "yo" }),
    });
    assert.equal(res.status, 200);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].to, LID, "the send goes to the canonical LID chat");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("OPTIONS preflight and health check", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    const pre = await fetch(`${base}/api/inbox`, { method: "OPTIONS" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    // The browser preflight must advertise every method the API serves, or
    // fetch() rejects PUT/DELETE before the request is even sent.
    const methods = pre.headers.get("access-control-allow-methods");
    for (const m of ["GET", "POST", "PUT", "DELETE", "OPTIONS"]) {
      assert.ok(methods.includes(m), `preflight advertises ${m}`);
    }

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.deepEqual(health, { ok: true });
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("without a message store the inbox returns 503", async () => {
  const api = createApiServer({}); // no store
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "no message store configured");
  } finally {
    await closeApi(api);
  }
});

/* ------------------------------------------------------------------ */
/*  Thread pagination (GET /api/inbox/:jid?limit=&before=)             */
/* ------------------------------------------------------------------ */

test("thread pagination: pages are contiguous, non-overlapping and complete", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  const jid = encodeURIComponent(JID);
  const get = (qs = "") => fetch(`${base}/api/inbox/${jid}${qs}`);
  try {
    seedThread(store, { count: 5 });

    // No limit -> exactly today's response: the full thread, no page keys.
    const full = await (await get()).json();
    assert.equal(full.conversation.messages.length, 5);
    assert.equal(Object.hasOwn(full, "hasMore"), false, "hasMore only appears with limit");
    assert.equal(Object.hasOwn(full, "nextBefore"), false, "nextBefore only appears with limit");

    // Page 1: newest messages, ascending.
    const p1 = await (await get("?limit=2")).json();
    assert.deepEqual(p1.conversation.messages.map((m) => m.text), ["message 3", "message 4"]);
    assert.equal(p1.hasMore, true);
    assert.ok(p1.nextBefore, "cursor present while older rows exist");

    // Pages must carry the same message-view shape as the no-limit thread and
    // the inbox list ({ id, from, text, time, ... }) — never raw store rows
    // ({ id, chat, fromMe, tsMs, ... }). The No-limit thread is the reference.
    const pageKeys = Object.keys(p1.conversation.messages[0]).sort();
    const fullKeys = Object.keys(full.conversation.messages[0]).sort();
    assert.deepEqual(pageKeys, fullKeys, "page message shape matches the full-thread message shape");
    assert.ok(!("fromMe" in p1.conversation.messages[0]), "no raw store fields leak into pages");
    assert.equal(p1.conversation.messages[0].from, "them");
    assert.ok(p1.conversation.messages[0].time, "message view time present");

    // Page 2 via the page-1 cursor.
    const p2 = await (await get(`?limit=2&before=${encodeURIComponent(p1.nextBefore)}`)).json();
    assert.deepEqual(p2.conversation.messages.map((m) => m.text), ["message 1", "message 2"]);
    assert.equal(p2.hasMore, true);

    // Page 3 (last): no hasMore, null cursor.
    const p3 = await (await get(`?limit=2&before=${encodeURIComponent(p2.nextBefore)}`)).json();
    assert.deepEqual(p3.conversation.messages.map((m) => m.text), ["message 0"]);
    assert.equal(p3.hasMore, false);
    assert.equal(p3.nextBefore, null);

    const union = [...p1.conversation.messages, ...p2.conversation.messages, ...p3.conversation.messages].map((m) => m.id);
    const order = new Map(full.conversation.messages.map((m, i) => [m.id, i]));
    assert.deepEqual(
      [...union].sort((a, b) => order.get(a) - order.get(b)),
      full.conversation.messages.map((m) => m.id),
      "pages tile the whole thread (same set, no gaps, no overlaps)"
    );
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("thread pagination validates limit and before", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  const jid = encodeURIComponent(JID);
  const get = (qs = "") => fetch(`${base}/api/inbox/${jid}${qs}`);
  try {
    seedThread(store, { count: 5 });

    assert.equal((await get("?limit=banana")).status, 400, "non-integer limit");
    assert.equal((await get("?limit=2&before=not-a-cursor")).status, 400, "garbage cursor");
    assert.equal(
      (await get(`?limit=2&before=${encodeURIComponent(Buffer.from("hello!").toString("base64url"))}`)).status,
      400,
      "cursor without a separator"
    );

    // limit clamps into 1..200
    const clamped = await (await get("?limit=0")).json();
    assert.deepEqual(clamped.conversation.messages.map((m) => m.id), ["seed-4"], "0 clamps to 1");

    const high = await (await get("?limit=999")).json();
    assert.equal(high.conversation.messages.length, 5, "999 clamps to 200 (single page)");
    assert.equal(high.hasMore, false);
    assert.equal(high.nextBefore, null);

    // Empty limit behaves like no limit (full thread, no pagination keys).
    const empty = await (await get("?limit=")).json();
    assert.equal(empty.conversation.messages.length, 5);
    assert.equal(Object.hasOwn(empty, "hasMore"), false);
  } finally {
    await closeApi(api);
    store.close();
  }
});

/* ------------------------------------------------------------------ */
/*  Account endpoint                                                   */
/* ------------------------------------------------------------------ */

test("GET /api/account returns the connected account", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection({ user: { id: JID, name: "Jane" } });
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.connected, true);
    assert.equal(data.state, "open");
    assert.deepEqual(data.user, { id: JID, name: "Jane" });
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("GET /api/account reports when nothing is connected", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection({ state: "qr" });
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.connected, false);
    assert.equal(data.state, "qr");
    assert.equal(data.user, null);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("GET /api/account returns 503 without a connection", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store }); // no connection
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "no WhatsApp connection");
  } finally {
    await closeApi(api);
    store.close();
  }
});

/* ------------------------------------------------------------------ */
/*  Account: disconnect + pairing                                      */
/* ------------------------------------------------------------------ */

test("POST /api/account/disconnect logs the session out", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  let loggedOut = false;
  const connection = {
    getStatus: () => ({ state: loggedOut ? "closed" : "open" }),
    logout: async () => {
      loggedOut = true;
    },
  };
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account/disconnect`, { method: "POST" });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.connected, false);
    assert.equal(loggedOut, true);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("POST /api/account/disconnect is token-gated when configured", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  let loggedOut = false;
  const connection = {
    getStatus: () => ({ state: "open" }),
    logout: async () => {
      loggedOut = true;
    },
  };
  const api = createApiServer({ messageStore: store, connection, apiToken: "s3cret" });
  const base = await listen(api);
  try {
    const denied = await fetch(`${base}/api/account/disconnect`, { method: "POST" });
    assert.equal(denied.status, 401, "no token");
    assert.equal(loggedOut, false, "must not log out without a token");

    const ok = await fetch(`${base}/api/account/disconnect`, {
      method: "POST",
      headers: { "x-api-token": "s3cret" },
    });
    assert.equal(ok.status, 200, "correct token");
    assert.equal(loggedOut, true);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("POST /api/account/disconnect returns 503 without a connection", async () => {
  const api = createApiServer({}); // no connection, no store
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account/disconnect`, { method: "POST" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "no WhatsApp connection");
  } finally {
    await closeApi(api);
  }
});

test("POST /api/account/clear-data wipes the store and the media bytes", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const mediaStore = createMediaStore({ dir: mkdtempSync(join(tmpdir(), "wa-clear-")) });
  await mediaStore.save({
    id: "media-1",
    buffer: Buffer.from("bytes"),
    type: "image",
    mimeType: "image/png",
    fileName: "x.png",
  });

  store.save({
    id: "m1",
    chat: JID,
    isGroup: false,
    fromMe: false,
    sender: JID,
    text: "hello",
    receivedAt: Date.now(),
    raw: { key: { id: "m1" } },
  });
  store.createContact({ name: "Ada", phone: "2348011112222" });
  store.saveTemplate({ title: "Hi", body: "there" });

  // No connection passed: clearing data must not require a linked device.
  const api = createApiServer({ messageStore: store, mediaStore });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account/clear-data`, { method: "POST" });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.ok(data.mediaRemoved >= 1, "media files are removed");

    assert.deepEqual(store.listConversations(), [], "chats are gone");
    assert.deepEqual(store.listContacts(), [], "contacts are gone");
    assert.deepEqual(store.listTemplates(), [], "templates are gone");
    assert.equal(await mediaStore.read("media-1"), null, "bytes are gone");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("POST /api/account/clear-data is token-gated when configured", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  store.createContact({ name: "Ada", phone: "2348011112222" });
  const api = createApiServer({ messageStore: store, apiToken: "s3cret" });
  const base = await listen(api);
  try {
    const denied = await fetch(`${base}/api/account/clear-data`, { method: "POST" });
    assert.equal(denied.status, 401, "no token");
    assert.equal(store.listContacts().length, 1, "must not clear without a token");

    const ok = await fetch(`${base}/api/account/clear-data`, {
      method: "POST",
      headers: { "x-api-token": "s3cret" },
    });
    assert.equal(ok.status, 200, "correct token");
    assert.deepEqual(store.listContacts(), []);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("POST /api/account/clear-data returns 503 without a store", async () => {
  const api = createApiServer({});
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account/clear-data`, { method: "POST" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, "no message store");
  } finally {
    await closeApi(api);
  }
});

function makePairingConnection({ state = "qr", phoneNumber = null } = {}) {
  const paired = [];
  return {
    paired,
    phoneNumber,
    getStatus: () => ({ state }),
    pair: async (number) => {
      paired.push(number);
      return "ABCD-EFGH";
    },
  };
}

test("POST /api/account/pair returns a pairing code", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makePairingConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: "2348012345678" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.code, "ABCD-EFGH");
    assert.equal(typeof data.expiresInMs, "number");
    assert.deepEqual(connection.paired, ["2348012345678"]);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("POST /api/account/pair falls back to the configured phone number", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makePairingConnection({ phoneNumber: "2348012345678" });
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account/pair`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(connection.paired, ["2348012345678"]);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("POST /api/account/pair returns 409 until the session is in qr", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makePairingConnection({ state: "closed" });
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/account/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phoneNumber: "2348012345678" }),
    });
    assert.equal(res.status, 409);
    assert.deepEqual(connection.paired, [], "must not request a code before pairing is ready");
  } finally {
    await closeApi(api);
    store.close();
  }
});

/* ------------------------------------------------------------------ */
/*  Send endpoint                                                      */
/* ------------------------------------------------------------------ */

function makeFakeConnection({ state = "open", user = null, sendMessage } = {}) {
  const sends = [];
  return {
    sends,
    getStatus: () => ({ state, user }),
    sendMessage:
      sendMessage ??
      (async (to, content, email, options) => {
        // `options` only appears for quoted replies, so existing assertions on
        // the plain `{ to, content, email }` record stay exact.
        sends.push({ to, content, email, ...(options ? { options } : {}) });
        return { key: { id: `sent-${to}` } };
      }),
  };
}

const b64 = (str) => Buffer.from(str).toString("base64");

test("POST /api/inbox/:jid/send sends a text message", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.jid, JID);
    assert.equal(data.id, `sent-${JID}`);
    assert.equal(data.message.id, data.id, "send response message mirrors the thread shape");
    assert.equal(data.message.from, "me");
    assert.equal(data.message.text, "hello");
    assert.ok(data.message.time, "relative event time present");
    assert.equal(connection.sends.length, 1);
    assert.deepEqual(connection.sends[0], { to: JID, content: { text: "hello" }, email: null });
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send forwards the optional email", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi", email: "jane@gmail.com" }),
    });
    assert.equal(res.status, 200);
    assert.equal(connection.sends[0].email, "jane@gmail.com");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send decodes image media into a Buffer with a caption", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ media: { type: "image", data: b64("abc"), caption: "look" } }),
    });
    assert.equal(res.status, 200);
    const { content } = connection.sends[0];
    assert.ok(content.image instanceof Buffer, "image is a Buffer");
    assert.equal(content.image.toString(), "abc");
    assert.equal(content.caption, "look");
    assert.ok(!("text" in content), "text is not sent alongside media (use caption)");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send packs a sticker as content.sticker with a webp mimetype", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ media: { type: "sticker", data: b64("webp") } }),
    });
    assert.equal(res.status, 200);
    const { content } = connection.sends[0];
    assert.ok(content.sticker instanceof Buffer, "sticker is a Buffer");
    assert.equal(content.sticker.toString(), "webp");
    assert.equal(content.mimetype, "image/webp", "mimetype defaults to webp");
    assert.ok(!("text" in content), "stickers carry no text");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send accepts data: URLs and falls back to text as caption", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "from the frontend",
        media: { type: "image", data: `data:image/png;base64,${b64("abc")}` },
      }),
    });
    assert.equal(res.status, 200);
    const { content } = connection.sends[0];
    assert.equal(content.image.toString(), "abc");
    assert.equal(content.caption, "from the frontend", "text becomes the caption");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send supports video, audio and document payloads", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const jid = encodeURIComponent(JID);
    const post = (body) =>
      fetch(`${base}/api/inbox/${jid}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    let res = await post({ media: { type: "video", data: b64("v") } });
    assert.equal(res.status, 200);
    assert.ok(connection.sends[0].content.video instanceof Buffer);

    res = await post({ media: { type: "audio", data: b64("a") } });
    assert.equal(res.status, 200);
    assert.ok(connection.sends[1].content.audio instanceof Buffer);

    res = await post({
      media: { type: "document", data: b64("pdf"), fileName: "menu.pdf", mimeType: "application/pdf" },
    });
    assert.equal(res.status, 200);
    const doc = connection.sends[2].content;
    assert.equal(doc.document.toString(), "pdf");
    assert.equal(doc.fileName, "menu.pdf");
    assert.equal(doc.mimetype, "application/pdf");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send validates the body and media metadata", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const jid = encodeURIComponent(JID);
    const post = (body) =>
      fetch(`${base}/api/inbox/${jid}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.equal((await post({})).status, 400, "empty body");
    assert.equal((await post({ text: "x".repeat(5000) })).status, 400, "text too long");
    assert.equal((await post({ media: { type: "gif", data: b64("x") } })).status, 400, "bad type");
    assert.equal((await post({ media: { type: "document", data: b64("x") } })).status, 400, "doc metadata");
    assert.equal((await post({ media: { type: "image", data: "!@#$%" } })).status, 400, "bad base64");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send rejects media over the size cap with 413", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection, maxMediaBytes: 1024 });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ media: { type: "image", data: b64("a".repeat(2048)) } }),
    });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /too large/);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send requires an open connection (409 / 503)", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connecting = makeFakeConnection({ state: "qr" });
  const api = createApiServer({ messageStore: store, connection: connecting });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(res.status, 409);

    const noConnApi = createApiServer({ messageStore: store });
    const base2 = await listen(noConnApi);
    try {
      const res2 = await fetch(`${base2}/api/inbox/${encodeURIComponent(JID)}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hi" }),
      });
      assert.equal(res2.status, 503);
    } finally {
      await closeApi(noConnApi);
    }
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send maps connection errors to 422 (off WhatsApp) and 502", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const notOnWhatsApp = makeFakeConnection({
    sendMessage: async () => {
      throw new Error("15551234567 is not on WhatsApp");
    },
  });
  const api1 = createApiServer({ messageStore: store, connection: notOnWhatsApp });
  const base1 = await listen(api1);
  try {
    const res = await fetch(`${base1}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(res.status, 422);
  } finally {
    await closeApi(api1);
  }

  const broken = makeFakeConnection({
    sendMessage: async () => {
      throw new Error("network down");
    },
  });
  const api2 = createApiServer({ messageStore: store, connection: broken });
  const base2 = await listen(api2);
  try {
    const res = await fetch(`${base2}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "network down");
  } finally {
    await closeApi(api2);
    store.close();
  }
});

test("the API token protects the send route when configured", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection, apiToken: "s3cret" });
  const base = await listen(api);
  try {
    const url = `${base}/api/inbox/${encodeURIComponent(JID)}/send`;
    const body = JSON.stringify({ text: "hi" });

    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).status, 401, "no token");
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-token": "wrong" }, body })).status, 401, "wrong token");

    const ok = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-token": "s3cret" },
      body,
    });
    assert.equal(ok.status, 200, "correct token");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send stays open when no API token is configured", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection }); // no apiToken
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hi" }),
    });
    assert.equal(res.status, 200, "open without a token header when API_TOKEN is unset");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send with quotedId turns the send into a quoted reply", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    store.save({
      id: "src-1",
      chat: JID,
      isGroup: false,
      fromMe: false,
      sender: JID,
      text: "the original",
      receivedAt: Date.now() - 10_000,
      raw: {
        key: { id: "src-1", remoteJid: JID, fromMe: false },
        message: { conversation: "the original" },
      },
    });

    const post = (body) =>
      fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const res = await post({ text: "my reply", quotedId: "src-1" });
    assert.equal(res.status, 200);
    const quoted = connection.sends[0].options?.quoted;
    assert.equal(quoted.key.id, "src-1", "the stored key is reused");
    assert.equal(quoted.message.conversation, "the original", "the raw content is quoted");

    const plain = await post({ text: "plain" });
    assert.equal(plain.status, 200);
    assert.equal(connection.sends[1].options, undefined, "a plain send carries no quoted option");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("send rejects an unusable quotedId (400 / 404 / 409)", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  const url = `${base}/api/inbox/${encodeURIComponent(JID)}/send`;
  const post = (body) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await post({ text: "hi", quotedId: 42 })).status, 400, "non-string quotedId");
    assert.equal((await post({ text: "hi", quotedId: "nope" })).status, 404, "unknown target");

    store.save({
      id: "gone",
      chat: JID,
      isGroup: false,
      fromMe: true,
      sender: JID,
      text: "deleted soon",
      receivedAt: Date.now(),
      raw: {
        key: { id: "gone", remoteJid: JID, fromMe: true },
        message: { conversation: "deleted soon" },
      },
    });
    await store.markMessageDeleted(JID, "gone");
    assert.equal((await post({ text: "hi", quotedId: "gone" })).status, 409, "deleted target");

    store.save({
      id: "no-content",
      chat: JID,
      isGroup: false,
      fromMe: false,
      sender: JID,
      text: "key only",
      receivedAt: Date.now(),
      raw: { key: { id: "no-content", remoteJid: JID, fromMe: false } },
    });
    assert.equal((await post({ text: "hi", quotedId: "no-content" })).status, 409, "target without content");

    assert.equal(connection.sends.length, 0, "no unusable quote reaches WhatsApp");
  } finally {
    await closeApi(api);
    store.close();
  }
});

/* ------------------------------------------------------------------ */
/*  Edit & delete endpoints                                            */
/* ------------------------------------------------------------------ */

/**
 * A fake connection that records delete/edit/react calls the routes make.
 * Passing the store lets reactions write through the way the real connection
 * does, so the route's refreshed response carries the new reaction.
 */
function makeEditableConnection(store = null) {
  const conn = makeFakeConnection({ state: "open" });
  conn.deletes = [];
  conn.edits = [];
  conn.deleteMessage = async (chat, key) => {
    conn.deletes.push({ chat, key });
  };
  conn.editMessage = async (chat, key, text) => {
    conn.edits.push({ chat, key, text });
  };
  conn.reactions = [];
  conn.sendReaction = async (chat, id, text) => {
    conn.reactions.push({ chat, id, text });
    if (store) {
      await store.setMessageReaction(chat, id, "me", text ? { text, at: Date.now() } : null);
    }
  };
  return conn;
}

/** Seeds one of "our" messages (fromMe) with the raw key edit/delete need. */
function seedOwnMessage(store, over = {}) {
  const id = over.id ?? "own-1";
  store.save({
    id,
    chat: JID,
    isGroup: false,
    fromMe: true,
    sender: JID,
    text: "original text",
    receivedAt: Date.now() - 30_000,
    raw: { key: { id, remoteJid: JID, fromMe: true } },
    ...over,
  });
  return id;
}

test("PUT /api/inbox/:jid/messages/:id edits one of our messages", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEditableConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const id = seedOwnMessage(store);
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/messages/${id}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "edited text" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.message.text, "edited text");
    assert.equal(body.message.edited, true);
    assert.equal(connection.edits.length, 1, "the connection edited once");
    assert.equal(connection.edits[0].key.id, id);
    assert.equal(connection.edits[0].text, "edited text");
    assert.equal((await store.getMessage(JID, id)).text, "edited text", "persisted");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("DELETE /api/inbox/:jid/messages/:id tombstones our message, keeping its text", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEditableConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const id = seedOwnMessage(store);
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/messages/${id}`, {
      method: "DELETE",
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.message.deleted, true);
    assert.equal(connection.deletes.length, 1, "the connection revoked once");
    assert.equal(connection.deletes[0].key.id, id);
    const stored = await store.getMessage(JID, id);
    assert.equal(stored.deleted, true);
    assert.equal(stored.text, "original text", "original text retained for admin reveal");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("edit/delete reject messages that aren't ours", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEditableConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    await store.save(seedMessage()); // fromMe: false
    const url = `${base}/api/inbox/${encodeURIComponent(JID)}/messages/m1`;
    assert.equal((await fetch(url, { method: "DELETE" })).status, 403);
    const put = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "nope" }),
    });
    assert.equal(put.status, 403);
    assert.equal(connection.deletes.length, 0);
    assert.equal(connection.edits.length, 0);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("edit requires non-empty text; unknown messages 404", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEditableConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    const id = seedOwnMessage(store);
    const url = (mid) => `${base}/api/inbox/${encodeURIComponent(JID)}/messages/${mid}`;
    const put = (mid, body) =>
      fetch(url(mid), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    assert.equal((await put(id, { text: "   " })).status, 400, "blank text rejected");
    assert.equal((await put("nope", { text: "hi" })).status, 404, "unknown message");
    assert.equal((await fetch(url("nope"), { method: "DELETE" })).status, 404);
    assert.equal(connection.edits.length, 0);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("edit/delete require the API token when one is configured", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEditableConnection();
  const api = createApiServer({ messageStore: store, connection, apiToken: "secret" });
  const base = await listen(api);
  try {
    const id = seedOwnMessage(store);
    const url = `${base}/api/inbox/${encodeURIComponent(JID)}/messages/${id}`;
    assert.equal((await fetch(url, { method: "DELETE" })).status, 401);
    const put = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    assert.equal(put.status, 401);
    assert.equal(connection.deletes.length, 0);
    assert.equal(connection.edits.length, 0);
  } finally {
    await closeApi(api);
    store.close();
  }
});

/* ------------------------------------------------------------------ */
/*  Reaction endpoint                                                  */
/* ------------------------------------------------------------------ */

test("POST /api/inbox/:jid/messages/:id/reaction reacts to any stored message", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEditableConnection(store);
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    await store.save(seedMessage()); // an incoming message — not ours
    const res = await fetch(
      `${base}/api/inbox/${encodeURIComponent(JID)}/messages/m1/reaction`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "👍" }),
      }
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.message.reactions, [{ text: "👍", from: "me" }]);
    assert.deepEqual(connection.reactions, [{ chat: JID, id: "m1", text: "👍" }]);
    assert.equal((await store.getMessage(JID, "m1")).reactions.me.text, "👍", "persisted");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("an empty reaction clears ours again", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEditableConnection(store);
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  try {
    await store.save(seedMessage());
    const url = `${base}/api/inbox/${encodeURIComponent(JID)}/messages/m1/reaction`;
    const post = (text) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
    assert.equal((await post("❤️")).status, 200);
    const cleared = await post("");
    assert.equal(cleared.status, 200);
    const body = await cleared.json();
    assert.equal(body.message.reactions, undefined, "no reactions left");
    assert.equal(connection.reactions.length, 2);
    assert.equal(connection.reactions[1].text, "");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("reactions reject unknown/deleted messages, long text and missing token", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEditableConnection(store);
  const api = createApiServer({ messageStore: store, connection, apiToken: "secret" });
  const base = await listen(api);
  try {
    await store.save(seedMessage()); // m1
    await store.save(seedMessage({ id: "m2" }));
    const url = (mid) => `${base}/api/inbox/${encodeURIComponent(JID)}/messages/${mid}/reaction`;
    const post = (mid, text, token) =>
      fetch(url(mid), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-api-token": token } : {}),
        },
        body: JSON.stringify({ text }),
      });

    assert.equal((await post("m1", "👍")).status, 401, "token required");
    assert.equal((await post("nope", "👍", "secret")).status, 404, "unknown message");
    await store.markMessageDeleted(JID, "m1");
    assert.equal((await post("m1", "👍", "secret")).status, 409, "deleted message");
    assert.equal(
      (await post("m2", "a".repeat(33), "secret")).status,
      400,
      "reaction too long"
    );
    // Nothing reached WhatsApp.
    assert.equal(connection.reactions.length, 0);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("GET /api/events forwards message:update frames", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEventConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  const events = await openEvents(base, { jid: JID });
  try {
    assert.equal(await events.next(), ": connected", "initial comment frame");
    connection.emit("message:update", {
      id: "own-1",
      chat: JID,
      isGroup: false,
      fromMe: true,
      sender: JID,
      text: "edited live",
      tsMs: Date.now(),
      deleted: false,
      edited: true,
    });
    const frame = await events.next();
    const payload = JSON.parse(frame.replace(/^data: /, ""));
    assert.equal(payload.jid, JID);
    assert.equal(payload.message.id, "own-1");
    assert.equal(payload.message.text, "edited live");
    assert.equal(payload.message.edited, true);
  } finally {
    await events.stop();
    await closeApi(api);
    store.close();
  }
});

/* ------------------------------------------------------------------ */
/*  SSE /api/events                                                    */
/* ------------------------------------------------------------------ */

test("GET /api/events streams incoming and outgoing message frames", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEventConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  const stream = await openEvents(base);
  try {
    assert.equal(stream.res.status, 200, "text/event-stream headers");
    assert.equal(stream.res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(stream.res.headers.get("cache-control"), "no-cache");
    assert.equal(stream.res.headers.get("access-control-allow-origin"), "*");
    assert.equal(await stream.next(), ": connected", "initial comment frame");

    // Incoming message
    connection.emit("message", {
      id: "in-1",
      chat: JID,
      isGroup: false,
      fromMe: false,
      sender: JID,
      name: "Ada Okafor",
      text: "hi there",
      receivedAt: Date.now(),
    });
    const incoming = JSON.parse((await stream.next()).replace(/^data: /, ""));
    assert.equal(incoming.jid, JID);
    assert.equal(incoming.message.id, "in-1");
    assert.equal(incoming.message.from, "them");
    assert.equal(incoming.message.text, "hi there");

    // Outgoing message
    const now = Date.now();
    connection.emit("message", {
      id: "out-1",
      chat: JID,
      isGroup: false,
      fromMe: true,
      sender: JID,
      name: null,
      text: "hello back",
      receivedAt: now,
    });
    const outgoing = JSON.parse((await stream.next()).replace(/^data: /, ""));
    assert.equal(outgoing.jid, JID);
    assert.equal(outgoing.message.from, "me");
    assert.equal(outgoing.message.text, "hello back");
    assert.equal(outgoing.message.time, new Date(now).toISOString());
  } finally {
    await stream.stop();
    await closeApi(api);
    store.close();
  }
});

test("/api/events?jid= filters to a single conversation", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEventConnection();
  const api = createApiServer({ messageStore: store, connection });
  const base = await listen(api);
  const stream = await openEvents(base, { jid: JID });
  try {
    await stream.next(); // consume ": connected"

    connection.emit("message", {
      id: "other",
      chat: "other@whatsapp.net",
      isGroup: false,
      fromMe: false,
      sender: "other@whatsapp.net",
      text: "not mine",
      receivedAt: Date.now(),
    });
    const filtered = await Promise.race([stream.next(), sleep(150).then(() => null)]);
    assert.equal(filtered, null, "messages from other chats are not pushed");

    connection.emit("message", {
      id: "mine",
      chat: JID,
      isGroup: false,
      fromMe: false,
      sender: JID,
      text: "mine",
      receivedAt: Date.now(),
    });
    const frame = JSON.parse((await stream.next()).replace(/^data: /, ""));
    assert.equal(frame.jid, JID);
  } finally {
    await stream.stop();
    await closeApi(api);
    store.close();
  }
});

test("/api/events sends a heartbeat comment", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEventConnection();
  const api = createApiServer({ messageStore: store, connection, eventsHeartbeatMs: 50 });
  const base = await listen(api);
  const stream = await openEvents(base);
  try {
    await stream.next(); // consume ": connected"
    const frame = await Promise.race([stream.next(), sleep(1000).then(() => null)]);
    assert.equal(frame, ": ping", "heartbeat comment arrives every eventsHeartbeatMs");
  } finally {
    await stream.stop();
    await closeApi(api);
    store.close();
  }
});

test("/api/events honours the API token via ?token=", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEventConnection();
  const api = createApiServer({ messageStore: store, connection, apiToken: "s3cret" });
  const base = await listen(api);
  try {
    const denied = await fetch(`${base}/api/events`);
    assert.equal(denied.status, 401, "no token -> 401");

    const wrong = await fetch(`${base}/api/events?token=nope`);
    assert.equal(wrong.status, 401, "wrong token -> 401");

    const stream = await openEvents(base, { token: "s3cret" });
    assert.equal(stream.res.status, 200, "correct token opens the stream");
    await stream.stop();
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("/api/events unsubscribes and clears the heartbeat on close", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeEventConnection();
  const api = createApiServer({ messageStore: store, connection, eventsHeartbeatMs: 50 });
  const base = await listen(api);
  const stream = await openEvents(base);
  try {
    await stream.next();
    assert.equal(connection.listenerCount("message"), 1, "subscribed while open");

    await stream.stop();
    await sleep(20);
    assert.equal(connection.listenerCount("message"), 0, "listener removed after close");
  } finally {
    await stream.stop();
    await closeApi(api);
    store.close();
  }
});

test("GET /api/media/:messageId serves stored bytes with the right headers", async () => {
  const mediaStore = createMediaStore({
    dir: mkdtempSync(join(tmpdir(), "wa-media-")),
  });
  const mediaId = "media-1";
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const ref = await mediaStore.save({
    id: mediaId,
    buffer: bytes,
    type: "document",
    mimeType: "application/pdf",
    fileName: "guide.pdf",
  });
  assert.equal(ref.key, mediaId, "safe ids are kept verbatim");

  const store = createSqliteMessageStore({ file: ":memory:" });
  store.save({
    id: mediaId,
    chat: JID,
    isGroup: false,
    fromMe: true,
    sender: null,
    text: null,
    receivedAt: Date.now(),
    media: ref,
    raw: { key: { id: mediaId } },
  });

  const api = createApiServer({ messageStore: store, mediaStore });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/media/${mediaId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.equal(res.headers.get("content-length"), String(bytes.length));
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(res.headers.get("cache-control"), "private, max-age=31536000, immutable");
    assert.match(res.headers.get("content-disposition"), /inline; filename="guide\.pdf"/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);

    // The thread view carries the media object with a working url.
    const thread = await (await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}`)).json();
    assert.deepEqual(thread.conversation.messages[0].media, {
      type: "document",
      mimeType: "application/pdf",
      fileName: "guide.pdf",
      url: `/api/media/${mediaId}`,
    });

    // Unknown / malformed ids -> 404 (and no path traversal).
    assert.equal((await fetch(`${base}/api/media/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/media/..%2Fsecret`)).status, 404);
    assert.equal((await fetch(`${base}/api/media/..%2F..%2Fpackage.json`)).status, 404);
  } finally {
    await closeApi(api);
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function postJson(base, path, payload, method = "POST") {
  return fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

test("templates: create, list (newest first), get and delete round-trip", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    assert.deepEqual(await (await fetch(`${base}/api/templates`)).json(), { templates: [] });

    const firstRes = await postJson(base, "/api/templates", { title: "Welcome", body: "Hi there!" });
    assert.equal(firstRes.status, 201, "create returns 201");
    const first = (await firstRes.json()).template;
    assert.equal(first.title, "Welcome");
    assert.equal(first.body, "Hi there!");
    assert.equal(first.media, null);
    assert.ok(first.id && first.createdAt);

    await sleep(5); // distinct created_at so newest-first is deterministic
    const second = (await (
      await postJson(base, "/api/templates", { title: "Promo", body: "50% off" })
    ).json()).template;

    const list = await (await fetch(`${base}/api/templates`)).json();
    assert.deepEqual(
      list.templates.map((t) => t.id),
      [second.id, first.id],
      "newest first"
    );

    const one = await (await fetch(`${base}/api/templates/${first.id}`)).json();
    assert.deepEqual(one, { template: first });
    assert.equal((await fetch(`${base}/api/templates/missing`)).status, 404);

    const del = await fetch(`${base}/api/templates/${first.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true, id: first.id });
    assert.equal((await fetch(`${base}/api/templates/${first.id}`)).status, 404);
    assert.equal((await fetch(`${base}/api/templates/${first.id}`, { method: "DELETE" })).status, 404);

    const remaining = await (await fetch(`${base}/api/templates`)).json();
    assert.deepEqual(
      remaining.templates.map((t) => t.id),
      [second.id]
    );
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("templates: PUT keeps, clears or replaces the saved attachment", async () => {
  const mediaStore = createMediaStore({ dir: mkdtempSync(join(tmpdir(), "wa-tpl-media-")) });
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store, mediaStore });
  const base = await listen(api);
  try {
    const png = Buffer.from("fake-png-bytes").toString("base64");
    const created = (await (
      await postJson(base, "/api/templates", {
        title: "Picture",
        body: "look",
        media: { type: "image", data: png, mimeType: "image/png" },
      })
    ).json()).template;
    assert.deepEqual(
      { type: created.media.type, mimeType: created.media.mimeType, fileName: created.media.fileName },
      { type: "image", mimeType: "image/png", fileName: null }
    );
    assert.match(created.media.url, /^\/api\/media\//);
    const served = await fetch(`${base}${created.media.url}`);
    assert.equal(served.status, 200);
    assert.equal(await served.text(), "fake-png-bytes", "template media bytes are served");

    // media omitted -> keep the attachment while the title/body change
    const kept = (await (
      await postJson(base, `/api/templates/${created.id}`, { title: "Renamed", body: "look" }, "PUT")
    ).json()).template;
    assert.equal(kept.title, "Renamed");
    assert.equal(kept.media.url, created.media.url);

    // media: null -> clear
    const cleared = (await (
      await postJson(base, `/api/templates/${created.id}`, { title: "Renamed", body: "look", media: null }, "PUT")
    ).json()).template;
    assert.equal(cleared.media, null);

    // a fresh media object -> replace
    const replaced = (await (
      await postJson(
        base,
        `/api/templates/${created.id}`,
        {
          title: "Renamed",
          body: "look",
          media: { type: "document", data: png, mimeType: "application/pdf", fileName: "x.pdf" },
        },
        "PUT"
      )
    ).json()).template;
    assert.equal(replaced.media.type, "document");
    assert.equal(replaced.media.fileName, "x.pdf");
    assert.notEqual(replaced.media.url, created.media.url);

    assert.equal((await postJson(base, "/api/templates/nope", { title: "x", body: "y" }, "PUT")).status, 404);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("templates: media-only templates are allowed and the body is optional", async () => {
  const mediaStore = createMediaStore({ dir: mkdtempSync(join(tmpdir(), "wa-tpl-media-")) });
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store, mediaStore });
  const base = await listen(api);
  try {
    const data = Buffer.from("bytes").toString("base64");
    const t = (await (
      await postJson(base, "/api/templates", { title: "Just a photo", media: { type: "image", data } })
    ).json()).template;
    assert.equal(t.body, "");
    assert.equal(t.media.type, "image");
    assert.equal(t.media.mimeType, "image/jpeg", "the media store applies a default mime");

    // editing only the title keeps the media and the empty body
    const upd = (await (
      await postJson(base, `/api/templates/${t.id}`, { title: "New title", body: "" }, "PUT")
    ).json()).template;
    assert.equal(upd.title, "New title");
    assert.equal(upd.media.type, "image");

    // clearing the media of a media-only template with no text is rejected
    const bad = await postJson(base, `/api/templates/${t.id}`, { title: "New title", body: "", media: null }, "PUT");
    assert.equal(bad.status, 400);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("templates: validation mirrors the send-path media rules", async () => {
  const mediaStore = createMediaStore({ dir: mkdtempSync(join(tmpdir(), "wa-tpl-media-")) });
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store, mediaStore, maxMediaBytes: 1024 });
  const base = await listen(api);
  try {
    // title required and non-empty after trim
    assert.equal((await postJson(base, "/api/templates", { body: "no title" })).status, 400);
    assert.equal((await postJson(base, "/api/templates", { title: "   ", body: "x" })).status, 400);
    // text or media required
    assert.equal((await postJson(base, "/api/templates", { title: "Empty" })).status, 400);
    // length caps
    assert.equal((await postJson(base, "/api/templates", { title: "x".repeat(201), body: "y" })).status, 400);
    assert.equal((await postJson(base, "/api/templates", { title: "Long", body: "y".repeat(4097) })).status, 400);
    // unsupported media type
    assert.equal(
      (await postJson(base, "/api/templates", { title: "Bad", media: { type: "gif", data: "aGk=" } })).status,
      400
    );
    // document requires fileName AND mimeType
    assert.equal(
      (
        await postJson(base, "/api/templates", {
          title: "Doc",
          media: { type: "document", data: "aGk=", fileName: "a.pdf" },
        })
      ).status,
      400
    );
    // invalid base64
    assert.equal(
      (await postJson(base, "/api/templates", { title: "Bad", media: { type: "image", data: "!!!" } })).status,
      400
    );
    // over the (test-lowered) size cap
    const big = Buffer.alloc(2048, 1).toString("base64");
    assert.equal(
      (await postJson(base, "/api/templates", { title: "Big", media: { type: "image", data: big } })).status,
      413
    );
    // malformed JSON body
    const badJson = await fetch(`${base}/api/templates`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(badJson.status, 400);

    // nothing invalid was stored
    assert.deepEqual((await (await fetch(`${base}/api/templates`)).json()).templates, []);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("templates: return 503 when no template store is configured", async () => {
  const api = createApiServer({});
  const base = await listen(api);
  try {
    assert.equal((await fetch(`${base}/api/templates`)).status, 503);
    assert.equal((await postJson(base, "/api/templates", { title: "x", body: "y" })).status, 503);
    assert.equal((await fetch(`${base}/api/templates/1`)).status, 503);
    assert.equal((await fetch(`${base}/api/templates/1`, { method: "DELETE" })).status, 503);
  } finally {
    await closeApi(api);
  }
});

test("templates: media without a media store returns 503", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    const res = await postJson(base, "/api/templates", { title: "Pic", media: { type: "image", data: "aGk=" } });
    assert.equal(res.status, 503);
  } finally {
    await closeApi(api);
    store.close();
  }
});

// ---------------------------------------------------------------------------
// Contacts + broadcast lists
// ---------------------------------------------------------------------------

test("contacts: create/list/get/update/delete round-trip", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    assert.deepEqual(await (await fetch(`${base}/api/contacts`)).json(), { contacts: [] });

    const createdRes = await postJson(base, "/api/contacts", { name: "  Ada Lovelace ", phone: "+234-814-685-8279" });
    assert.equal(createdRes.status, 201, "create returns 201");
    const { ok, contact } = await createdRes.json();
    assert.equal(ok, true);
    assert.equal(contact.name, "Ada Lovelace", "name trimmed");
    assert.equal(contact.phone, "+2348146858279", "phone canonicalized");
    assert.ok(contact.id && contact.createdAt);

    // Duplicate number in any format -> 409.
    const dup = await postJson(base, "/api/contacts", { name: "Ada again", phone: "2348146858279" });
    assert.equal(dup.status, 409);
    assert.equal((await dup.json()).error, "a contact with that number already exists");

    // Bad phone / missing phone -> 400.
    assert.equal((await postJson(base, "/api/contacts", { name: "x", phone: "bad" })).status, 400);
    assert.equal((await postJson(base, "/api/contacts", { name: "x" })).status, 400);

    await postJson(base, "/api/contacts", { name: "Grace Hopper", phone: "15551234567" });
    assert.equal((await (await fetch(`${base}/api/contacts`)).json()).contacts.length, 2);

    // q matches name OR phone, case-insensitively.
    const byName = await (await fetch(`${base}/api/contacts?q=grace`)).json();
    assert.deepEqual(byName.contacts.map((c) => c.name), ["Grace Hopper"]);
    const byPhone = await (await fetch(`${base}/api/contacts?q=234814`)).json();
    assert.deepEqual(byPhone.contacts.map((c) => c.name), ["Ada Lovelace"]);

    const one = await (await fetch(`${base}/api/contacts/${contact.id}`)).json();
    assert.deepEqual(one, { contact });
    assert.equal((await fetch(`${base}/api/contacts/missing`)).status, 404);

    const updated = await postJson(base, `/api/contacts/${contact.id}`, { name: "Ada L", phone: "2348146858279" }, "PUT");
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).contact.name, "Ada L");

    // Renaming onto another contact's number -> 409.
    const clash = await postJson(base, `/api/contacts/${contact.id}`, { name: "Ada L", phone: "15551234567" }, "PUT");
    assert.equal(clash.status, 409);

    assert.equal((await postJson(base, "/api/contacts/missing", { name: "x", phone: "15550000000" }, "PUT")).status, 404);
    assert.equal((await fetch(`${base}/api/contacts/missing`, { method: "DELETE" })).status, 404);

    const del = await fetch(`${base}/api/contacts/${contact.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true, id: contact.id });
    assert.equal((await fetch(`${base}/api/contacts/${contact.id}`)).status, 404);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("contacts: import reports imported and skipped rows", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    await postJson(base, "/api/contacts", { name: "Existing", phone: "15550000000" });

    const res = await postJson(base, "/api/contacts/import", {
      contacts: [
        { name: "A", phone: "2348011111111" },
        { name: "B", phone: "+234-802-222-2222" },
        { phone: "2348011111111" }, // duplicate within the batch
        { phone: "15550000000" }, // already stored
        { phone: "bad" }, // invalid
      ],
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.imported, 2);
    assert.deepEqual(
      data.skipped.map((s) => s.reason).sort(),
      ["already exists", "already exists", "invalid number"]
    );
    assert.ok(data.skipped.every((s) => typeof s.phone === "string"));

    assert.equal((await (await fetch(`${base}/api/contacts`)).json()).contacts.length, 3);

    // Non-array body -> 400.
    assert.equal((await postJson(base, "/api/contacts/import", { contacts: "nope" })).status, 400);

    // Over the 5000-row cap -> 413.
    const rows = Array.from({ length: 5001 }, (_, i) => ({ phone: `23480${String(i).padStart(7, "0")}` }));
    assert.equal((await postJson(base, "/api/contacts/import", { contacts: rows })).status, 413);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("contacts: bulk delete removes contacts and their memberships, keeping lists", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    const a = (await (await postJson(base, "/api/contacts", { name: "A", phone: "2348011111111" })).json()).contact;
    const b = (await (await postJson(base, "/api/contacts", { name: "B", phone: "2348022222222" })).json()).contact;
    const c = (await (await postJson(base, "/api/contacts", { name: "C", phone: "2348033333333" })).json()).contact;
    const list = (await (await postJson(base, "/api/lists", { name: "L", contactIds: [a.id, b.id, c.id] })).json()).list;

    // `/delete` must run the bulk handler, not be swallowed by the contact-detail matcher.
    const res = await postJson(base, "/api/contacts/delete", { ids: [a.id, b.id, a.id, "ghost"] });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, deleted: 2 });

    const remaining = (await (await fetch(`${base}/api/contacts`)).json()).contacts;
    assert.deepEqual(remaining.map((x) => x.id), [c.id]);

    const detail = (await (await fetch(`${base}/api/lists/${list.id}`)).json()).list;
    assert.equal(detail.memberCount, 1);
    assert.deepEqual(detail.contactIds, [c.id]);
    assert.equal((await (await fetch(`${base}/api/lists`)).json()).lists.length, 1, "the list survives");

    // Unknown ids delete nothing.
    assert.deepEqual(
      await (await postJson(base, "/api/contacts/delete", { ids: ["ghost"] })).json(),
      { ok: true, deleted: 0 }
    );

    // Invalid payloads -> 400.
    assert.equal((await postJson(base, "/api/contacts/delete", {})).status, 400, "ids required");
    assert.equal((await postJson(base, "/api/contacts/delete", { ids: "nope" })).status, 400, "ids not an array");
    assert.equal((await postJson(base, "/api/contacts/delete", { ids: [1, 2] })).status, 400, "ids not strings");
    assert.equal((await postJson(base, "/api/contacts/delete", { ids: [] })).status, 400, "empty ids");

    // Over the 5000-row cap (after dedupe) -> 413.
    const many = Array.from({ length: 5001 }, (_, i) => `id-${i}`);
    assert.equal((await postJson(base, "/api/contacts/delete", { ids: many })).status, 413);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("contacts: GET /api/contacts/:id/lists returns the lists containing the contact", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    const a = (await (await postJson(base, "/api/contacts", { name: "A", phone: "2348011111111" })).json()).contact;
    const b = (await (await postJson(base, "/api/contacts", { name: "B", phone: "2348022222222" })).json()).contact;

    const first = (await (await postJson(base, "/api/lists", { name: "First", contactIds: [a.id] })).json()).list;
    await sleep(5);
    const second = (await (await postJson(base, "/api/lists", { name: "Second", contactIds: [a.id, b.id] })).json()).list;
    await sleep(5);
    await postJson(base, "/api/lists", { name: "Other", contactIds: [b.id] });

    const res = await fetch(`${base}/api/contacts/${a.id}/lists`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.lists.map((l) => l.id), [second.id, first.id], "newest first, only A's lists");
    assert.deepEqual(data.lists.map((l) => l.memberCount), [2, 1]);
    assert.equal(Object.hasOwn(data.lists[0], "contactIds"), false, "list view omits contactIds");

    // Contact in no lists -> an empty array (not a 404).
    const lonely = (await (await postJson(base, "/api/contacts", { name: "Lonely", phone: "2348033333333" })).json()).contact;
    assert.deepEqual(await (await fetch(`${base}/api/contacts/${lonely.id}/lists`)).json(), { ok: true, lists: [] });

    // Unknown contact -> 404.
    const missing = await fetch(`${base}/api/contacts/does-not-exist/lists`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "contact not found" });

    // The extra /lists segment must not be treated as a contact id.
    assert.equal((await fetch(`${base}/api/contacts/${a.id}`)).status, 200);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("lists: create/list/get/update/delete round-trip with memberCount", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    assert.deepEqual(await (await fetch(`${base}/api/lists`)).json(), { lists: [] });

    const a = (await (await postJson(base, "/api/contacts", { name: "A", phone: "2348011111111" })).json()).contact;
    const b = (await (await postJson(base, "/api/contacts", { name: "B", phone: "2348022222222" })).json()).contact;

    const createdRes = await postJson(base, "/api/lists", {
      name: " Automotive Leads ",
      description: "warm",
      contactIds: [a.id, b.id, "ghost"],
    });
    assert.equal(createdRes.status, 201, "create returns 201");
    const { ok, list } = await createdRes.json();
    assert.equal(ok, true);
    assert.equal(list.name, "Automotive Leads", "name trimmed");
    assert.equal(list.description, "warm");
    assert.equal(list.memberCount, 2, "unknown ids dropped");
    assert.equal(Object.hasOwn(list, "contactIds"), false, "POST returns List, not ListDetail");

    const detail = (await (await fetch(`${base}/api/lists/${list.id}`)).json()).list;
    assert.deepEqual([...detail.contactIds].sort(), [a.id, b.id].sort());
    assert.equal(detail.memberCount, 2);
    assert.equal((await fetch(`${base}/api/lists/missing`)).status, 404);

    // contactIds present -> replaces the whole membership.
    const updatedRes = await postJson(
      base,
      `/api/lists/${list.id}`,
      { name: "Leads", description: "", contactIds: [b.id] },
      "PUT"
    );
    assert.equal(updatedRes.status, 200);
    const updated = (await updatedRes.json()).list;
    assert.equal(updated.name, "Leads");
    assert.equal(updated.memberCount, 1);
    assert.deepEqual((await (await fetch(`${base}/api/lists/${list.id}`)).json()).list.contactIds, [b.id]);

    // contactIds absent -> membership kept.
    const renamed = (await (
      await postJson(base, `/api/lists/${list.id}`, { name: "Leads v2", description: "x" }, "PUT")
    ).json()).list;
    assert.equal(renamed.memberCount, 1, "membership kept when contactIds is omitted");

    assert.equal((await postJson(base, "/api/lists/missing", { name: "x" }, "PUT")).status, 404);

    const del = await fetch(`${base}/api/lists/${list.id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.deepEqual(await del.json(), { ok: true, id: list.id });
    assert.equal((await fetch(`${base}/api/lists/${list.id}`)).status, 404);
    assert.equal((await (await fetch(`${base}/api/contacts`)).json()).contacts.length, 2, "deleting a list keeps contacts");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("lists/contacts: invalid payloads return 400", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    assert.equal((await postJson(base, "/api/lists", { description: "x" })).status, 400, "name required");
    assert.equal((await postJson(base, "/api/lists", { name: "   " })).status, 400, "blank name");
    assert.equal((await postJson(base, "/api/lists", { name: "x".repeat(201) })).status, 400, "name too long");
    assert.equal(
      (await postJson(base, "/api/lists", { name: "ok", description: "y".repeat(1001) })).status,
      400,
      "description too long"
    );
    assert.equal((await postJson(base, "/api/lists", { name: "ok", contactIds: "nope" })).status, 400, "contactIds not an array");
    assert.equal((await postJson(base, "/api/lists", { name: "ok", contactIds: [1, 2] })).status, 400, "contactIds not strings");
    assert.equal((await postJson(base, "/api/contacts", { phone: 12345 })).status, 400, "too few digits");

    const bad = await fetch(`${base}/api/lists`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, "invalid JSON body");

    // Nothing invalid was stored.
    assert.deepEqual((await (await fetch(`${base}/api/lists`)).json()).lists, []);
    assert.deepEqual((await (await fetch(`${base}/api/contacts`)).json()).contacts, []);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("contacts/lists: return 503 when no contact store is configured", async () => {
  const api = createApiServer({});
  const base = await listen(api);
  try {
    assert.equal((await fetch(`${base}/api/contacts`)).status, 503);
    assert.equal((await postJson(base, "/api/contacts", { phone: "2348011111111" })).status, 503);
    assert.equal((await fetch(`${base}/api/contacts/1`)).status, 503);
    assert.equal((await fetch(`${base}/api/contacts/1`, { method: "DELETE" })).status, 503);
    assert.equal((await postJson(base, "/api/contacts/import", { contacts: [] })).status, 503);
    assert.equal((await postJson(base, "/api/contacts/delete", { ids: ["x"] })).status, 503);
    assert.equal((await fetch(`${base}/api/contacts/1/lists`)).status, 503);
    assert.equal((await fetch(`${base}/api/lists`)).status, 503);
    assert.equal((await postJson(base, "/api/lists", { name: "x" })).status, 503);
    assert.equal((await fetch(`${base}/api/lists/1`)).status, 503);
    assert.equal((await fetch(`${base}/api/lists/1`, { method: "DELETE" })).status, 503);
  } finally {
    await closeApi(api);
  }
});

/* ------------------------------------------------------------------ */
/*  Broadcasts                                                         */
/* ------------------------------------------------------------------ */

test("templates: fallbackName is validated, trimmed and preserved on partial updates", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  try {
    const created = (await (
      await postJson(base, "/api/templates", { title: "T", body: "hi", fallbackName: "  Friend  " })
    ).json()).template;
    assert.equal(created.fallbackName, "Friend", "fallbackName trimmed");

    const plain = (await (await postJson(base, "/api/templates", { title: "P", body: "x" })).json()).template;
    assert.equal(plain.fallbackName, "", "fallbackName defaults to empty");

    assert.equal(
      (await postJson(base, "/api/templates", { title: "T", body: "x", fallbackName: "y".repeat(201) })).status,
      400,
      "fallbackName capped at 200"
    );
    assert.equal(
      (await postJson(base, "/api/templates", { title: "T", body: "x", fallbackName: 42 })).status,
      400,
      "fallbackName must be a string"
    );

    // PUT without fallbackName keeps it; with a value replaces it; "" clears it.
    const kept = (await (
      await postJson(base, `/api/templates/${created.id}`, { title: "T2", body: "hi" }, "PUT")
    ).json()).template;
    assert.equal(kept.fallbackName, "Friend", "omitted fallbackName is kept");
    const replaced = (await (
      await postJson(base, `/api/templates/${created.id}`, { title: "T3", body: "hi", fallbackName: "Pal" }, "PUT")
    ).json()).template;
    assert.equal(replaced.fallbackName, "Pal");
    const cleared = (await (
      await postJson(base, `/api/templates/${created.id}`, { title: "T4", body: "hi", fallbackName: "" }, "PUT")
    ).json()).template;
    assert.equal(cleared.fallbackName, "", "an explicit empty string clears it");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("broadcasts: send resolves the audience, personalizes and marks recipients sent", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection, startScheduler: false });
  const base = await listen(api);
  try {
    const a = (await (await postJson(base, "/api/contacts", { name: "Ada Lovelace", phone: "2348011111111" })).json()).contact;
    const b = (await (await postJson(base, "/api/contacts", { name: "   ", phone: "2348022222222" })).json()).contact;
    const c = (await (await postJson(base, "/api/contacts", { name: "Grace", phone: "2348033333333" })).json()).contact;
    const l1 = (await (await postJson(base, "/api/lists", { name: "L1", contactIds: [a.id, b.id] })).json()).list;
    const l2 = (await (await postJson(base, "/api/lists", { name: "L2", contactIds: [b.id, c.id] })).json()).list;
    const template = (await (
      await postJson(base, "/api/templates", {
        title: "Hello",
        body: "Hi {{full_name}} ({{name}})!",
        fallbackName: "Friend",
      })
    ).json()).template;

    const res = await postJson(base, "/api/broadcasts/send", {
      templateId: template.id,
      listIds: [l1.id, l2.id, l1.id], // deduped, order preserved
      minDelay: 0,
      maxDelay: 0,
      senderEmail: "  ops@example.com  ",
    });
    assert.equal(res.status, 200);
    const { broadcast } = await res.json();
    assert.equal(broadcast.total, 3, "union deduped by phone (B is in both lists)");
    assert.equal(broadcast.status, "sending");
    assert.equal(broadcast.senderEmail, "ops@example.com", "senderEmail trimmed");
    assert.deepEqual(broadcast.listIds, [l1.id, l2.id]);

    const done = await waitFor(async () => {
      const body = await (await fetch(`${base}/api/broadcasts/${broadcast.id}`)).json();
      return body.broadcast.status === "done" ? body.broadcast : null;
    });
    assert.equal(done.sent, 3);
    assert.equal(done.failed, 0);
    assert.ok(done.finishedAt);

    assert.deepEqual(
      connection.sends.map((s) => [s.to, s.content.text, s.email]),
      [
        ["+2348011111111", "Hi Ada Lovelace (Ada)!", "ops@example.com"],
        ["+2348022222222", "Hi Friend (Friend)!", "ops@example.com"],
        ["+2348033333333", "Hi Grace (Grace)!", "ops@example.com"],
      ]
    );

    const detail = await (await fetch(`${base}/api/broadcasts/${broadcast.id}`)).json();
    assert.equal(detail.recipients.length, 3);
    assert.ok(detail.recipients.every((r) => r.status === "sent" && r.sentAt));

    const all = await (await fetch(`${base}/api/broadcasts`)).json();
    assert.deepEqual(all.broadcasts.map((x) => x.id), [broadcast.id]);
    assert.equal((await fetch(`${base}/api/broadcasts/missing`)).status, 404);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("broadcasts: scheduled sends are claimed by the scheduler and re-fetch the template", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection, startScheduler: false });
  const base = await listen(api);
  try {
    const a = (await (await postJson(base, "/api/contacts", { name: "Ada", phone: "2348011111111" })).json()).contact;
    const list = (await (await postJson(base, "/api/lists", { name: "L", contactIds: [a.id] })).json()).list;
    const template = (await (await postJson(base, "/api/templates", { title: "T", body: "first {{name}}" })).json()).template;

    const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await postJson(base, "/api/broadcasts/send", {
      templateId: template.id,
      listIds: [list.id],
      minDelay: 0,
      maxDelay: 0,
      sendAt,
    });
    assert.equal(res.status, 200);
    const { broadcast } = await res.json();
    assert.equal(broadcast.status, "scheduled");
    assert.equal(broadcast.startedAt, null);
    assert.equal(broadcast.sendAt, sendAt);

    await sleep(25);
    assert.equal(connection.sends.length, 0, "nothing is sent while scheduled");

    // The body is re-fetched at fire time, so an edit before firing is picked up.
    await postJson(base, `/api/templates/${template.id}`, { title: "T", body: "second {{name}}" }, "PUT");

    const claimed = await api.runDueBroadcasts(new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString());
    assert.deepEqual(claimed.map((x) => x.id), [broadcast.id]);
    assert.equal(claimed[0].status, "sending");

    const done = await waitFor(async () => {
      const body = await (await fetch(`${base}/api/broadcasts/${broadcast.id}`)).json();
      return body.broadcast.status === "done" ? body.broadcast : null;
    });
    assert.equal(done.sent, 1);
    assert.equal(connection.sends[0].content.text, "second Ada", "the template is re-fetched at fire time");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("broadcasts: resume sends only the still-pending recipients after a restart", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  store.saveTemplate({ id: "t1", title: "T", body: "hey {{name}}" });
  store.createBroadcast({
    id: "b1",
    templateId: "t1",
    templateTitle: "T",
    status: "sending",
    recipients: [
      { phone: "+2348011111111", name: "A" },
      { phone: "+2348022222222", name: "B" },
    ],
  });
  // Simulate a crash after the first recipient was sent.
  store.markBroadcastRecipient("b1", "+2348011111111", { status: "sent", sentAt: new Date().toISOString() });

  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection, startScheduler: false });
  const base = await listen(api);
  try {
    const resumed = await api.resumeInterruptedBroadcasts();
    assert.deepEqual(resumed.map((b) => b.id), ["b1"]);

    const done = await waitFor(async () => {
      const b = await store.getBroadcast("b1");
      return b.status === "done" ? b : null;
    });
    assert.equal(done.sent, 2, "the running sent count includes the previously sent recipient");
    assert.equal(connection.sends.length, 1, "the already-sent recipient is not re-sent");
    assert.equal(connection.sends[0].to, "+2348022222222");
    assert.equal(connection.sends[0].content.text, "hey B");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("broadcasts: resume waits for an open connection before sending", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  store.saveTemplate({ id: "t1", title: "T", body: "hey {{name}}" });
  store.createBroadcast({
    id: "b1",
    templateId: "t1",
    status: "sending",
    recipients: [{ phone: "+2348011111111", name: "A" }],
  });

  let state = "connecting";
  const sends = [];
  const connection = {
    getStatus: () => ({ state }),
    sendMessage: async (to, content, email) => {
      sends.push({ to, content, email });
      return { key: { id: `sent-${to}` } };
    },
  };
  const api = createApiServer({ messageStore: store, connection, startScheduler: false });
  const base = await listen(api);
  try {
    assert.deepEqual(await api.resumeInterruptedBroadcasts(), [], "no resume while connecting");
    await sleep(10);
    assert.equal(sends.length, 0, "no recipient is failed against a closed socket");
    assert.equal(store.getBroadcast("b1").status, "sending");
    assert.equal(store.listBroadcastRecipients("b1")[0].status, "pending", "recipients stay pending");

    state = "open";
    const resumed = await api.resumeInterruptedBroadcasts();
    assert.deepEqual(resumed.map((b) => b.id), ["b1"]);
    const done = await waitFor(async () => {
      const b = await store.getBroadcast("b1");
      return b.status === "done" ? b : null;
    });
    assert.equal(done.sent, 1);
    assert.equal(sends.length, 1);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("broadcasts: a failing recipient is recorded without aborting the rest", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const sent = [];
  const connection = makeFakeConnection({
    sendMessage: async (to, content, email) => {
      if (to === "+2348022222222") throw new Error("2348022222222 is not on WhatsApp");
      sent.push({ to, content, email });
      return { key: { id: `sent-${to}` } };
    },
  });
  const api = createApiServer({ messageStore: store, connection, startScheduler: false });
  const base = await listen(api);
  try {
    const a = (await (await postJson(base, "/api/contacts", { name: "A", phone: "2348011111111" })).json()).contact;
    const b = (await (await postJson(base, "/api/contacts", { name: "B", phone: "2348022222222" })).json()).contact;
    const list = (await (await postJson(base, "/api/lists", { name: "L", contactIds: [a.id, b.id] })).json()).list;
    const template = (await (await postJson(base, "/api/templates", { title: "T", body: "hi {{name}}" })).json()).template;

    const { broadcast } = await (await postJson(base, "/api/broadcasts/send", {
      templateId: template.id,
      listIds: [list.id],
      minDelay: 0,
      maxDelay: 0,
    })).json();

    const done = await waitFor(async () => {
      const body = await (await fetch(`${base}/api/broadcasts/${broadcast.id}`)).json();
      return body.broadcast.status === "done" ? body : null;
    });
    assert.equal(done.broadcast.sent, 1);
    assert.equal(done.broadcast.failed, 1);
    assert.equal(sent.length, 1, "the healthy recipient still got the message");
    const failed = done.recipients.find((r) => r.status === "failed");
    assert.match(failed.error, /is not on WhatsApp/);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("broadcasts: zero recipients finish immediately and missing media returns 502", async () => {
  const mediaStore = createMediaStore({ dir: mkdtempSync(join(tmpdir(), "wa-bc-media-")) });
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, mediaStore, connection, startScheduler: false });
  const base = await listen(api);
  try {
    const emptyList = (await (await postJson(base, "/api/lists", { name: "Empty" })).json()).list;
    const template = (await (await postJson(base, "/api/templates", { title: "T", body: "hi" })).json()).template;

    const { broadcast } = await (await postJson(base, "/api/broadcasts/send", {
      templateId: template.id,
      listIds: [emptyList.id],
      minDelay: 0,
      maxDelay: 0,
    })).json();
    assert.equal(broadcast.total, 0);
    const done = await waitFor(async () => {
      const b = (await (await fetch(`${base}/api/broadcasts/${broadcast.id}`)).json()).broadcast;
      return b.status === "done" ? b : null;
    });
    assert.equal(done.sent, 0);
    assert.equal(connection.sends.length, 0);

    // A template whose stored media bytes are gone fails before anything is created.
    const broken = store.saveTemplate({
      title: "Broken",
      body: "",
      media: { key: "does-not-exist", type: "image", mimeType: "image/png", fileName: null },
    });
    const res = await postJson(base, "/api/broadcasts/send", { templateId: broken.id, listIds: [emptyList.id] });
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "template media could not be read");
    assert.equal((await (await fetch(`${base}/api/broadcasts`)).json()).broadcasts.length, 1, "the failed send isn't persisted");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("broadcasts: send validates the payload and referenced rows", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection, startScheduler: false });
  const base = await listen(api);
  try {
    const contact = (await (await postJson(base, "/api/contacts", { name: "A", phone: "2348011111111" })).json()).contact;
    const list = (await (await postJson(base, "/api/lists", { name: "L", contactIds: [contact.id] })).json()).list;
    const template = (await (await postJson(base, "/api/templates", { title: "T", body: "hi" })).json()).template;
    const send = (payload) => postJson(base, "/api/broadcasts/send", payload);
    const ok = { templateId: template.id, listIds: [list.id] };

    assert.equal((await send({ listIds: [list.id] })).status, 400, "templateId required");
    assert.equal((await send({ templateId: template.id })).status, 400, "listIds required");
    assert.equal((await send({ templateId: template.id, listIds: [] })).status, 400, "listIds non-empty");
    assert.equal((await send({ templateId: template.id, listIds: "nope" })).status, 400, "listIds must be an array");
    assert.equal((await send({ ...ok, minDelay: -1 })).status, 400, "minDelay >= 0");
    assert.equal((await send({ ...ok, maxDelay: 5000 })).status, 400, "maxDelay <= 3600");
    assert.equal((await send({ ...ok, minDelay: 30, maxDelay: 10 })).status, 400, "minDelay <= maxDelay");
    assert.equal((await send({ ...ok, sendAt: 123 })).status, 400, "sendAt must be a string");
    assert.equal((await send({ ...ok, sendAt: "not-a-date" })).status, 400, "sendAt must parse");
    assert.equal(
      (await send({ ...ok, sendAt: new Date(Date.now() - 1000).toISOString() })).status,
      400,
      "sendAt must be in the future"
    );
    assert.equal((await send({ ...ok, senderEmail: "x".repeat(321) })).status, 400, "senderEmail cap");
    assert.equal((await send({ templateId: "missing", listIds: [list.id] })).status, 404, "unknown template");
    assert.equal((await send({ templateId: template.id, listIds: ["missing"] })).status, 404, "unknown list");

    assert.equal(connection.sends.length, 0, "no send happened on any rejected request");
    assert.equal((await (await fetch(`${base}/api/broadcasts`)).json()).broadcasts.length, 0);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("broadcasts: send requires an open connection and a configured store", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const payload = { templateId: "t", listIds: ["l"] };

  // No connection at all -> 503; reads still work.
  const noConn = createApiServer({ messageStore: store, startScheduler: false });
  const baseNoConn = await listen(noConn);
  try {
    assert.equal((await postJson(baseNoConn, "/api/broadcasts/send", payload)).status, 503);
    assert.equal((await fetch(`${baseNoConn}/api/broadcasts`)).status, 200);
  } finally {
    await closeApi(noConn);
  }

  // A closed connection -> 409.
  const closed = makeFakeConnection({ state: "close" });
  const apiClosed = createApiServer({ messageStore: store, connection: closed, startScheduler: false });
  const baseClosed = await listen(apiClosed);
  try {
    assert.equal((await postJson(baseClosed, "/api/broadcasts/send", payload)).status, 409);
  } finally {
    await closeApi(apiClosed);
  }

  // No store at all -> 503.
  const bare = createApiServer({ startScheduler: false });
  const baseBare = await listen(bare);
  try {
    assert.equal((await fetch(`${baseBare}/api/broadcasts`)).status, 503);
    assert.equal((await postJson(baseBare, "/api/broadcasts/send", payload)).status, 503);
  } finally {
    await closeApi(bare);
    store.close();
  }
});

test("broadcasts: the API token protects the send route when configured", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection, apiToken: "secret", startScheduler: false });
  const base = await listen(api);
  try {
    const a = (await (await postJson(base, "/api/contacts", { name: "A", phone: "2348011111111" })).json()).contact;
    const list = (await (await postJson(base, "/api/lists", { name: "L", contactIds: [a.id] })).json()).list;
    const template = (await (await postJson(base, "/api/templates", { title: "T", body: "hi" })).json()).template;
    const payload = { templateId: template.id, listIds: [list.id] };

    assert.equal((await postJson(base, "/api/broadcasts/send", payload)).status, 401);
    assert.equal(
      (await fetch(`${base}/api/broadcasts/send`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-token": "wrong" },
        body: JSON.stringify(payload),
      })).status,
      401
    );
    assert.equal(connection.sends.length, 0);

    const ok = await fetch(`${base}/api/broadcasts/send`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-token": "secret" },
      body: JSON.stringify({ ...payload, minDelay: 0, maxDelay: 0 }),
    });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(`${base}/api/broadcasts`)).status, 200, "history reads are token-free");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("broadcasts: more than 5000 resolved recipients is rejected with 413", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const connection = makeFakeConnection();
  const api = createApiServer({ messageStore: store, connection, startScheduler: false });
  const base = await listen(api);
  try {
    const rows = [];
    for (let i = 0; i < 5001; i++) {
      rows.push({ name: `C${i}`, phone: `+23480${String(i).padStart(8, "0")}` });
    }
    store.importContacts(rows);
    const contacts = store.listContacts();
    assert.equal(contacts.length, 5001);
    const list = store.createList({ name: "Big", contactIds: contacts.map((c) => c.id) });
    const template = (await (await postJson(base, "/api/templates", { title: "T", body: "hi" })).json()).template;

    const res = await postJson(base, "/api/broadcasts/send", { templateId: template.id, listIds: [list.id] });
    assert.equal(res.status, 413);
    assert.equal(connection.sends.length, 0, "nothing is sent");
    assert.equal((await (await fetch(`${base}/api/broadcasts`)).json()).broadcasts.length, 0, "nothing is persisted");
  } finally {
    await closeApi(api);
    store.close();
  }
});

/* ------------------------------------------------------------------ */
/*  Group info (GET /api/groups/:jid)                                  */
/* ------------------------------------------------------------------ */

const GROUP_LID = "225159969521788@lid";
const GROUP_PN = "2348052928072@s.whatsapp.net";
const GROUP_JID = "120363412224156592@g.us";
const GROUP_CREATION = new Date(1700000000 * 1000).toISOString();

function groupConnection({ state = "open", meta, error } = {}) {
  return {
    getStatus: () => ({ state }),
    groupMetadata: async (jid) => {
      if (error) throw error;
      return meta ?? { id: jid };
    },
  };
}

test("GET /api/groups/:jid returns live metadata with participant names", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  store.setChatName(GROUP_LID, "Joshua Ayeni"); // stored names decorate participants

  const connection = groupConnection({
    meta: {
      id: GROUP_JID,
      subject: "Family",
      desc: "house stuff",
      owner: GROUP_PN,
      ownerPn: GROUP_PN,
      creation: 1700000000,
      size: 2,
      announce: true,
      restrict: true,
      isCommunity: false,
      ephemeralDuration: 86400,
      participants: [
        { id: GROUP_LID, phoneNumber: GROUP_PN, username: "josh", admin: "admin" },
        { id: GROUP_PN, username: "bob" },
      ],
    },
  });
  const api = createApiServer({ messageStore: store, connection, startScheduler: false });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/groups/${encodeURIComponent(GROUP_JID)}`);
    assert.equal(res.status, 200);
    const { group } = await res.json();

    assert.equal(group.jid, GROUP_JID);
    assert.equal(group.name, "Family");
    assert.equal(group.description, "house stuff");
    assert.equal(group.owner, GROUP_PN);
    assert.equal(group.createdAt, GROUP_CREATION);
    assert.equal(group.size, 2);
    assert.equal(group.announce, true);
    assert.equal(group.restrict, true);
    assert.equal(group.isCommunity, false);
    assert.equal(group.ephemeralDuration, 86400);

    assert.equal(group.participants.length, 2);
    assert.equal(group.participants[0].id, GROUP_LID, "participant ids are canonical");
    assert.equal(group.participants[0].name, "Joshua Ayeni", "stored chat names enrich participants");
    assert.equal(group.participants[0].username, "josh");
    assert.equal(group.participants[0].phone, "2348052928072");
    assert.equal(group.participants[0].admin, "admin");
    assert.equal(group.participants[1].id, GROUP_PN);
    assert.equal(group.participants[1].name, null);
    assert.equal(group.participants[1].username, "bob");
    assert.equal(group.participants[1].phone, "2348052928072");
    assert.equal(group.participants[1].admin, null);

    // The live subject is re-persisted so the inbox list shows it too.
    assert.equal(store.resolveChatName(GROUP_JID), "Family");
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("GET /api/groups/:jid guards connection/state and maps failures", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });

  // No connection -> 503.
  const bare = createApiServer({ messageStore: store, startScheduler: false });
  const baseBare = await listen(bare);
  try {
    assert.equal((await fetch(`${baseBare}/api/groups/${encodeURIComponent(GROUP_JID)}`)).status, 503);
  } finally {
    await closeApi(bare);
  }

  // Not open -> 409.
  const closed = createApiServer({ messageStore: store, connection: groupConnection({ state: "qr" }), startScheduler: false });
  const baseClosed = await listen(closed);
  try {
    assert.equal((await fetch(`${baseClosed}/api/groups/${encodeURIComponent(GROUP_JID)}`)).status, 409);
  } finally {
    await closeApi(closed);
  }

  // Baileys 404 (unknown group) -> 404.
  const notFound = createApiServer({
    messageStore: store,
    connection: groupConnection({ error: { output: { statusCode: 404 } } }),
    startScheduler: false,
  });
  const baseNotFound = await listen(notFound);
  try {
    assert.equal((await fetch(`${baseNotFound}/api/groups/${encodeURIComponent(GROUP_JID)}`)).status, 404);
  } finally {
    await closeApi(notFound);
  }

  // Any other fetch error -> 502.
  const failed = createApiServer({
    messageStore: store,
    connection: groupConnection({ error: new Error("iq timeout") }),
    startScheduler: false,
  });
  const baseFailed = await listen(failed);
  try {
    assert.equal((await fetch(`${baseFailed}/api/groups/${encodeURIComponent(GROUP_JID)}`)).status, 502);
  } finally {
    await closeApi(failed);
  }

  // No groupMetadata implementation -> 502.
  const raw = createApiServer({
    messageStore: store,
    connection: { getStatus: () => ({ state: "open" }) },
    startScheduler: false,
  });
  const baseRaw = await listen(raw);
  try {
    assert.equal((await fetch(`${baseRaw}/api/groups/${encodeURIComponent(GROUP_JID)}`)).status, 502);
  } finally {
    await closeApi(raw);
  }

  store.close();
});