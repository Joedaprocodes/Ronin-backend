import { fetchLatestBaileysVersion, getContentType } from "@whiskeysockets/baileys";
import { MESSAGE_KIND_TO_TYPE } from "../media/store.js";

export const MAX_BACKOFF_MS = 30_000;
export const PAIRING_CODE_TTL_MS = 3 * 60 * 1000; // ask for a fresh code once the old one expires
export const JID_CACHE_TTL_MS = 10 * 60 * 1000; // how long a number -> JID lookup is reused
export const GROUP_META_TTL_MS = 60 * 1000; // how long group metadata is reused for guard checks
// How long a persisted group snapshot is trusted for GET /api/groups/:jid.
// Socket broadcasts (join/leave/promote/rename) keep it current while
// connected; this TTL is only the backstop for events missed while offline.
export const GROUP_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SEEN_IDS = 2000; // how many recent message ids we keep to drop redeliveries

// fetchLatestBaileysVersion() hits the network, so fetch it once and reuse it.
// On failure the cache is cleared so the next call tries again.
let versionPromise = null;
export function getBaileysVersion() {
  versionPromise ??= fetchLatestBaileysVersion().catch((err) => {
    versionPromise = null;
    throw err;
  });
  return versionPromise;
}

/** Pulls the human-readable text out of the many shapes a WhatsApp message can take. */
export function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    message.documentWithCaptionMessage?.message?.documentMessage?.caption ??
    message.buttonsResponseMessage?.selectedDisplayText ??
    message.buttonsResponseMessage?.selectedButtonId ??
    message.templateButtonReplyMessage?.selectedDisplayText ??
    message.templateButtonReplyMessage?.selectedId ??
    message.listResponseMessage?.title ??
    message.listResponseMessage?.singleSelectReply?.selectedRowId ??
    message.reactionMessage?.text ??
    message.pollCreationMessage?.name ??
    null
  );
}

/** The numeric user part of a jid ("123:4@s.whatsapp.net" -> "123"). */
function jidUser(jid) {
  if (typeof jid !== "string") return "";
  return jid.split("@")[0].split(":")[0];
}

// Wrappers that hide the real content node (whose `contextInfo` we want).
const CONTENT_WRAPPERS = [
  "ephemeralMessage",
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "documentWithCaptionMessage",
];

/**
 * The `contextInfo` of a message's content node, whichever shape it takes.
 * A plain text message ({ conversation }) has none; a reply carries it on its
 * text/media node (e.g. `extendedTextMessage.contextInfo`). Wrapper messages
 * are unwrapped one level at a time.
 */
function findContextInfo(message) {
  if (!message || typeof message !== "object") return null;
  for (const value of Object.values(message)) {
    if (value && typeof value === "object" && value.contextInfo) {
      return value.contextInfo;
    }
  }
  for (const wrapper of CONTENT_WRAPPERS) {
    const found = findContextInfo(message[wrapper]?.message);
    if (found) return found;
  }
  return null;
}

/**
 * Builds the display-only snapshot of a quoted message:
 *   { id, text, media?: { type }, sender?, fromMe? }
 * `media` carries only the bucket (image/video/audio/document) — the quote is
 * shown as an icon + label, never the bytes. Returns null when there is nothing
 * worth showing.
 */
function quotedSnapshot({ id = null, message = null, sender = null, fromMe = false }) {
  if (!message) return null;
  const kind = getContentType(message);
  const mediaType = kind ? MESSAGE_KIND_TO_TYPE[kind] : null;
  const text = extractText(message) ?? "";
  if (!text && !mediaType) return null;

  const snapshot = { id: id ?? null, text };
  if (mediaType) snapshot.media = { type: mediaType };
  if (sender) {
    snapshot.sender = sender;
    snapshot.fromMe = Boolean(fromMe);
  }
  return snapshot;
}

/**
 * The message THIS one replies to, read from a WhatsApp reply's
 * `contextInfo.quotedMessage`. `ownJid` (the linked account) marks a quoted
 * message of our own so the UI can label it "You". Returns null when the
 * message isn't a reply.
 */
export function extractQuoted(message, ownJid = null) {
  const contextInfo = findContextInfo(message);
  const quotedMessage = contextInfo?.quotedMessage;
  if (!contextInfo || !quotedMessage) return null;

  const participant = contextInfo.participant ?? null;
  return quotedSnapshot({
    id: contextInfo.stanzaId,
    message: quotedMessage,
    sender: participant,
    fromMe: Boolean(participant && jidUser(participant) === jidUser(ownJid)),
  });
}

/**
 * The snapshot for an OUTGOING quoted reply, taken from the send target
 * (a Baileys `{ key, message }` — the message being quoted). Used so our own
 * (and automation's) quoted replies render with the same quote block.
 */
export function quotedFromTarget(target, ownJid = null) {
  const message = target?.message;
  if (!message) return null;
  const key = target?.key ?? {};
  const participant = key.participant ?? null;
  return quotedSnapshot({
    id: key.id,
    message,
    sender: participant,
    fromMe: Boolean(
      key.fromMe || (participant && jidUser(participant) === jidUser(ownJid))
    ),
  });
}