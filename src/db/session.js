import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { qualifiedName } from "./identifiers.js";

/**
 * Creates the auth table if it doesn't exist. Safe to run on every start.
 *
 * The table holds the WhatsApp login (credentials + encryption keys), so row
 * level security is enabled with no policies. On Supabase that blocks the
 * public API keys (anon / authenticated) from reading it, while a direct
 * Postgres connection (what this library uses) keeps working. On plain
 * Postgres it is harmless. (RLS is bypassed for the table owner, which is the
 * role the direct pg connection uses.)
 */
export async function ensureAuthSchema(pool, { schema = "public", table = "wa_auth" } = {}) {
  const name = qualifiedName(schema, table);

  await pool.query(`
    create table if not exists ${name} (
      session_id text        not null,
      key        text        not null,
      value      text        not null,
      updated_at timestamptz not null default now(),
      primary key (session_id, key)
    )
  `);
  await pool.query(`alter table ${name} enable row level security`);
}

/**
 * Auth store backed by Postgres (works with Supabase).
 * Same idea as useMultiFileAuthState, but each "file" is a row in the auth table.
 * Use a different sessionId per WhatsApp number.
 *
 * @param {object} options
 * @param {import("pg").Pool} options.pool
 * @param {string}  [options.sessionId="default"]
 * @param {string}  [options.schema="public"]
 * @param {string}  [options.table="wa_auth"]
 * @param {boolean} [options.autoMigrate=true]  create the table on first use
 */
export function createPostgresAuth({
  pool,
  sessionId = "default",
  schema = "public",
  table = "wa_auth",
  autoMigrate = true,
}) {
  const tableName = qualifiedName(schema, table);
  let migrated = false;

  // Values are serialized with BufferJSON so Buffers survive the round trip
  const serialize = (value) => JSON.stringify(value, BufferJSON.replacer);
  const parse = (text) => JSON.parse(text, BufferJSON.reviver);

  async function load() {
    if (autoMigrate && !migrated) {
      await ensureAuthSchema(pool, { schema, table });
      migrated = true;
    }

    // --- creds ---
    const { rows } = await pool.query(
      `select value from ${tableName} where session_id = $1 and key = 'creds'`,
      [sessionId]
    );
    const creds = rows[0] ? parse(rows[0].value) : initAuthCreds();

    const saveCreds = () =>
      pool.query(
        `insert into ${tableName} (session_id, key, value)
         values ($1, 'creds', $2)
         on conflict (session_id, key)
         do update set value = excluded.value, updated_at = now()`,
        [sessionId, serialize(creds)]
      );

    // --- signal keys ---
    const keys = {
      get: async (type, ids) => {
        const data = {};
        if (ids.length === 0) return data;

        const names = ids.map((id) => `${type}-${id}`);
        const { rows } = await pool.query(
          `select key, value from ${tableName} where session_id = $1 and key = any($2::text[])`,
          [sessionId, names]
        );
        const byKey = new Map(rows.map((r) => [r.key, r.value]));

        for (const id of ids) {
          const raw = byKey.get(`${type}-${id}`);
          let value = raw ? parse(raw) : null;
          if (type === "app-state-sync-key" && value) {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[id] = value;
        }
        return data;
      },

      set: async (data) => {
        const upsertKeys = [];
        const upsertValues = [];
        const deleteKeys = [];

        for (const category of Object.keys(data)) {
          for (const id of Object.keys(data[category])) {
            const value = data[category][id];
            const key = `${category}-${id}`;
            if (value) {
              upsertKeys.push(key);
              upsertValues.push(serialize(value));
            } else {
              deleteKeys.push(key); // a null value means "remove this key"
            }
          }
        }
        if (upsertKeys.length === 0 && deleteKeys.length === 0) return;

        const client = await pool.connect();
        try {
          await client.query("begin");
          if (upsertKeys.length > 0) {
            await client.query(
              `insert into ${tableName} (session_id, key, value)
               select $1, k, v from unnest($2::text[], $3::text[]) as t(k, v)
               on conflict (session_id, key)
               do update set value = excluded.value, updated_at = now()`,
              [sessionId, upsertKeys, upsertValues]
            );
          }
          if (deleteKeys.length > 0) {
            await client.query(
              `delete from ${tableName} where session_id = $1 and key = any($2::text[])`,
              [sessionId, deleteKeys]
            );
          }
          await client.query("commit");
        } catch (err) {
          await client.query("rollback");
          throw err;
        } finally {
          client.release();
        }
      },
    };

    return { state: { creds, keys }, saveCreds };
  }

  async function clear() {
    await pool.query(`delete from ${tableName} where session_id = $1`, [sessionId]);
  }

  return { load, clear };
}