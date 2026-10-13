import { fetchLatestBaileysVersion } from "@whiskeysockets/baileys";

export const MAX_BACKOFF_MS = 30_000;
export const PAIRING_CODE_TTL_MS = 3 * 60 * 1000; // ask for a fresh code once the old one expires
export const JID_CACHE_TTL_MS = 10 * 60 * 1000; // how long a number -> JID lookup is reused
export const GROUP_META_TTL_MS = 60 * 1000; // how long group metadata is reused for guard checks
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