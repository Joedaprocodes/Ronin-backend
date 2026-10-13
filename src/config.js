import pg from "pg";
import { createPostgresAuth } from "./db/session.js";
import { createPostgresMessageStore } from "./db/messages.js";
import { createSqliteMessageStore } from "./db/sqlite.js";
import { createMediaStore } from "./media/store.js";

/**
 * Reads the environment and wires up the auth + message stores.
 *
 * Returns { pool, auth, messageStore, mediaStore }.
 *  - DATABASE_URL set:     Postgres auth + message store (Supabase etc.)
 *  - DATABASE_URL unset:   auth falls back to the local ./auth folder (file
 *                          auth) and messages go to a local SQLite file so
 *                          nothing is lost during local development.
 *  - mediaStore:           on-disk media bytes (MEDIA_DIR, default
 *                          ./data/media); built once and used by both the
 *                          connection and the API, in either store mode.
 */
export function loadConfig() {
  let pool = null;
  let auth;
  let messageStore = null;

  // Media bytes live on disk regardless of where messages are stored; the API
  // serves them via GET /api/media/:messageId.
  const mediaStore = createMediaStore({ dir: process.env.MEDIA_DIR ?? "./data/media" });

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