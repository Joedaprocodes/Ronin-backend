import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";

export const DisconnectReason = {
  connectionClosed: 428,
  connectionLost: 408,
  loggedOut: 401,
  connectionReplaced: 440,
  restartRequired: 515,
};

// Mirrors the real library's Browsers helpers (canonical [OS, browser, version]).
export const Browsers = {
  ubuntu: (browser) => ["Ubuntu", browser, "22.04.4"],
  macOS: (browser) => ["Mac OS", browser, "14.4.1"],
  baileys: (browser) => ["Baileys", browser, "6.5.0"],
  windows: (browser) => ["Windows", browser, "10.0.22631"],
  android: (browser) => [browser, "Android", ""],
};

// Same shape as the real library: buffers serialize to base64 in { type, data }.
export const BufferJSON = {
  replacer(key, value) {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { type: "Buffer", data: Buffer.from(value).toString("base64") };
    }
    return value;
  },
  reviver(key, value) {
    if (value?.type === "Buffer" && typeof value.data === "string") {
      return Buffer.from(value.data, "base64");
    }
    return value;
  },
};
export const fetchLatestBaileysVersion = async () => ({ version: [2, 3000, 0], isLatest: true });
export const makeCacheableSignalKeyStore = (keys) => keys;
export const useMultiFileAuthState = async () => ({
  state: { creds: {}, keys: {} },
  saveCreds: async () => {},
});

const MEDIA_KINDS = ["imageMessage", "videoMessage", "audioMessage", "documentMessage", "stickerMessage"];

/** Matches the real library's default media CDN host. */
export const DEF_MEDIA_HOST = "mmg.whatsapp.net";

/** Every options object downloadMediaMessage was called with (newest last). */
export const __downloadCalls = [];

/** Mirrors Baileys getContentType: the first known media/... content key. */
export function getContentType(content) {
  if (!content) return null;
  for (const kind of MEDIA_KINDS) {
    if (content[kind]) return kind;
  }
  return null;
}

/** Mirrors Baileys normalizeMessageContent: unwraps future-proof and protocol wrappers. */
export function normalizeMessageContent(content) {
  if (!content) return undefined;
  for (let i = 0; i < 5; i++) {
    const inner =
      content?.ephemeralMessage ||
      content?.viewOnceMessage ||
      content?.documentWithCaptionMessage ||
      content?.viewOnceMessageV2 ||
      content?.viewOnceMessageV2Extension ||
      content?.editedMessage ||
      content?.associatedChildMessage ||
      content?.groupStatusMessage ||
      content?.groupStatusMessageV2;
    if (!inner) break;
    content = inner.message;
  }
  return content;
}

/**
 * Stub downloadMediaMessage: returns deterministic bytes derived from the
 * content kind + caption/url so tests can assert stored/vs-served round-trips.
 * url === "fail" simulates a download error.
 */
export async function downloadMediaMessage(message, type, options, ctx) {
  __downloadCalls.push(options ?? {});
  const kind = getContentType(message?.message);
  if (!kind) throw new Error("no media in message");
  const payload = message.message[kind];
  if (payload?.url === "fail") throw new Error("download failed");
  return Buffer.from(`${kind}:${payload?.caption ?? payload?.fileName ?? payload?.url ?? "bytes"}`);
}

/** Mirrors Baileys sha256 (used to hash poll option names). */
export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest();
}

/**
 * Test hook for poll votes. Register the decrypted `vote` object the engine
 * should see for a poll message id (and, optionally, a specific voter jid).
 * `decryptPollVote` returns it, standing in for the real HMAC decryption.
 */
const pollVotes = new Map();
export function __setPollVote(pollMsgId, vote, voterJid = null) {
  pollVotes.set(voterJid ? `${pollMsgId}\u0000${voterJid}` : pollMsgId, vote);
}

/** Stub decryptPollVote: returns the registered vote (see __setPollVote). */
export function decryptPollVote(_enc, { pollMsgId, voterJid } = {}) {
  const pair = pollVotes.get(`${pollMsgId}\u0000${voterJid}`);
  if (pair !== undefined) return pair;
  const single = pollVotes.get(pollMsgId);
  if (typeof single === "function") return single({ pollMsgId, voterJid });
  if (single !== undefined) return single;
  throw new Error("stub: no poll vote registered");
}

const sockets = [];
let sentCounter = 0;
let groupMetas = {};
export function __sockets() {
  return sockets;
}
export function __setGroupMetas(map) {
  groupMetas = new Map(Object.entries(map ?? {}));
}
export function __reset() {
  sockets.length = 0;
  sentCounter = 0;
  groupMetas = new Map();
  pollVotes.clear();
  __downloadCalls.length = 0;
}

export default function makeWASocket() {
  const ev = new EventEmitter();
  const sock = {
    ev,
    ended: false,
    loggedOut: false,
    user: { id: "1234@s.whatsapp.net", name: "Tester" },
    onWhatsAppCalls: 0,
    sent: [],
    participantUpdates: [],
    end: async (err) => {
      sock.ended = true;
      // real Baileys end() emits the close event before resolving
      ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: err ? { error: { output: { statusCode: err.statusCode } } } : undefined,
      });
    },
    logout: async () => {
      sock.loggedOut = true;
    },
    requestPairingCode: async () => "ABCDEFGH",
    onWhatsApp: async (jid) => {
      sock.onWhatsAppCalls++;
      return [{ jid, exists: true }];
    },
    sendMessage: async (jid, content) => {
      const key = { id: `sent-${++sentCounter}`, remoteJid: jid, fromMe: true };
      // `at` lets tests assert the real ordering/pauses between sends.
      sock.sent.push({ jid, content, key, at: Date.now() });
      return { key, message: content };
    },
    groupMetadata: async (jid) => groupMetas.get(jid) ?? null,
    groupFetchAllParticipating: async () => Object.fromEntries(groupMetas),
    groupParticipantsUpdate: async (jid, participants, action) => {
      sock.participantUpdates.push({ jid, participants, action });
      return participants.map((p) => ({ jid: p, status: "200" }));
    },
  };
  sockets.push(sock);
  return sock;
}