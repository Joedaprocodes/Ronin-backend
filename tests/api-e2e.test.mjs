// End-to-end: real WhatsAppConnection (baileys stubbed in-process) + SQLite
// store + HTTP API, exercising the acceptance criteria:
//   - deterministic sends (immediate GET contains the sent message)
//   - media round-trip (view.media on reload, /api/media serves the bytes)
//   - SSE frames for both incoming and outgoing messages
import "./helpers/loader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { WhatsAppConnection } = await import("../src/whatsapp/connection.js");
const { createSqliteMessageStore } = await import("../src/db/sqlite.js");
const { createMediaStore } = await import("../src/media/store.js");
const { createApiServer } = await import("../src/api/server.js");
const { __reset, __sockets } = await import("./helpers/baileys-stub.mjs");

const JID = "15551234567@s.whatsapp.net";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 2000, step = 5) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(step);
  }
}

function makeAuth() {
  const state = { cleared: 0 };
  return {
    state,
    load: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
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

function listen(api) {
  return new Promise((resolve) => {
    api.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${api.address().port}`));
  });
}

function closeApi(api) {
  api.closeAllConnections?.();
  return new Promise((resolve) => api.close(resolve));
}

const b64 = (str) => Buffer.from(str).toString("base64");

function openEvents(base) {
  return fetch(`${base}/api/events`).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const queue = [];
    let pending = null;
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

test("send is deterministic: 200 body + immediate GET share the persisted message", async () => {
  __reset();
  const store = createSqliteMessageStore({ file: ":memory:" });
  const mediaStore = createMediaStore({ dir: mkdtempSync(join(tmpdir(), "wa-e2e-media-")) });
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store, mediaStore });
  await wa.start();
  await openConnection(wa);
  const api = createApiServer({ messageStore: store, connection: wa, mediaStore });
  const base = await listen(api);
  try {
    const res = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello", email: "jane@gmail.com" }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.jid, JID);
    assert.equal(data.message.from, "me");
    assert.equal(data.message.text, "hello");
    assert.ok(data.message.time);

    // Immediate reload must already contain the sent message.
    const threadRes = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}`);
    assert.equal(threadRes.status, 200);
    const { conversation } = await threadRes.json();
    assert.equal(conversation.id, JID, "conversation id === jid");
    assert.equal(conversation.jid, JID);
    const mine = conversation.messages.find((m) => m.id === data.id);
    assert.ok(mine, "sent message visible in the thread straight away");
    assert.equal(mine.from, "me");
    assert.equal(mine.time, data.message.time, "send response time matches the stored row");
  } finally {
    await closeApi(api);
    await wa.stop();
    store.close();
  }
});

test("media round-trips: stored bytes, media view on reload, working /api/media url", async () => {
  __reset();
  const store = createSqliteMessageStore({ file: ":memory:" });
  const mediaStore = createMediaStore({ dir: mkdtempSync(join(tmpdir(), "wa-e2e-media-")) });
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store, mediaStore });
  await wa.start();
  await openConnection(wa);
  const api = createApiServer({ messageStore: store, connection: wa, mediaStore });
  const base = await listen(api);
  const jid = encodeURIComponent(JID);
  const post = (body) =>
    fetch(`${base}/api/inbox/${jid}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const res = await post({
      text: "pic",
      media: { type: "image", data: jpeg.toString("base64"), caption: "the photo", mimeType: "image/jpeg" },
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.message.media.type, "image");
    assert.equal(data.message.media.mimeType, "image/jpeg");
    assert.equal(data.message.media.fileName, null);
    assert.match(data.message.media.url, new RegExp(`^/api/media/${data.id}$`));
    assert.equal(data.message.text, "the photo", "caption is the message text");

    // The url must serve the exact bytes with the right content-type.
    const mediaRes = await fetch(`${base}${data.message.media.url}`);
    assert.equal(mediaRes.status, 200);
    assert.equal(mediaRes.headers.get("content-type"), "image/jpeg");
    assert.deepEqual(Buffer.from(await mediaRes.arrayBuffer()), jpeg);

    // Reloading the thread keeps the media object.
    const thread = await (await fetch(`${base}/api/inbox/${jid}`)).json();
    const reloaded = thread.conversation.messages.find((m) => m.id === data.id);
    assert.deepEqual(reloaded.media, data.message.media, "reloaded view carries the media object");

    // Documents keep their file name for Content-Disposition.
    const doc = await post({
      media: { type: "document", data: b64("PDF!"), fileName: "guide.pdf", mimeType: "application/pdf" },
    });
    const dData = await doc.json();
    assert.equal(dData.message.media.fileName, "guide.pdf");
    const docRes = await fetch(`${base}${dData.message.media.url}`);
    assert.equal(docRes.status, 200);
    assert.equal(docRes.headers.get("content-type"), "application/pdf");
    assert.match(docRes.headers.get("content-disposition"), /inline; filename="guide\.pdf"/);
    assert.equal(await docRes.text(), "PDF!");
  } finally {
    await closeApi(api);
    await wa.stop();
    store.close();
  }
});

test("pagination e2e: ?limit=3 then &before= returns pages that union the thread", async () => {
  __reset();
  const store = createSqliteMessageStore({ file: ":memory:" });
  const api = createApiServer({ messageStore: store });
  const base = await listen(api);
  const jid = encodeURIComponent(JID);
  try {
    const baseTs = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      store.save({
        id: `e2e-${i}`,
        chat: JID,
        isGroup: false,
        fromMe: false,
        sender: JID,
        text: `hello ${i}`,
        receivedAt: baseTs + i * 1000,
        raw: { key: { id: `e2e-${i}` }, pushName: "Ada" },
      });
    }

    const full = await (await fetch(`${base}/api/inbox/${jid}`)).json();
    assert.equal(full.conversation.messages.length, 5);

    const p1 = await (await fetch(`${base}/api/inbox/${jid}?limit=3`)).json();
    assert.deepEqual(p1.conversation.messages.map((m) => m.id), ["e2e-2", "e2e-3", "e2e-4"]);
    assert.equal(p1.hasMore, true);
    assert.ok(p1.nextBefore);

    const p2 = await (
      await fetch(`${base}/api/inbox/${jid}?limit=3&before=${encodeURIComponent(p1.nextBefore)}`)
    ).json();
    assert.deepEqual(p2.conversation.messages.map((m) => m.id), ["e2e-0", "e2e-1"]);
    assert.equal(p2.hasMore, false);
    assert.equal(p2.nextBefore, null);

    const union = [...p1.conversation.messages, ...p2.conversation.messages].map((m) => m.id);
    const order = new Map(full.conversation.messages.map((m, i) => [m.id, i]));
    assert.deepEqual(
      [...union].sort((a, b) => order.get(a) - order.get(b)),
      full.conversation.messages.map((m) => m.id),
      "page1 + page2 union equals the full thread"
    );
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("SSE streams incoming and outgoing messages as they happen", async () => {
  __reset();
  const store = createSqliteMessageStore({ file: ":memory:" });
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  await wa.start();
  await openConnection(wa);
  const sock = __sockets().at(-1);
  const api = createApiServer({ messageStore: store, connection: wa });
  const base = await listen(api);

  const stream = await openEvents(base);
  try {
    await stream.next(); // consume ": connected"

    // Incoming message from the phone.
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { id: "in-9", remoteJid: JID, fromMe: false },
          pushName: "Ada Okafor",
          message: { conversation: "are you there?" },
        },
      ],
    });
    const incoming = JSON.parse((await stream.next()).replace(/^data: /, ""));
    assert.equal(incoming.jid, JID);
    assert.equal(incoming.message.id, "in-9");
    assert.equal(incoming.message.from, "them");
    assert.equal(incoming.message.text, "are you there?");

    // Outgoing message via the API.
    const sent = await fetch(`${base}/api/inbox/${encodeURIComponent(JID)}/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "yes, here" }),
    });
    assert.equal(sent.status, 200);
    const outgoing = JSON.parse((await stream.next()).replace(/^data: /, ""));
    assert.equal(outgoing.jid, JID);
    assert.equal(outgoing.message.from, "me");
    assert.equal(outgoing.message.text, "yes, here");
  } finally {
    await stream.stop();
    await closeApi(api);
    await wa.stop();
    store.close();
  }
});