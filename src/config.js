import pg from "pg";
import { createPostgresAuth } from "./db/session.js";
import { createPostgresMessageStore } from "./db/messages.js";
import { createSqliteMessageStore } from "./db/sqlite.js";
import { createMediaStore } from "./media/store.js";
import { createSupabaseMediaStore } from "./media/supabase.js";

/**
 * Picks the media store from the environment.
 *
 *  - development (the default): the on-disk store (MEDIA_DIR, ./data/media).
 *  - production: the Supabase bucket, used when SUPABASE_URL +
 *    SUPABASE_SERVICE_ROLE_KEY are set.
 *
 * MEDIA_DRIVER=supabase forces the bucket; MEDIA_DRIVER=disk forces the local
 * store even when the Supabase vars are present.
 */
function createConfiguredMediaStore() {
  const driver = process.env.MEDIA_DRIVER?.trim().toLowerCase();
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const useSupabase =
    driver === "supabase" ||
    (driver !== "disk" && Boolean(supabaseUrl && serviceRoleKey));

  if (!useSupabase) {
    const dir = process.env.MEDIA_DIR ?? "./data/media";
    console.log(`[wa] storing media on disk (${dir})`);
    return createMediaStore({ dir });
  }
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Supabase media"
    );
  }
  const bucket = process.env.SUPABASE_MEDIA_BUCKET?.trim() || "media";
  console.log(`[wa] storing media in Supabase bucket "${bucket}"`);
  return createSupabaseMediaStore({ url: supabaseUrl, serviceRoleKey, bucket });
}

/**
 * Reads the environment and wires up the auth + message stores.
 *
 * Returns { pool, auth, messageStore, mediaStore }.
 *  - DATABASE_URL set:     Postgres auth + message store (Supabase etc.)
 *  - DATABASE_URL unset:   auth falls back to the local ./auth folder (file
 *                          auth) and messages go to a local SQLite file so
 *                          nothing is lost during local development.
 *  - mediaStore:           media bytes — on disk in development (MEDIA_DIR,
 *                          default ./data/media) or in a Supabase Storage
 *                          bucket in production (set SUPABASE_URL +
 *                          SUPABASE_SERVICE_ROLE_KEY; see createConfiguredMediaStore).
 *                          Built once and used by both the connection and the
 *                          API, in either store mode.
 */
export function loadConfig() {
  let pool = null;
  let auth;
  let messageStore = null;

  // Media bytes live in the configured media store regardless of where messages
  // are stored; refs carry a public URL (Supabase) or fall back to
  // GET /api/media/:messageId (disk).
  const mediaStore = createConfiguredMediaStore();

  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Supabase requires SSL
      max: 5,
    });
    pool.on("error", (err) => console.error(`[db] idle client error: ${err.message}`));
    auth = createPostgresAuth({ pool, sessionId: process.env.SESSION_ID ?? "default" });
    messageStore = createPostgresMessageStore({ pool });
    console.log("[wa] storing the session in Postgres");
    console.log("[wa] persisting messages to Postgres");
  } else {
    console.log("[wa] storing the session in ./auth (set DATABASE_URL to use Postgres)");
    const localDbFile = process.env.LOCAL_DB ?? "./data/messages.db";
    messageStore = createSqliteMessageStore({ file: localDbFile });
    console.log(`[wa] persisting messages to local SQLite (${localDbFile})`);
  }

  return { pool, auth, messageStore, mediaStore };
}