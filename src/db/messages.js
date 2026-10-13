import { randomUUID } from "node:crypto";
import { BufferJSON } from "@whiskeysockets/baileys";
import { qualifiedName } from "./identifiers.js";
import {
  buildThreadConversation,
  conversationThread,
  cursorTimestamp,
  encodeCursor,
  groupConversations,
  looksLikeJid,
} from "./inbox.js";
import { contactToView, listToView, normalizePhone } from "./contacts.js";
import { broadcastToView, recipientToView } from "./broadcasts.js";
import {
  DEFAULT_GUARD_SETTINGS,
  guardSettingsToView,
  moderationEntryToView,
  STRIKE_DECAY_MS,
} from "./guards.js";
import {
  autoReplyToView,
  awaySettingsToView,
  DEFAULT_AWAY_SETTINGS,
  MATCH_TYPES,
} from "./automation.js";
import { clusterIdentities, isGroupJid, pairFromRaw } from "../whatsapp/identity.js";

/**
 * Creates (if missing) the tables used by createPostgresMessageStore.
 * Safe to run on every start.
 *
 *   chats(jid)      one row per chat (the FK target for messages.chat_jid)
 *   messages(...)   every received/sent message
 *   templates(...)  message-style broadcast templates (title, body, media ref)
 *   contacts(...)   address book (name + canonical phone, unique)
 *   lists(...)      broadcast lists / audiences
 *   list_contacts   list membership join (a contact can be in many lists)
 *   idx_messages_chat_time, idx_messages_from_me
 *
 * read_at / flagged on chats power the inbox: unread = incoming messages newer
 * than read_at, and flagged is a per-conversation bookmark.
 */
export async function ensureMessageSchema(
  pool,
  {
    schema = "public",
    chatsTable = "chats",
    messagesTable = "messages",
    templatesTable = "templates",
    contactsTable = "contacts",
    listsTable = "lists",
    listContactsTable = "list_contacts",
    broadcastsTable = "broadcasts",
    broadcastRecipientsTable = "broadcast_recipients",
    chatAliasesTable = "chat_aliases",
    guardSettingsTable = "guard_settings",
    moderationLogTable = "moderation_log",
    guardStrikesTable = "guard_strikes",
    autoReplyRulesTable = "auto_reply_rules",
    autoReplyGroupsTable = "auto_reply_groups",
    awaySettingsTable = "away_settings",
    awayRepliesTable = "away_replies",
  } = {}
) {
  const chatsName = qualifiedName(schema, chatsTable);
  const messagesName = qualifiedName(schema, messagesTable);
  const templatesName = qualifiedName(schema, templatesTable);
  const contactsName = qualifiedName(schema, contactsTable);
  const listsName = qualifiedName(schema, listsTable);
  const listContactsName = qualifiedName(schema, listContactsTable);
  const broadcastsName = qualifiedName(schema, broadcastsTable);
  const broadcastRecipientsName = qualifiedName(schema, broadcastRecipientsTable);
  const chatAliasesName = qualifiedName(schema, chatAliasesTable);
  const guardSettingsName = qualifiedName(schema, guardSettingsTable);
  const moderationLogName = qualifiedName(schema, moderationLogTable);
  const guardStrikesName = qualifiedName(schema, guardStrikesTable);
  const autoReplyRulesName = qualifiedName(schema, autoReplyRulesTable);
  const autoReplyGroupsName = qualifiedName(schema, autoReplyGroupsTable);
  const awaySettingsName = qualifiedName(schema, awaySettingsTable);
  const awayRepliesName = qualifiedName(schema, awayRepliesTable);

  await pool.query(`
    create table if not exists ${chatsName} (
      jid        text        primary key,
      name       text,
      username   text,
      is_group   boolean     not null default false,
      updated_at timestamptz not null default now(),
      read_at    timestamptz,
      flagged    boolean     not null default false
    );
    create table if not exists ${chatAliasesName} (
      alias_jid     text        primary key,
      canonical_jid text        not null,
      updated_at    timestamptz not null default now()
    );
    create table if not exists ${messagesName} (
      id           text        primary key,
      chat_jid     text        references ${chatsName}(jid),
      from_me      boolean     not null,
      sender_jid   text,
      content      text,
      media        jsonb,
      sender_email text,
      timestamp    timestamptz default now(),
      raw_payload  jsonb
    );
    create table if not exists ${templatesName} (
      id            text        primary key,
      title         text        not null,
      body          text,
      media         jsonb,
      fallback_name text        not null default '',
      created_at    timestamptz not null default now(),
      updated_at    timestamptz not null default now()
    );
    create table if not exists ${contactsName} (
      id         text        primary key,
      name       text,
      phone      text        not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index if not exists idx_contacts_phone on ${contactsName}(phone);
    create table if not exists ${listsName} (
      id          text        primary key,
      name        text        not null,
      description text,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    );
    create table if not exists ${listContactsName} (
      list_id    text not null references ${listsName}(id) on delete cascade,
      contact_id text not null references ${contactsName}(id) on delete cascade,
      primary key (list_id, contact_id)
    );
    create table if not exists ${broadcastsName} (
      id             text        primary key,
      template_id    text        not null,
      template_title text        not null default '',
      list_ids       text        not null default '[]',
      sender_email   text,
      min_delay      integer     not null default 8,
      max_delay      integer     not null default 25,
      send_at        text,
      status         text        not null default 'sending',
      total          integer     not null default 0,
      sent           integer     not null default 0,
      failed         integer     not null default 0,
      created_at     text        not null default '',
      started_at     text,
      finished_at    text,
      error          text
    );
    create table if not exists ${broadcastRecipientsName} (
      broadcast_id text not null references ${broadcastsName}(id) on delete cascade,
      phone        text not null,
      name         text,
      jid          text,
      status       text not null default 'pending',
      error        text,
      sent_at      text,
      primary key (broadcast_id, phone)
    );
    alter table ${templatesName} add column if not exists fallback_name text not null default '';
    alter table ${chatsName} add column if not exists read_at timestamptz;
    alter table ${chatsName} add column if not exists flagged boolean not null default false;
    alter table ${chatsName} add column if not exists username text;
    alter table ${messagesName} add column if not exists sender_email text;
    alter table ${messagesName} add column if not exists media jsonb;
    alter table ${guardSettingsName} add column if not exists toxicity_guard boolean not null default false;
    create index if not exists idx_messages_chat_time on ${messagesName}(chat_jid, timestamp desc);
    create index if not exists idx_messages_from_me on ${messagesName}(from_me);
    create table if not exists ${guardSettingsName} (
      jid            text        primary key,
      link_guard     boolean     not null default false,
      toxicity_guard boolean     not null default false,
      block_external boolean     not null default true,
      block_invites  boolean     not null default true,
      link_whitelist jsonb       not null default '[]'::jsonb,
      sensitivity    text        not null default 'medium',
      warn_template  text        not null default '',
      warn_at        integer     not null default 2,
      kick_at        integer     not null default 5,
      created_at     timestamptz not null default now(),
      updated_at     timestamptz not null default now()
    );
    create table if not exists ${moderationLogName} (
      id         text        primary key,
      jid        text        not null,
      user_name  text,
      actor_jid  text,
      action     text        not null,
      reason     text,
      detail     text,
      created_at timestamptz not null default now()
    );
    create index if not exists idx_moderation_log_jid_time on ${moderationLogName}(jid, created_at desc);
    create table if not exists ${guardStrikesName} (
      jid        text        not null,
      user_jid   text        not null,
      count      integer     not null default 0,
      updated_at timestamptz not null default now(),
      primary key (jid, user_jid)
    );
    create table if not exists ${autoReplyRulesName} (
      id          text        primary key,
      keyword     text        not null,
      match_type  text        not null default 'contains',
      template_id text,
      enabled     boolean     not null default true,
      dm          boolean     not null default true,
      quote       boolean     not null default true,
      created_at  timestamptz not null default now(),
      updated_at  timestamptz not null default now()
    );
    create table if not exists ${autoReplyGroupsName} (
      rule_id text not null references ${autoReplyRulesName}(id) on delete cascade,
      jid     text not null,
      primary key (rule_id, jid)
    );
    create table if not exists ${awaySettingsName} (
      id               integer     primary key,
      enabled          boolean     not null default false,
      start_time       text        not null default '22:00',
      end_time         text        not null default '07:00',
      template_id      text,
      once_per_contact boolean     not null default true,
      quote            boolean     not null default true,
      time_zone        text        not null default '',
      updated_at       timestamptz not null default now()
    );
    create table if not exists ${awayRepliesName} (
      chat_jid   text        not null,
      window_key text        not null,
      sent_at    timestamptz not null default now(),
      primary key (chat_jid, window_key)
    );
    alter table ${autoReplyRulesName} add column if not exists quote boolean not null default true;
    alter table ${awaySettingsName} add column if not exists quote boolean not null default true;
  `);
}

/**
 * Persists every message into Postgres (works with Supabase).
 *
 * Wire it up by passing the returned store to WhatsAppConnection({ messageStore }).
 *
 * save(message) receives the simplified message the connection emits, plus a
 * `raw` field holding the original Baileys message, which is stored as
 * raw_payload. An optional `media` object ({ key, type, mimeType, fileName })
 * is stored as a single `media` jsonb column (null when the message has no
 * media, e.g. plain text — or when media bytes couldn't be stored). The media
 * *bytes* live in the on-disk media store (src/media/store.js), keyed by
 * `key`; views expose `media.url = /api/media/<key>` from it.
 * (A legacy media_url column may exist on older databases; it stays null and
 * deprecated — the `media` column is the source of truth.)
 * An optional senderEmail (e.g. "jane@gmail.com") is stored verbatim in
 * sender_email for the caller to join against contacts.
 *
 * The store also exposes the inbox query interface used by the API:
 * listConversations(q?) — lightweight summaries ({ lastMessage }, no embedded
 * thread, optional `q` search), getMessages(jid[, { limit?, before? }]) —
 * full thread, or a paginated page with { hasMore, nextBefore } when `limit`
 * is given, markRead(jid), setFlagged(jid, flag). Pagination uses keyset
 * cursors ({ timestamp, id } from encodeCursor/decodeCursor in inbox.js) so it
 * stays O(page) instead of OFFSET-scrolling.
 */
export function createPostgresMessageStore({
  pool,
  schema = "public",
  chatsTable = "chats",
  messagesTable = "messages",
  templatesTable = "templates",
  contactsTable = "contacts",
  listsTable = "lists",
  listContactsTable = "list_contacts",
  broadcastsTable = "broadcasts",
  broadcastRecipientsTable = "broadcast_recipients",
  chatAliasesTable = "chat_aliases",
  guardSettingsTable = "guard_settings",
  moderationLogTable = "moderation_log",
  guardStrikesTable = "guard_strikes",
  autoReplyRulesTable = "auto_reply_rules",
  autoReplyGroupsTable = "auto_reply_groups",
  awaySettingsTable = "away_settings",
  awayRepliesTable = "away_replies",
  autoMigrate = true,
}) {
  const chatsName = qualifiedName(schema, chatsTable);
  const messagesName = qualifiedName(schema, messagesTable);
  const templatesName = qualifiedName(schema, templatesTable);
  const contactsName = qualifiedName(schema, contactsTable);
  const listsName = qualifiedName(schema, listsTable);
  const listContactsName = qualifiedName(schema, listContactsTable);
  const broadcastsName = qualifiedName(schema, broadcastsTable);
  const broadcastRecipientsName = qualifiedName(schema, broadcastRecipientsTable);
  const chatAliasesName = qualifiedName(schema, chatAliasesTable);
  const guardSettingsName = qualifiedName(schema, guardSettingsTable);
  const moderationLogName = qualifiedName(schema, moderationLogTable);
  const guardStrikesName = qualifiedName(schema, guardStrikesTable);
  const autoReplyRulesName = qualifiedName(schema, autoReplyRulesTable);
  const autoReplyGroupsName = qualifiedName(schema, autoReplyGroupsTable);
  const awaySettingsName = qualifiedName(schema, awaySettingsTable);
  const awayRepliesName = qualifiedName(schema, awayRepliesTable);
  let migrated = false;
  let identitiesBackfilled = false;

  const serializeRaw = (msg) => JSON.stringify(msg, BufferJSON.replacer);

  const selectMessagesSql = `
    select id, chat_jid, from_me, sender_jid, content, timestamp, raw_payload, media
    from ${messagesName}`;
  const selectChatsSql = `
    select jid, name, is_group, flagged, read_at
    from ${chatsName}`;

  const ensureMigrated = async () => {
    if (autoMigrate && !migrated) {
      await ensureMessageSchema(pool, {
        schema,
        chatsTable,
        messagesTable,
        templatesTable,
        contactsTable,
        listsTable,
        listContactsTable,
        broadcastsTable,
        broadcastRecipientsTable,
        chatAliasesTable,
        guardSettingsTable,
        moderationLogTable,
        guardStrikesTable,
        autoReplyRulesTable,
        autoReplyGroupsTable,
        awaySettingsTable,
        awayRepliesTable,
      });
      migrated = true;
      await backfillIdentities();
    }
  };

  /**
   * One-time merge of already-split chats. Learns lid<->pn pairs from stored
   * raw payloads and folds each alias onto its canonical (LID-preferred) id.
   * Called once from ensureMigrated; safe/no-op on an empty database.
   */
  async function backfillIdentities() {
    if (identitiesBackfilled) return;
    identitiesBackfilled = true;
    const { rows } = await pool.query(
      `select chat_jid, raw_payload from ${messagesName} where raw_payload is not null`
    );
    const pairs = [];
    for (const row of rows) {
      const pair = pairFromRaw(row.raw_payload);
      if (pair) pairs.push(pair);
    }
    for (const [jid, canonical] of clusterIdentities(pairs)) {
      if (jid !== canonical) await canonicalizeChat(jid, canonical);
      else await registerChatAlias(jid, canonical);
    }
  }

  function toMessageView(row) {
    // pg parses jsonb to an object already
    const media = row.media ?? null;
    return {
      id: row.id,
      chat: row.chat_jid,
      fromMe: Boolean(row.from_me),
      sender: row.sender_jid ?? null,
      text: row.content ?? null,
      tsMs: row.timestamp ? new Date(row.timestamp).getTime() : 0,
      pushName: row.raw_payload?.pushName ?? null,
      media: media
        ? {
            type: media.type ?? null,
            mimeType: media.mimeType ?? null,
            fileName: media.fileName ?? null,
            url: `/api/media/${media.key}`,
          }
        : null,
    };
  }

  function chatsToMeta(rows) {
    const map = new Map();
    for (const c of rows) {
      map.set(c.jid, {
        name: c.name ?? null,
        isGroup: Boolean(c.is_group),
        flagged: Boolean(c.flagged),
        readAtMs: c.read_at ? new Date(c.read_at).getTime() : 0,
      });
    }
    return map;
  }

  async function save(message) {
    await ensureMigrated();

    // The chat row must exist before the message row (FK), so upsert it in the
    // same transaction. `on conflict (id) do nothing` also makes the write safe
    // against duplicate deliveries.
    const timestamp = new Date(message.receivedAt ?? Date.now()).toISOString();
    const rawJson = serializeRaw(message.raw ?? null);
    const media = message.media ?? null;

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into ${chatsName} (jid, name, is_group)
         values ($1, null, $2)
         on conflict (jid) do nothing`,
        [message.chat, message.isGroup]
      );
      await client.query(
        `insert into ${messagesName} (id, chat_jid, from_me, sender_jid, content, media, timestamp, sender_email, raw_payload)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
         on conflict (id) do nothing`,
        [
          message.id,
          message.chat,
          message.fromMe,
          message.sender ?? null,
          message.text ?? null,
          media ?? null,
          timestamp,
          message.senderEmail ?? null,
          rawJson,
        ]
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  async function listConversations(q = null) {
    await ensureMigrated();
    const [msgs, chatRows] = await Promise.all([
      pool.query(`${selectMessagesSql} order by timestamp asc`),
      pool.query(selectChatsSql),
    ]);
    return groupConversations(
      { messages: msgs.rows.map(toMessageView), chats: chatsToMeta(chatRows.rows) },
      { summary: true, q }
    );
  }

  /** Unread badge: incoming messages newer than read_at (read_at null = all). */
  async function countUnread(chatJid, readAt) {
    const { rows } =
      readAt == null
        ? await pool.query(
            `select count(*)::int as c from ${messagesName} where chat_jid = $1 and from_me = false`,
            [chatJid]
          )
        : await pool.query(
            `select count(*)::int as c from ${messagesName} where chat_jid = $1 and from_me = false and timestamp > $2`,
            [chatJid, readAt]
          );
    return rows[0]?.c ?? 0;
  }

  /**
   * Thread detail. Without `limit` this returns today's shape: the conversation
   * with the full thread (ascending). With `limit` (int >= 1) it pages the
   * NEWEST messages via a keyset `before` cursor and returns
   * { conversation, hasMore, nextBefore } — see src/db/inbox.js for the cursor
   * format. `before` must be the decoded { timestamp, id } object (the API
   * validates the raw string and returns 400 on malformed input).
   */
  async function getMessages(chatJid, { limit = null, before = null } = {}) {
    await ensureMigrated();
    if (!limit) {
      const [msgs, chatRows] = await Promise.all([
        pool.query(`${selectMessagesSql} where chat_jid = $1 order by timestamp asc`, [chatJid]),
        pool.query(`${selectChatsSql} where jid = $1`, [chatJid]),
      ]);
      const messages = msgs.rows.map(toMessageView);
      const chat = chatRows.rows[0];
      if (!messages.length && !chat) {
        if (!looksLikeJid(chatJid)) return null;
        return buildThreadConversation({ jid: chatJid });
      }
      return conversationThread({
        jid: chatJid,
        messages,
        chat: chat ? chatsToMeta([chat]).get(chatJid) : {},
      });
    }

    const [chatRows, newestRows] = await Promise.all([
      pool.query(`${selectChatsSql} where jid = $1`, [chatJid]),
      pool.query(
        `${selectMessagesSql} where chat_jid = $1 order by timestamp desc, id desc limit 1`,
        [chatJid]
      ),
    ]);
    const chat = chatRows.rows[0];
    const newest = newestRows.rows[0];
    if (!chat && !newest) {
      if (!looksLikeJid(chatJid)) return null;
      return {
        conversation: buildThreadConversation({ jid: chatJid }),
        hasMore: false,
        nextBefore: null,
      };
    }

    // Fetch limit+1 so hasMore is a single extra row away (older rows exist
    // past the page iff we got more than the limit).
    const take = limit + 1;
    const pageQuery = before
      ? `${selectMessagesSql} where chat_jid = $1 and (timestamp < $2 or (timestamp = $2 and id < $3)) order by timestamp desc, id desc limit $4`
      : `${selectMessagesSql} where chat_jid = $1 order by timestamp desc, id desc limit $2`;
    const { rows: rowsDesc } = await pool.query(
      pageQuery,
      before ? [chatJid, before.timestamp, before.id, take] : [chatJid, take]
    );
    const hasMore = rowsDesc.length > limit;
    const page = hasMore ? rowsDesc.slice(0, limit) : rowsDesc;
    const messages = [...page].reverse().map(toMessageView);

    const [themRows, unread] = await Promise.all([
      pool.query(
        `${selectMessagesSql} where chat_jid = $1 and from_me = false order by timestamp desc, id desc limit 1`,
        [chatJid]
      ),
      countUnread(chatJid, chat?.read_at ?? null),
    ]);
    const newestThem = themRows.rows[0];

    // Meta (name, unread, lastMessageAt) comes from the whole conversation,
    // not the page, so every page agrees on it.
    const conversation = buildThreadConversation({
      jid: chatJid,
      chatName: chat?.name ?? null,
      isGroup: Boolean(chat?.is_group),
      flagged: Boolean(chat?.flagged),
      unread,
      newest: newest ? toMessageView(newest) : null,
      latestThem: newestThem ? toMessageView(newestThem) : null,
      messages,
    });

    // `page` stays in DESC order here, so its last row is the oldest in-page;
    // that's the key the next page resumes below.
    const oldest = page[page.length - 1];
    const nextBefore = hasMore ? encodeCursor(cursorTimestamp(oldest), oldest.id) : null;
    return { conversation, hasMore, nextBefore };
  }

  async function upsertChat(chatJid) {
    await pool.query(
      `insert into ${chatsName} (jid, is_group) values ($1, false) on conflict (jid) do nothing`,
      [chatJid]
    );
  }

  async function markRead(chatJid) {
    await ensureMigrated();
    await upsertChat(chatJid);
    await pool.query(`update ${chatsName} set read_at = now() where jid = $1`, [chatJid]);
  }

  async function setFlagged(chatJid, flagged) {
    await ensureMigrated();
    await upsertChat(chatJid);
    await pool.query(`update ${chatsName} set flagged = $2 where jid = $1`, [
      chatJid,
      Boolean(flagged),
    ]);
  }

  /* ----------------------------- identities ------------------------------- */

  /** Records that `aliasJid` and `canonicalJid` are the same person. */
  async function registerChatAlias(aliasJid, canonicalJid) {
    if (!aliasJid || !canonicalJid) return;
    await pool.query(
      `insert into ${chatAliasesName} (alias_jid, canonical_jid, updated_at)
       values ($1, $2, now())
       on conflict (alias_jid) do update set
         canonical_jid = excluded.canonical_jid,
         updated_at    = excluded.updated_at`,
      [aliasJid, canonicalJid]
    );
  }

  /** Canonical chat id for a jid, or the jid itself when no alias is known. */
  async function resolveChatJid(jid) {
    if (!jid) return jid;
    await ensureMigrated();
    const { rows } = await pool.query(
      `select canonical_jid from ${chatAliasesName} where alias_jid = $1`,
      [jid]
    );
    return rows[0]?.canonical_jid ?? jid;
  }

  /**
   * Folds `aliasJid` into `canonicalJid`: moves its messages onto the canonical
   * chat, merges the two chat rows (name/username/read_at/flagged, latest
   * updated_at) and records the alias, then drops the alias chat row.
   * Idempotent. Returns the canonical id.
   */
  async function canonicalizeChat(aliasJid, canonicalJid) {
    if (!aliasJid) return canonicalJid ?? aliasJid;
    await ensureMigrated();
    const canonical = await resolveChatJid(canonicalJid ?? aliasJid);
    if (aliasJid === canonical) {
      await registerChatAlias(aliasJid, canonical);
      return canonical;
    }
    await withTransaction(async (client) => {
      const { rows: chatRows } = await client.query(
        `select jid, name, username, is_group, flagged, read_at, updated_at
         from ${chatsName} where jid = any($1::text[])`,
        [[aliasJid, canonical]]
      );
      const target = chatRows.find((c) => c.jid === canonical);
      const alias = chatRows.find((c) => c.jid === aliasJid);
      await client.query(
        `insert into ${chatsName} (jid, is_group) values ($1, false)
         on conflict (jid) do nothing`,
        [canonical]
      );
      await client.query(`update ${messagesName} set chat_jid = $1 where chat_jid = $2`, [
        canonical,
        aliasJid,
      ]);
      await client.query(
        `update ${chatsName}
         set name = $2,
             username = $3,
             read_at = $4,
             flagged = $5,
             updated_at = greatest($6::timestamptz, $7::timestamptz)
         where jid = $1`,
        [
          canonical,
          target?.name ?? alias?.name ?? null,
          target?.username ?? alias?.username ?? null,
          laterDate(target?.read_at, alias?.read_at),
          Boolean(target?.flagged || alias?.flagged),
          target?.updated_at ?? new Date().toISOString(),
          alias?.updated_at ?? new Date().toISOString(),
        ]
      );
      await client.query(`delete from ${chatsName} where jid = $1`, [aliasJid]);
      await client.query(
        `insert into ${chatAliasesName} (alias_jid, canonical_jid, updated_at)
         values ($1, $2, now())
         on conflict (alias_jid) do update set
           canonical_jid = excluded.canonical_jid,
           updated_at    = excluded.updated_at`,
        [aliasJid, canonical]
      );
    });
    return canonical;
  }

  /**
   * Stores the address-book name (and @username) WhatsApp synced for a chat.
   * coalesce semantics so a later sync without a name never wipes one we have.
   * Group jids are flagged as groups (is_group = true) so a chat row created
   * here is never mistaken for a 1:1.
   */
  async function setChatName(jid, name, username = null) {
    if (!jid) return;
    await ensureMigrated();
    const clean = typeof name === "string" ? name.trim() : "";
    const user = typeof username === "string" ? username.trim() : "";
    if (!clean && !user) return;
    const group = isGroupJid(jid);
    await withTransaction(async (client) => {
      await client.query(
        `insert into ${chatsName} (jid, is_group) values ($1, $2)
         on conflict (jid) do nothing`,
        [jid, group]
      );
      await client.query(
        `update ${chatsName}
         set name = coalesce($2, name), username = coalesce($3, username), is_group = $4, updated_at = now()
         where jid = $1`,
        [jid, clean || null, user || null, group]
      );
    });
  }

  /**
   * The stored address-book/group name we know for a jid (resolved to its
   * canonical chat), or null when there is none. Used to decorate group
   * participants (and any other jid) with the best name the store has.
   */
  async function resolveChatName(jid) {
    if (!jid) return null;
    await ensureMigrated();
    const canonical = await resolveChatJid(jid);
    const { rows } = await pool.query(
      `select name from ${chatsName} where jid = $1`,
      [canonical]
    );
    const name = rows[0]?.name;
    return typeof name === "string" && name.trim() ? name : null;
  }

  /** Later of two Date/timestamp values (null-safe). */
  function laterDate(a, b) {
    if (a == null) return b ?? null;
    if (b == null) return a;
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
  }

  function templateToView(row) {
    const media = row.media ?? null;
    return {
      id: row.id,
      title: row.title,
      body: row.body ?? "",
      fallbackName: row.fallback_name ?? "",
      media: media
        ? {
            type: media.type ?? null,
            mimeType: media.mimeType ?? null,
            fileName: media.fileName ?? null,
            url: `/api/media/${media.key}`,
          }
        : null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  async function saveTemplate({ id = randomUUID(), title, body = "", media = null, fallbackName = "" } = {}) {
    await ensureMigrated();
    const now = new Date().toISOString();
    await pool.query(
      `insert into ${templatesName} (id, title, body, media, fallback_name, created_at, updated_at)
       values ($1, $2, $3, $4::jsonb, $5, $6, $7)
       on conflict (id) do update set
         title         = excluded.title,
         body          = excluded.body,
         media         = excluded.media,
         fallback_name = excluded.fallback_name,
         updated_at    = excluded.updated_at`,
      [id, title ?? "", body ?? "", media ?? null, fallbackName ?? "", now, now]
    );
    const { rows } = await pool.query(
      `select id, title, body, media, fallback_name, created_at from ${templatesName} where id = $1`,
      [id]
    );
    return templateToView(rows[0]);
  }

  async function listTemplates() {
    await ensureMigrated();
    const { rows } = await pool.query(
      `select id, title, body, media, fallback_name, created_at from ${templatesName}
       order by created_at desc, id desc`
    );
    return rows.map(templateToView);
  }

  async function getTemplate(id) {
    await ensureMigrated();
    const { rows } = await pool.query(
      `select id, title, body, media, fallback_name, created_at from ${templatesName} where id = $1`,
      [id]
    );
    return rows[0] ? templateToView(rows[0]) : null;
  }

  async function updateTemplate(id, { title, body = "", media, fallbackName } = {}) {
    await ensureMigrated();
    const { rows: current } = await pool.query(
      `select media, fallback_name from ${templatesName} where id = $1`,
      [id]
    );
    if (!current[0]) return null;
    const nextMedia = media === undefined ? current[0].media : media;
    const nextFallback =
      fallbackName === undefined ? (current[0].fallback_name ?? "") : (fallbackName ?? "");
    const { rows } = await pool.query(
      `update ${templatesName}
       set title = $2, body = $3, media = $4::jsonb, fallback_name = $5, updated_at = $6
       where id = $1
       returning id, title, body, media, fallback_name, created_at`,
      [id, title ?? "", body ?? "", nextMedia ?? null, nextFallback, new Date().toISOString()]
    );
    return rows[0] ? templateToView(rows[0]) : null;
  }

  async function deleteTemplate(id) {
    await ensureMigrated();
    const result = await pool.query(`delete from ${templatesName} where id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /* ------------------------------- broadcasts ------------------------------ */

  const BROADCAST_PATCH_COLUMNS = {
    status: "status",
    sent: "sent",
    failed: "failed",
    startedAt: "started_at",
    finishedAt: "finished_at",
    error: "error",
  };
  const RECIPIENT_PATCH_COLUMNS = {
    status: "status",
    error: "error",
    jid: "jid",
    sentAt: "sent_at",
  };

  /** Keeps the first recipient per canonical phone. */
  function dedupeRecipients(recipients = []) {
    const seen = new Map();
    for (const r of recipients) {
      if (!r || typeof r.phone !== "string" || !r.phone) continue;
      if (!seen.has(r.phone)) seen.set(r.phone, { phone: r.phone, name: r.name ?? "" });
    }
    return [...seen.values()];
  }

  /**
   * Creates a broadcast plus its recipient rows (all `pending`) in a single
   * transaction. `total` is derived from the deduped recipient list.
   */
  async function createBroadcast({
    id = randomUUID(),
    templateId,
    templateTitle = "",
    listIds = [],
    senderEmail = null,
    minDelay = 0,
    maxDelay = 0,
    sendAt = null,
    status = "sending",
    createdAt = null,
    startedAt = null,
    finishedAt = null,
    error = null,
    recipients = [],
  } = {}) {
    await ensureMigrated();
    const now = createdAt ?? new Date().toISOString();
    const members = dedupeRecipients(recipients);
    await withTransaction(async (client) => {
      await client.query(
        `insert into ${broadcastsName}
           (id, template_id, template_title, list_ids, sender_email, min_delay, max_delay,
            send_at, status, total, sent, failed, created_at, started_at, finished_at, error)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          id,
          templateId,
          templateTitle ?? "",
          JSON.stringify(listIds ?? []),
          senderEmail ?? null,
          minDelay ?? 0,
          maxDelay ?? 0,
          sendAt ?? null,
          status ?? "sending",
          members.length,
          0,
          0,
          now,
          startedAt ?? null,
          finishedAt ?? null,
          error ?? null,
        ]
      );
      for (const r of members) {
        await client.query(
          `insert into ${broadcastRecipientsName} (broadcast_id, phone, name, jid, status, error, sent_at)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [id, r.phone, r.name ?? null, null, "pending", null, null]
        );
      }
    });
    return getBroadcast(id);
  }

  /** One broadcast view, or null. */
  async function getBroadcast(id) {
    await ensureMigrated();
    const { rows } = await pool.query(`select * from ${broadcastsName} where id = $1`, [id]);
    return rows[0] ? broadcastToView(rows[0]) : null;
  }

  /** All broadcasts, newest first. */
  async function listBroadcasts() {
    await ensureMigrated();
    const { rows } = await pool.query(
      `select * from ${broadcastsName} order by created_at desc, id desc`
    );
    return rows.map(broadcastToView);
  }

  /** Applies a partial patch (status/sent/failed/startedAt/finishedAt/error). */
  async function updateBroadcast(id, patch = {}) {
    await ensureMigrated();
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(BROADCAST_PATCH_COLUMNS)) {
      if (Object.hasOwn(patch, key) && patch[key] !== undefined) {
        sets.push(`${column} = $${values.length + 2}`);
        values.push(patch[key]);
      }
    }
    if (!sets.length) return getBroadcast(id);
    const { rows } = await pool.query(
      `update ${broadcastsName} set ${sets.join(", ")} where id = $1 returning *`,
      [id, ...values]
    );
    return rows[0] ? broadcastToView(rows[0]) : null;
  }

  /** All recipients of a broadcast, ordered by phone. */
  async function listBroadcastRecipients(broadcastId) {
    await ensureMigrated();
    const { rows } = await pool.query(
      `select * from ${broadcastRecipientsName} where broadcast_id = $1 order by phone asc`,
      [broadcastId]
    );
    return rows.map(recipientToView);
  }

  /** Updates one recipient row (status/error/jid/sentAt). */
  async function markBroadcastRecipient(broadcastId, phone, patch = {}) {
    await ensureMigrated();
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(RECIPIENT_PATCH_COLUMNS)) {
      if (Object.hasOwn(patch, key)) {
        sets.push(`${column} = $${values.length + 3}`);
        values.push(patch[key] ?? null);
      }
    }
    if (!sets.length) return false;
    const { rowCount } = await pool.query(
      `update ${broadcastRecipientsName} set ${sets.join(", ")}
       where broadcast_id = $1 and phone = $2`,
      [broadcastId, phone, ...values]
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Atomically claims scheduled broadcasts whose send_at has arrived: the
   * single UPDATE flips every due row to 'sending' and returns them, so a row
   * can only be claimed once.
   */
  async function claimDueBroadcasts(now = new Date().toISOString()) {
    await ensureMigrated();
    const { rows } = await pool.query(
      `update ${broadcastsName}
       set status = 'sending', started_at = $2
       where status = 'scheduled' and send_at is not null and send_at <= $1
       returning *`,
      [now, now]
    );
    return rows.map(broadcastToView);
  }

  /** Broadcasts left in 'sending' by a previous process (startup resume). */
  async function listInterruptedBroadcasts() {
    await ensureMigrated();
    const { rows } = await pool.query(
      `select * from ${broadcastsName} where status = 'sending'`
    );
    return rows.map(broadcastToView);
  }

  /** Runs `fn(client)` inside a transaction, committing or rolling back. */
  async function withTransaction(fn) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }

  const selectContactSql =
    `select id, name, phone, created_at from ${contactsName}`;
  const selectListSql =
    `select id, name, description, created_at,
       (select count(*)::int from ${listContactsName} where list_id = ${listsName}.id) as member_count
     from ${listsName}`;

  /** Normalizes a phone or throws (the API validates first and returns 400). */
  function requirePhone(phone) {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new Error("invalid phone number");
    return normalized;
  }

  function cleanName(name) {
    return typeof name === "string" ? name.trim() : "";
  }

  /** All contacts, newest first; `q` matches name OR phone (case-insensitive). */
  async function listContacts(q = null) {
    await ensureMigrated();
    const term = q == null ? "" : String(q).trim();
    if (!term) {
      const { rows } = await pool.query(`${selectContactSql} order by created_at desc, id desc`);
      return rows.map(contactToView);
    }
    const like = `%${term.toLowerCase()}%`;
    const { rows } = await pool.query(
      `${selectContactSql} where lower(name) like $1 or phone like $1
       order by created_at desc, id desc`,
      [like]
    );
    return rows.map(contactToView);
  }

  async function getContact(id) {
    await ensureMigrated();
    const { rows } = await pool.query(`${selectContactSql} where id = $1`, [id]);
    return rows[0] ? contactToView(rows[0]) : null;
  }

  /** Existing contact with this canonical phone, or null (for 409 checks). */
  async function getContactByPhone(phone) {
    await ensureMigrated();
    const { rows } = await pool.query(`${selectContactSql} where phone = $1`, [phone]);
    return rows[0] ? contactToView(rows[0]) : null;
  }

  async function createContact({ name = "", phone } = {}) {
    await ensureMigrated();
    const id = randomUUID();
    const now = new Date().toISOString();
    await pool.query(
      `insert into ${contactsName} (id, name, phone, created_at, updated_at)
       values ($1, $2, $3, $4, $5)`,
      [id, cleanName(name), requirePhone(phone), now, now]
    );
    const { rows } = await pool.query(`${selectContactSql} where id = $1`, [id]);
    return contactToView(rows[0]);
  }

  async function updateContact(id, { name = "", phone } = {}) {
    await ensureMigrated();
    const result = await pool.query(
      `update ${contactsName} set name = $2, phone = $3, updated_at = $4 where id = $1`,
      [id, cleanName(name), requirePhone(phone), new Date().toISOString()]
    );
    if (result.rowCount === 0) return null;
    const { rows } = await pool.query(`${selectContactSql} where id = $1`, [id]);
    return contactToView(rows[0]);
  }

  /** Deletes a contact and its list memberships. Deleting a contact keeps lists. */
  async function deleteContact(id) {
    await ensureMigrated();
    return withTransaction(async (client) => {
      await client.query(`delete from ${listContactsName} where contact_id = $1`, [id]);
      const result = await client.query(`delete from ${contactsName} where id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  /**
   * Bulk delete: removes every listed contact and its list memberships in one
   * transaction. Lists are always kept. Returns how many contacts actually
   * existed and were removed (unknown ids are ignored).
   */
  async function deleteContacts(ids) {
    await ensureMigrated();
    const unique = [...new Set((ids ?? []).map(String))];
    if (!unique.length) return 0;
    return withTransaction(async (client) => {
      await client.query(
        `delete from ${listContactsName} where contact_id = any($1::text[])`,
        [unique]
      );
      const result = await client.query(
        `delete from ${contactsName} where id = any($1::text[])`,
        [unique]
      );
      return result.rowCount ?? 0;
    });
  }

  /**
   * Bulk insert. Rows with an unsupported number are skipped as "invalid
   * number"; duplicates (already stored, or repeated in this batch) are skipped
   * as "already exists". The valid rows are inserted in one transaction.
   */
  async function importContacts(rows) {
    await ensureMigrated();
    const skipped = [];
    const seen = new Set();
    const candidates = [];
    for (const row of rows ?? []) {
      const rawPhone = row?.phone;
      const phone = normalizePhone(rawPhone);
      if (!phone) {
        skipped.push({ phone: rawPhone == null ? "" : String(rawPhone), reason: "invalid number" });
        continue;
      }
      if (seen.has(phone)) {
        skipped.push({ phone, reason: "already exists" });
        continue;
      }
      seen.add(phone);
      candidates.push({ name: cleanName(row?.name), phone });
    }

    const { rows: storedRows } = await pool.query(`select phone from ${contactsName}`);
    const stored = new Set(storedRows.map((r) => r.phone));
    const toInsert = [];
    for (const c of candidates) {
      if (stored.has(c.phone)) skipped.push({ phone: c.phone, reason: "already exists" });
      else toInsert.push(c);
    }

    const now = new Date().toISOString();
    await withTransaction(async (client) => {
      for (const c of toInsert) {
        await client.query(
          `insert into ${contactsName} (id, name, phone, created_at, updated_at)
           values ($1, $2, $3, $4, $5)`,
          [randomUUID(), c.name, c.phone, now, now]
        );
      }
    });
    return { imported: toInsert.length, skipped };
  }

  /** Keeps only the ids that actually exist, de-duped (mirrors the FK filter). */
  async function existingContactIds(client, contactIds) {
    const ids = [...new Set((contactIds ?? []).map(String))];
    if (!ids.length) return [];
    const { rows } = await client.query(
      `select id from ${contactsName} where id = any($1::text[])`,
      [ids]
    );
    return rows.map((r) => r.id);
  }

  /** All lists newest first, each with its computed memberCount. */
  async function listLists() {
    await ensureMigrated();
    const { rows } = await pool.query(`${selectListSql} order by created_at desc, id desc`);
    return rows.map(listToView);
  }

  /** All lists that contain the given contact, newest first. */
  async function listListsForContact(contactId) {
    await ensureMigrated();
    const { rows } = await pool.query(
      `${selectListSql}
       where id in (select list_id from ${listContactsName} where contact_id = $1)
       order by created_at desc, id desc`,
      [contactId]
    );
    return rows.map(listToView);
  }

  /** One list with memberCount plus its member contactIds, or null. */
  async function getList(id) {
    await ensureMigrated();
    const { rows } = await pool.query(`${selectListSql} where id = $1`, [id]);
    if (!rows[0]) return null;
    const { rows: idRows } = await pool.query(
      `select contact_id from ${listContactsName} where list_id = $1 order by contact_id`,
      [id]
    );
    return { ...listToView(rows[0]), contactIds: idRows.map((r) => r.contact_id) };
  }

  async function createList({ name, description = "", contactIds = [] } = {}) {
    await ensureMigrated();
    const id = randomUUID();
    const now = new Date().toISOString();
    await withTransaction(async (client) => {
      await client.query(
        `insert into ${listsName} (id, name, description, created_at, updated_at)
         values ($1, $2, $3, $4, $5)`,
        [id, String(name ?? "").trim(), String(description ?? ""), now, now]
      );
      for (const contactId of await existingContactIds(client, contactIds)) {
        await client.query(
          `insert into ${listContactsName} (list_id, contact_id) values ($1, $2)
           on conflict do nothing`,
          [id, contactId]
        );
      }
    });
    const { rows } = await pool.query(`${selectListSql} where id = $1`, [id]);
    return listToView(rows[0]);
  }

  /**
   * Updates a list. When `contactIds` is provided the whole membership is
   * replaced (unknown ids are dropped); when it is undefined the membership is
   * left untouched. Returns the updated view, or null when the list is missing.
   */
  async function updateList(id, { name, description = "", contactIds } = {}) {
    await ensureMigrated();
    const now = new Date().toISOString();
    const updated = await withTransaction(async (client) => {
      const result = await client.query(
        `update ${listsName} set name = $2, description = $3, updated_at = $4 where id = $1`,
        [id, String(name ?? "").trim(), String(description ?? ""), now]
      );
      if (result.rowCount === 0) return false;
      if (contactIds !== undefined) {
        await client.query(`delete from ${listContactsName} where list_id = $1`, [id]);
        for (const contactId of await existingContactIds(client, contactIds)) {
          await client.query(
            `insert into ${listContactsName} (list_id, contact_id) values ($1, $2)
             on conflict do nothing`,
            [id, contactId]
          );
        }
      }
      return true;
    });
    if (!updated) return null;
    const { rows } = await pool.query(`${selectListSql} where id = $1`, [id]);
    return listToView(rows[0]);
  }

  /** Deletes a list and its memberships; the contacts themselves are kept. */
  async function deleteList(id) {
    await ensureMigrated();
    return withTransaction(async (client) => {
      await client.query(`delete from ${listContactsName} where list_id = $1`, [id]);
      const result = await client.query(`delete from ${listsName} where id = $1`, [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  /* --------------------------------- guards -------------------------------- */

  /** Saved guard settings view, or null when the group is unguarded. */
  async function getGuardSettings(jid) {
    await ensureMigrated();
    const { rows } = await pool.query(`select * from ${guardSettingsName} where jid = $1`, [jid]);
    return rows[0] ? guardSettingsToView(rows[0]) : null;
  }

  /**
   * Upserts a group's guard settings (full replace). `created_at` is preserved
   * on update; `updated_at` always moves to now. Returns the saved view.
   */
  async function saveGuardSettings(jid, settings = {}) {
    await ensureMigrated();
    const value = { ...DEFAULT_GUARD_SETTINGS, ...settings };
    const now = new Date().toISOString();
    await pool.query(
      `insert into ${guardSettingsName}
         (jid, link_guard, toxicity_guard, block_external, block_invites, link_whitelist,
          sensitivity, warn_template, warn_at, kick_at, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (jid) do update set
         link_guard     = excluded.link_guard,
         toxicity_guard = excluded.toxicity_guard,
         block_external = excluded.block_external,
         block_invites  = excluded.block_invites,
         link_whitelist = excluded.link_whitelist,
         sensitivity    = excluded.sensitivity,
         warn_template  = excluded.warn_template,
         warn_at        = excluded.warn_at,
         kick_at        = excluded.kick_at,
         updated_at     = excluded.updated_at`,
      [
        jid,
        Boolean(value.linkGuard),
        Boolean(value.toxicityGuard),
        Boolean(value.blockExternal),
        Boolean(value.blockInvites),
        JSON.stringify(Array.isArray(value.linkWhitelist) ? value.linkWhitelist : []),
        value.sensitivity ?? DEFAULT_GUARD_SETTINGS.sensitivity,
        value.warnTemplate ?? "",
        Number.isInteger(value.warnAt) ? value.warnAt : DEFAULT_GUARD_SETTINGS.warnAt,
        Number.isInteger(value.kickAt) ? value.kickAt : DEFAULT_GUARD_SETTINGS.kickAt,
        now,
        now,
      ]
    );
    return getGuardSettings(jid);
  }

  /** Appends a moderation log entry (explicit ISO timestamp) and returns it. */
  async function logModeration({
    id = randomUUID(),
    jid,
    user = null,
    actorJid = null,
    action,
    reason = "",
    detail = null,
    time = null,
  } = {}) {
    await ensureMigrated();
    const createdAt = time ?? new Date().toISOString();
    await pool.query(
      `insert into ${moderationLogName} (id, jid, user_name, actor_jid, action, reason, detail, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, jid, user ?? null, actorJid ?? null, action, reason ?? "", detail ?? null, createdAt]
    );
    const { rows } = await pool.query(`select * from ${moderationLogName} where id = $1`, [id]);
    return moderationEntryToView(rows[0]);
  }

  /** A group's moderation log, newest first (default 50). */
  async function listModeration(jid, limit = 50) {
    await ensureMigrated();
    const size = Number.isInteger(limit) && limit > 0 ? limit : 50;
    const { rows } = await pool.query(
      `select * from ${moderationLogName} where jid = $1 order by created_at desc, id desc limit $2`,
      [jid, size]
    );
    return rows.map(moderationEntryToView);
  }

  /** Current strike record { count, updatedAt } (zeroed when none/expired). */
  async function getStrikes(jid, userJid, { now = Date.now(), decayMs = STRIKE_DECAY_MS } = {}) {
    await ensureMigrated();
    const { rows } = await pool.query(
      `select count, updated_at from ${guardStrikesName} where jid = $1 and user_jid = $2`,
      [jid, userJid]
    );
    const row = rows[0];
    if (!row) return { count: 0, updatedAt: null };
    const at = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
    if (!Number.isFinite(at) || now - at > decayMs) return { count: 0, updatedAt: null };
    return { count: Number(row.count) || 0, updatedAt: new Date(row.updated_at).toISOString() };
  }

  /**
   * Records a new offence and returns the resulting (decayed) strike count.
   * A stale record restarts at 1 rather than continuing an old tally.
   */
  async function bumpStrike(jid, userJid, { now = Date.now(), decayMs = STRIKE_DECAY_MS } = {}) {
    const current = await getStrikes(jid, userJid, { now, decayMs });
    const count = current.count + 1;
    await pool.query(
      `insert into ${guardStrikesName} (jid, user_jid, count, updated_at)
       values ($1, $2, $3, $4)
       on conflict (jid, user_jid) do update set
         count      = excluded.count,
         updated_at = excluded.updated_at`,
      [jid, userJid, count, new Date(now).toISOString()]
    );
    return count;
  }

  /** Clears a member's strikes (e.g. after a kick). Returns whether one existed. */
  async function resetStrikes(jid, userJid) {
    await ensureMigrated();
    const result = await pool.query(
      `delete from ${guardStrikesName} where jid = $1 and user_jid = $2`,
      [jid, userJid]
    );
    return (result.rowCount ?? 0) > 0;
  }

  /* ------------------------------ automation ------------------------------- */

  async function ruleGroups(ruleId, client = pool) {
    const { rows } = await client.query(
      `select jid from ${autoReplyGroupsName} where rule_id = $1 order by jid asc`,
      [ruleId]
    );
    return rows.map((row) => row.jid);
  }

  /** Replaces a rule's group scope (duplicate/blank jids are dropped). */
  async function setRuleGroups(client, ruleId, groups) {
    await client.query(`delete from ${autoReplyGroupsName} where rule_id = $1`, [ruleId]);
    const seen = new Set();
    for (const raw of Array.isArray(groups) ? groups : []) {
      const jid = typeof raw === "string" ? raw.trim() : "";
      if (!jid || seen.has(jid)) continue;
      seen.add(jid);
      await client.query(
        `insert into ${autoReplyGroupsName} (rule_id, jid) values ($1, $2) on conflict do nothing`,
        [ruleId, jid]
      );
    }
  }

  /** One auto-reply rule view, or null when it doesn't exist. */
  async function getAutoReply(id) {
    await ensureMigrated();
    const { rows } = await pool.query(`select * from ${autoReplyRulesName} where id = $1`, [id]);
    if (!rows[0]) return null;
    return autoReplyToView(rows[0], await ruleGroups(id));
  }

  /** Every auto-reply rule, oldest first (evaluation order). */
  async function listAutoReplies() {
    await ensureMigrated();
    const { rows } = await pool.query(
      `select * from ${autoReplyRulesName} order by created_at asc, id asc`
    );
    const rules = [];
    for (const row of rows) rules.push(autoReplyToView(row, await ruleGroups(row.id)));
    return rules;
  }

  /** Creates an auto-reply rule and returns its view. */
  async function createAutoReply({
    id = randomUUID(),
    keyword,
    match = "contains",
    templateId = null,
    enabled = true,
    dm = true,
    quote = true,
    groups = [],
  } = {}) {
    await ensureMigrated();
    const now = new Date().toISOString();
    await withTransaction(async (client) => {
      await client.query(
        `insert into ${autoReplyRulesName}
           (id, keyword, match_type, template_id, enabled, dm, quote, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          keyword ?? "",
          MATCH_TYPES.includes(match) ? match : "contains",
          templateId ?? null,
          Boolean(enabled),
          Boolean(dm),
          Boolean(quote),
          now,
          now,
        ]
      );
      await setRuleGroups(client, id, groups);
    });
    return getAutoReply(id);
  }

  /**
   * Updates a rule; omitted fields keep their current value. `groups` replaces
   * the scope only when provided. Returns the updated view, or null if missing.
   */
  async function updateAutoReply(id, patch = {}) {
    await ensureMigrated();
    const { rows } = await pool.query(`select * from ${autoReplyRulesName} where id = $1`, [id]);
    const existing = rows[0];
    if (!existing) return null;
    const match = patch.match ?? existing.match_type;
    await withTransaction(async (client) => {
      await client.query(
        `update ${autoReplyRulesName}
            set keyword = $2, match_type = $3, template_id = $4, enabled = $5, dm = $6, quote = $7, updated_at = $8
          where id = $1`,
        [
          id,
          patch.keyword !== undefined ? patch.keyword : existing.keyword,
          MATCH_TYPES.includes(match) ? match : "contains",
          patch.templateId !== undefined ? (patch.templateId ?? null) : existing.template_id,
          patch.enabled !== undefined ? Boolean(patch.enabled) : Boolean(existing.enabled),
          patch.dm !== undefined ? Boolean(patch.dm) : Boolean(existing.dm),
          patch.quote !== undefined ? Boolean(patch.quote) : existing.quote !== false,
          new Date().toISOString(),
        ]
      );
      if (patch.groups !== undefined) await setRuleGroups(client, id, patch.groups);
    });
    return getAutoReply(id);
  }

  /** Deletes a rule (its group scope cascades). Returns whether one existed. */
  async function deleteAutoReply(id) {
    await ensureMigrated();
    const result = await pool.query(`delete from ${autoReplyRulesName} where id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  /** Away-mode settings (defaults when never saved). */
  async function getAwaySettings() {
    await ensureMigrated();
    const { rows } = await pool.query(`select * from ${awaySettingsName} where id = 1`);
    return awaySettingsToView(rows[0]);
  }

  /** Upserts the single away-mode row; omitted fields keep their value. */
  async function saveAwaySettings(patch = {}) {
    await ensureMigrated();
    const value = { ...(await getAwaySettings()), ...patch };
    await pool.query(
      `insert into ${awaySettingsName}
         (id, enabled, start_time, end_time, template_id, once_per_contact, quote, time_zone, updated_at)
       values (1, $1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do update set
         enabled          = excluded.enabled,
         start_time       = excluded.start_time,
         end_time         = excluded.end_time,
         template_id      = excluded.template_id,
         once_per_contact = excluded.once_per_contact,
         quote            = excluded.quote,
         time_zone        = excluded.time_zone,
         updated_at       = excluded.updated_at`,
      [
        Boolean(value.enabled),
        value.start ?? DEFAULT_AWAY_SETTINGS.start,
        value.end ?? DEFAULT_AWAY_SETTINGS.end,
        value.templateId ?? null,
        Boolean(value.oncePerContact),
        Boolean(value.quote),
        value.timeZone ?? "",
        new Date().toISOString(),
      ]
    );
    return getAwaySettings();
  }

  /** Records that the away message was sent to a chat in this window instance. */
  async function markAwayReply(chatJid, windowKey) {
    await ensureMigrated();
    await pool.query(
      `insert into ${awayRepliesName} (chat_jid, window_key, sent_at)
       values ($1, $2, $3)
       on conflict (chat_jid, window_key) do nothing`,
      [chatJid, windowKey, new Date().toISOString()]
    );
  }

  /** Whether the away message was already sent to a chat in this window. */
  async function hasAwayReply(chatJid, windowKey) {
    await ensureMigrated();
    const { rows } = await pool.query(
      `select 1 as ok from ${awayRepliesName} where chat_jid = $1 and window_key = $2`,
      [chatJid, windowKey]
    );
    return rows.length > 0;
  }

  return {
    save,
    listConversations,
    getMessages,
    markRead,
    setFlagged,
    resolveChatJid,
    canonicalizeChat,
    setChatName,
    resolveChatName,
    saveTemplate,
    listTemplates,
    getTemplate,
    updateTemplate,
    deleteTemplate,
    listContacts,
    getContact,
    getContactByPhone,
    createContact,
    updateContact,
    deleteContact,
    deleteContacts,
    importContacts,
    listLists,
    listListsForContact,
    getList,
    createList,
    updateList,
    deleteList,
    createBroadcast,
    getBroadcast,
    listBroadcasts,
    updateBroadcast,
    listBroadcastRecipients,
    markBroadcastRecipient,
    claimDueBroadcasts,
    listInterruptedBroadcasts,
    getGuardSettings,
    saveGuardSettings,
    logModeration,
    listModeration,
    getStrikes,
    bumpStrike,
    resetStrikes,
    getAutoReply,
    listAutoReplies,
    createAutoReply,
    updateAutoReply,
    deleteAutoReply,
    getAwaySettings,
    saveAwaySettings,
    markAwayReply,
    hasAwayReply,
  };
}