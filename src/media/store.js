import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Media kinds the send API accepts and the connection persists. */
export const MEDIA_TYPES = ["image", "video", "audio", "document"];

/** Maps a Baileys message content kind to one of MEDIA_TYPES. */
export const MESSAGE_KIND_TO_TYPE = {
  imageMessage: "image",
  videoMessage: "video",
  audioMessage: "audio",
  documentMessage: "document",
  stickerMessage: "image", // stickers render like images
};

const DEFAULT_MIME = {
  image: "image/jpeg",
  video: "video/mp4",
  audio: "audio/ogg",
  document: "application/octet-stream",
};

/** Keys must never be able to escape the media dir. */
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * Maps an arbitrary id to a safe file key: strip every character that isn't
 * [A-Za-z0-9._-], falling back to the sha256 hex digest when nothing remains
 * (guards path traversal and odd WhatsApp ids).
 */
export function sanitizeKey(id) {
  const stripped = String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "");
  if (stripped) return stripped;
  return createHash("sha256").update(String(id ?? "")).digest("hex");
}

/**
 * On-disk store for media bytes, keyed by a sanitized media id.
 *
 * Each item is <dir>/<key> (raw bytes) plus <dir>/<key>.json (a sidecar with
 * { type, mimeType, fileName }), so GET /api/media/:messageId can serve the
 * bytes without a database round-trip.
 *
 * save() enforces maxBytes (returning null for oversized payloads) so neither
 * an oversized API upload nor a giant inbound download can fill the disk.
 *
 * @param {object}  [options]
 * @param {string}  [options.dir="./data/media"]  folder for the bytes.
 * @param {number}  [options.maxBytes=20*1024*1024] per-item byte cap.
 */
export function createMediaStore({ dir = "./data/media", maxBytes = 20 * 1024 * 1024 } = {}) {
  mkdirSync(dir, { recursive: true });
  const bytesFile = (key) => join(dir, key);
  const metaFile = (key) => join(dir, `${key}.json`);

  return {
    /**
     * Writes the bytes plus a JSON sidecar for the given id.
     * @returns {Promise<{ key, type, mimeType, fileName } | null>} null when
     *          the payload is empty or over maxBytes, or id is unusable.
     */
    async save({ id, buffer, type, mimeType, fileName }) {
      if (!id || !Buffer.isBuffer(buffer) || !buffer.length) return null;
      if (buffer.length > maxBytes) return null; // oversized: refuse to fill the disk
      const key = sanitizeKey(id);
      const meta = {
        type: MEDIA_TYPES.includes(type) ? type : null,
        mimeType: mimeType ?? DEFAULT_MIME[type] ?? "application/octet-stream",
        fileName: fileName ?? null,
      };
      writeFileSync(bytesFile(key), buffer);
      writeFileSync(metaFile(key), JSON.stringify(meta));
      return { key, ...meta };
    },

    /**
     * Reads one item back: raw bytes + sidecar metadata.
     * Refuses keys that could escape the dir (anything outside the safe set,
     * i.e. "/", "\", "..", ... all collapse to a mismatch or get rejected).
     * @returns {Promise<{ buffer, mimeType, fileName } | null>}
     */
    async read(key) {
      if (!SAFE_KEY.test(key) || sanitizeKey(key) !== key) return null;
      try {
        const buffer = readFileSync(bytesFile(key));
        let meta = {};
        try {
          meta = JSON.parse(readFileSync(metaFile(key), "utf-8"));
        } catch {
          // sidecar missing/corrupt: still serve the bytes with defaults
        }
        return {
          buffer,
          mimeType: meta.mimeType ?? "application/octet-stream",
          fileName: meta.fileName ?? null,
        };
      } catch {
        return null; // unknown id (or bytes deleted)
      }
    },
  };
}