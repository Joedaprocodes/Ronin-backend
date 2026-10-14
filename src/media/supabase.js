import { createClient } from "@supabase/supabase-js";
import { DEFAULT_MIME, MEDIA_TYPES, sanitizeKey } from "./store.js";

/** Keys must never be able to escape the bucket (mirrors the disk store). */
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

/** Suffix of the per-item metadata object (<key>.json). */
const SIDECAR = ".json";

/** How many objects list() returns per page (Supabase caps this). */
const LIST_PAGE = 1000;

/** How many objects remove() deletes per request. */
const REMOVE_BATCH = 100;

/**
 * Supabase Storage-backed media store, used in production instead of the local
 * disk (development keeps the on-disk store from ./store.js).
 *
 * The bucket is created on first use and is **public-read** so the browser can
 * load <img>/<video>/<audio> straight from Supabase (the URL is returned in the
 * stored media ref and served by the CDN, so the API server never proxies the
 * bytes). Object paths are flat, sanitized keys, so the URL is unguessable in
 * practice — the same posture as the unauthenticated GET /api/media/:id route.
 *
 * Each item is two objects: <key> (raw bytes, content-type = mimeType) plus
 * <key>.json (a { type, mimeType, fileName } sidecar) so read() can hand the
 * server the original fileName without a database round-trip. save() enforces
 * maxBytes (returning null for oversized payloads), exactly like the disk store.
 *
 * The returned ref is { key, url, type, mimeType, fileName }; the `url` is what
 * message/template views surface as media.url (falling back to /api/media/<key>
 * for refs written before the bucket existed).
 *
 * @param {object}   [options]
 * @param {string}   [options.url]              Supabase project URL.
 * @param {string}   [options.serviceRoleKey]   server-only service-role key.
 * @param {string}   [options.bucket="media"]   storage bucket name.
 * @param {number}   [options.maxBytes=20*1024*1024] per-item byte cap.
 * @param {object}   [options.client]           injected supabase client (tests).
 */
export function createSupabaseMediaStore({
  url,
  serviceRoleKey,
  bucket = "media",
  maxBytes = 20 * 1024 * 1024,
  client,
} = {}) {
  if (!client && (!url || !serviceRoleKey)) {
    throw new Error(
      "createSupabaseMediaStore requires url + serviceRoleKey (or an injected client)"
    );
  }
  const supabase = client ?? createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const storage = supabase.storage.from(bucket);

  // Create the bucket the first time it's needed. Best-effort: a failure is
  // logged and the operation proceeds (surfacing its own error) so a transient
  // admin hiccup doesn't crash startup.
  let ready = null;
  function ensureBucket() {
    if (!ready) {
      ready = (async () => {
        try {
          const { error } = await supabase.storage.getBucket(bucket);
          if (!error) return;
          const created = await supabase.storage.createBucket(bucket, { public: true });
          if (created?.error) {
            console.error(
              `[media] could not create Supabase bucket "${bucket}": ${created.error.message}`
            );
          } else {
            console.log(`[media] created public Supabase storage bucket "${bucket}"`);
          }
        } catch (err) {
          console.error(`[media] Supabase bucket check failed: ${err?.message ?? err}`);
        }
      })();
    }
    return ready;
  }

  /** The CDN URL the browser uses to fetch the raw bytes. */
  function publicUrl(key) {
    return storage.getPublicUrl(key).data.publicUrl;
  }

  return {
    /**
     * Uploads the bytes plus a JSON sidecar for the given id.
     * @returns {Promise<{ key, url, type, mimeType, fileName } | null>} null when
     *          the payload is empty/over maxBytes or the upload failed.
     */
    async save({ id, buffer, type, mimeType, fileName }) {
      if (!id || !Buffer.isBuffer(buffer) || !buffer.length) return null;
      if (buffer.length > maxBytes) return null;
      const key = sanitizeKey(id);
      const kind = MEDIA_TYPES.includes(type) ? type : null;
      const contentType = mimeType ?? DEFAULT_MIME[type] ?? "application/octet-stream";
      const meta = { type: kind, mimeType: contentType, fileName: fileName ?? null };

      await ensureBucket();
      const { error } = await storage.upload(key, buffer, {
        contentType,
        upsert: true, // redelivered ids / pre-echo sends must be overwritable
      });
      if (error) return null;
      // Sidecar is best-effort: the browser never reads it, only read() does.
      try {
        await storage.upload(`${key}${SIDECAR}`, JSON.stringify(meta), {
          contentType: "application/json",
          upsert: true,
        });
      } catch {
        // ignore: bytes are stored, metadata falls back to content-type
      }

      return { key, url: publicUrl(key), type: kind, mimeType: contentType, fileName: meta.fileName };
    },

    /**
     * Downloads an item (bytes + sidecar metadata).
     * @returns {Promise<{ buffer, mimeType, fileName } | null>} null when the
     *          object is missing or the key is unusable.
     */
    async read(key) {
      if (typeof key !== "string" || !SAFE_KEY.test(key) || sanitizeKey(key) !== key) {
        return null;
      }
      const { data, error } = await storage.download(key);
      if (error || !data) return null;
      let buffer;
      try {
        buffer = Buffer.from(await data.arrayBuffer());
      } catch {
        return null;
      }
      let meta = {};
      try {
        const side = await storage.download(`${key}${SIDECAR}`);
        if (!side.error && side.data) meta = JSON.parse(await side.data.text());
      } catch {
        // sidecar missing/corrupt: serve the bytes with defaults
      }
      return {
        buffer,
        mimeType: meta.mimeType ?? data.type ?? "application/octet-stream",
        fileName: meta.fileName ?? null,
      };
    },

    /**
     * Deletes every object in the bucket (bytes + sidecars). Best-effort: a
     * failed batch is skipped rather than aborting the sweep.
     * @returns {Promise<number>} how many objects were removed
     */
    async clearAll() {
      const names = [];
      for (let offset = 0; ; offset += LIST_PAGE) {
        const { data, error } = await storage.list("", { limit: LIST_PAGE, offset });
        if (error || !data?.length) break;
        names.push(...data.map((o) => o.name));
        if (data.length < LIST_PAGE) break;
      }
      let removed = 0;
      for (let i = 0; i < names.length; i += REMOVE_BATCH) {
        const batch = names.slice(i, i + REMOVE_BATCH);
        const { error } = await storage.remove(batch);
        if (!error) removed += batch.length;
      }
      return removed;
    },
  };
}
