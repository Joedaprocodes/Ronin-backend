import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BufferJSON } from "@whiskeysockets/baileys";
import { DatabaseSync } from "node:sqlite";
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
import {
  clusterIdentities,
  isGroupJid,
  pairFromRaw,
} from "../whatsapp/identity.js";

/**
 * SQLite-backed message store for local development, activated when no
 * DATABASE_URL is set. Mirrors the Postgres store (src/db/messages.js) exactly:
 * same save(message) interface, same chats -> messages foreign key, same
 * id-dedupe (`insert or ignore` ~ `on conflict (id) do nothing`), same
 * BufferJSON raw payload serialization, same `media` column holding the JSON
 * { key, type, mimeType, fileName } ref (null for plain-text messages). The
 * media *bytes* live in the on-disk media store (src/media/store.js), keyed by
 * `key`; views expose `media.url = /api/media/<key>` from it.
 *
 * Also exposes the inbox query interface used by the API:
 * listConversations(q?) — lightweight summaries ({ lastMessage }, no embedded
 * thread, optional `q` search), getMessages(jid[, { limit?, before? }]) —
 * full thread, or a paginated page with { hasMore, nextBefore } when `limit`
 * is given, markRead(jid), setFlagged(jid, flag).
 * read_at / flagged live on the chats row (WhatsApp-style:
 * unread = incoming messages newer than read_at).
 *
 * Uses node:sqlite (built into Node), so there are no extra dependencies and
 * no native compilation. Writes are synchronous, which is fine: the connection
 * already serializes every save through its internal saveChain.
 *
 * @param {object}  [options]
 * @param {string}  [options.file="./data/messages.db"] SQLite file path; use
 *                  ":memory:" for tests. Parent directories are created.
 */
export function createSqliteMessageStore({ file = "./data/messages.db" } = {}) {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);
  db.exec(`
    create table if not exists chats (
      jid        text    primary key,
      name       text,
      username   text,
      is_group   integer not null default 0,
      updated_at text    not null default (datetime('now')),
      read_at    text,
      flagged    integer not null default 0,
      group_snapshot    text,
      group_snapshot_at text
    );
    create table if not exists chat_aliases (
      alias_jid     text primary key,
      canonical_jid text not null,
      updated_at    text not null default (datetime('now'))
    );
    create table if not exists messages (
      id           text    primary key,
      chat_jid     text    references chats(jid),
      from_me      integer not null,
      sender_jid   text,
      content      text,
      media        text,
      quoted       text,
      sender_email text,
      deleted      integer not null default 0,
      edited       integer not null default 0,
      reactions    text,
      timestamp    text    default (datetime('now')),
      raw_payload  text
    );
    create table if not exists templates (
      id            text    primary key,
      title         text    not null,
      body          text,
      media         text,
      fallback_name text,
      created_at    text    not null default (datetime('now')),
      updated_at    text    not null default (datetime('now'))
    );
    create table if not exists contacts (
      id         text    primary key,
      name       text,
      phone      text    not null,
      created_at text    not null default (datetime('now')),
      updated_at text    not null default (datetime('now'))
    );
    create unique index if not exists idx_contacts_phone on contacts(phone);
    create table if not exists lists (
      id          text    primary key,
      name        text    not null,
      description text,
      created_at  text    not null default (datetime('now')),
      updated_at  text    not null default (datetime('now'))
    );
    create table if not exists list_contacts (
      list_id    text not null references lists(id) on delete cascade,
      contact_id text not null references contacts(id) on delete cascade,
      primary key (list_id, contact_id)
    );
    create table if not exists broadcasts (
      id             text    primary key,
      template_id    text    not null,
      template_title text    not null default '',
      list_ids       text    not null default '[]',
      sender_email   text,
      min_delay      integer not null default 8,
      max_delay      integer not null default 25,
      send_at        text,
      status         text    not null default 'sending',
      total          integer not null default 0,
      sent           integer not null default 0,
      failed         integer not null default 0,
      created_at     text    not null default (datetime('now')),
      started_at     text,
      finished_at    text,
      error          text
    );
    create table if not exists broadcast_recipients (
      broadcast_id text    not null references broadcasts(id) on delete cascade,
      phone        text    not null,
      name         text,
      jid          text,
      status       text    not null default 'pending',
      error        text,
      sent_at      text,
      primary key (broadcast_id, phone)
    );
    create index if not exists idx_messages_chat_time on messages(chat_jid, timestamp desc);
    create index if not exists idx_messages_from_me on messages(from_me);
    create table if not exists guard_settings (
      jid            text    primary key,
      link_guard     integer not null default 0,
      toxicity_guard integer not null default 0,
      block_external integer not null default 1,
      block_invites  integer not null default 1,
      link_whitelist text    not null default '[]',
      sensitivity    text    not null default 'medium',
      warn_template  text    not null default '',
      warn_at        integer not null default 2,
      kick_at        integer not null default 5,
      created_at     text    not null default (datetime('now')),
      updated_at     text    not null default (datetime('now'))
    );
    create table if not exists moderation_log (
      id         text primary key,
      jid        text not null,
      user_name  text,
      actor_jid  text,
      action     text not null,
      reason     text,
      detail     text,
      created_at text not null default (datetime('now'))
    );
    create index if not exists idx_moderation_log_jid_time on moderation_log(jid, created_at desc);
    create table if not exists guard_strikes (
      jid        text    not null,
      user_jid   text    not null,
      count      integer not null default 0,
      updated_at text    not null default (datetime('now')),
      primary key (jid, user_jid)
    );
    create table if not exists auto_reply_rules (
      id          text    primary key,
      keyword     text    not null,
      match_type  text    not null default 'contains',
      template_id text,
      enabled     integer not null default 1,
      dm          integer not null default 1,
      quote       integer not null default 1,
      created_at  text    not null default (datetime('now')),
      updated_at  text    not null default (datetime('now'))
    );
    create table if not exists auto_reply_groups (
      rule_id text not null references auto_reply_rules(id) on delete cascade,
      jid     text not null,
      primary key (rule_id, jid)
    );
    create table if not exists away_settings (
      id               integer primary key check (id = 1),
      enabled          integer not null default 0,
      start_time       text    not null default '22:00',
      end_time         text    not null default '07:00',
      template_id      text,
      once_per_contact integer not null default 1,
      quote            integer not null default 1,
      time_zone        text    not null default '',
      updated_at       text    not null default (datetime('now'))
    );
    create table if not exists away_replies (
      chat_jid   text not null,
      window_key text not null,
      sent_at    text not null default (datetime('now')),
      primary key (chat_jid, window_key)
    );
  `);

  // SQLite has no "add column if not exists", so migrate existing databases
  // ourselves (this is a no-op on fresh databases).
  const chatColumns = db.prepare("pragma table_info(chats)").all().map((c) => c.name);
  if (!chatColumns.includes("read_at")) db.exec("alter table chats add column read_at text");
  if (!chatColumns.includes("flagged")) {
    db.exec("alter table chats add column flagged integer not null default 0");
  }
  if (!chatColumns.includes("username")) db.exec("alter table chats add column username text");
  if (!chatColumns.includes("group_snapshot")) {
    db.exec("alter table chats add column group_snapshot text");
  }
  if (!chatColumns.includes("group_snapshot_at")) {
    db.exec("alter table chats add column group_snapshot_at text");
  }
  const messageColumns = db.prepare("pragma table_info(messages)").all().map((c) => c.name);
  if (!messageColumns.includes("media")) db.exec("alter table messages add column media text");
  if (!messageColumns.includes("quoted")) db.exec("alter table messages add column quoted text");
  if (!messageColumns.includes("deleted")) {
    db.exec("alter table messages add column deleted integer not null default 0");
  }
  if (!messageColumns.includes("edited")) {
    db.exec("alter table messages add column edited integer not null default 0");
  }
  if (!messageColumns.includes("reactions")) db.exec("alter table messages add column reactions text");
  const templateColumns = db.prepare("pragma table_info(templates)").all().map((c) => c.name);
  if (!templateColumns.includes("fallback_name")) {
    db.exec("alter table templates add column fallback_name text");
  }
  const guardColumns = db.prepare("pragma table_info(guard_settings)").all().map((c) => c.name);
  if (!guardColumns.includes("toxicity_guard")) {
    db.exec("alter table guard_settings add column toxicity_guard integer not null default 0");
  }
  const autoReplyColumns = db.prepare("pragma table_info(auto_reply_rules)").all().map((c) => c.name);
  if (!autoReplyColumns.includes("quote")) {
    db.exec("alter table auto_reply_rules add column quote integer not null default 1");
  }
  const awayColumns = db.prepare("pragma table_info(away_settings)").all().map((c) => c.name);
  if (!awayColumns.includes("quote")) {
    db.exec("alter table away_settings add column quote integer not null default 1");
  }

  const insertChat = db.prepare(`
    insert or ignore into chats (jid, name, is_group, updated_at)
    values (?, null, ?, datetime('now'))
  `);
  const insertMessage = db.prepare(`
    insert or ignore into messages
      (id, chat_jid, from_me, sender_jid, content, media, quoted, sender_email, timestamp, raw_payload)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectMessages = db.prepare(
    "select id, chat_jid, from_me, sender_jid, content, timestamp, raw_payload, media, quoted, deleted, edited, reactions from messages"
  );
  const selectMessagesOf = db.prepare(
    "select id, chat_jid, from_me, sender_jid, content, timestamp, raw_payload, media, quoted, deleted, edited, reactions from messages where chat_jid = ?"
  );
  const selectChats = db.prepare("select jid, name, is_group, flagged, read_at from chats");
  const selectChat = db.prepare("select jid, name, is_group, flagged, read_at from chats where jid = ?");
  // Identity layer: every form of a jid (LID + PN) maps to one canonical chat.
  const insertChatAlias = db.prepare(`
    insert into chat_aliases (alias_jid, canonical_jid, updated_at)
    values (?, ?, ?)
    on conflict (alias_jid) do update set
      canonical_jid = excluded.canonical_jid,
      updated_at    = excluded.updated_at
  `);
  const selectChatAlias = db.prepare("select canonical_jid from chat_aliases where alias_jid = ?");
  const selectChatFull = db.prepare(
    "select jid, name, username, is_group, flagged, read_at, updated_at from chats where jid = ?"
  );
  const insertChatRow = db.prepare("insert or ignore into chats (jid, is_group) values (?, ?)");
  const updateChatMeta = db.prepare(`
    update chats set name = ?, username = ?, read_at = ?, flagged = ?, updated_at = ?
    where jid = ?
  `);
  const moveChatMessages = db.prepare("update messages set chat_jid = ? where chat_jid = ?");
  const deleteChatRow = db.prepare("delete from chats where jid = ?");
  const upsertGroupSnapshot = db.prepare(`
    insert into chats (jid, is_group, group_snapshot, group_snapshot_at, updated_at)
    values (?, 1, ?, ?, ?)
    on conflict (jid) do update set
      is_group          = 1,
      group_snapshot    = excluded.group_snapshot,
      group_snapshot_at = excluded.group_snapshot_at,
      updated_at        = excluded.updated_at
  `);
  const selectGroupSnapshot = db.prepare(
    "select group_snapshot, group_snapshot_at from chats where jid = ?"
  );
  const selectRawPayloads = db.prepare("select chat_jid, raw_payload from messages where raw_payload is not null");
  const selectNewest = db.prepare(
    "select id, chat_jid, from_me, sender_jid, content, timestamp, raw_payload, media, quoted, deleted, edited, reactions from messages where chat_jid = ? order by timestamp desc, id desc limit 1"
  );
  const selectNewestThem = db.prepare(
    "select id, chat_jid, from_me, sender_jid, content, timestamp, raw_payload, media, quoted, deleted, edited, reactions from messages where chat_jid = ? and from_me = 0 order by timestamp desc, id desc limit 1"
  );
  const selectPageFirst = db.prepare(
    "select id, chat_jid, from_me, sender_jid, content, timestamp, raw_payload, media, quoted, deleted, edited, reactions from messages where chat_jid = ? order by timestamp desc, id desc limit ?"
  );
  // SQLite has no row-value comparison, so the keyset predicate is expanded
  // into the equivalent pair of conditions (same semantics as the Postgres
  // store's `(timestamp, id) < (?, ?)`).
  const selectPageBefore = db.prepare(`
    select id, chat_jid, from_me, sender_jid, content, timestamp, raw_payload, media, quoted, deleted, edited, reactions
    from messages
    where chat_jid = ? and (timestamp < ? or (timestamp = ? and id < ?))
    order by timestamp desc, id desc
    limit ?
  `);
  // Single-message lookup + the two mutations delete/edit need. Deleting keeps
  // the row's content (only the `deleted` flag flips) so an admin can still
  // reveal what was removed.
  const selectMessage = db.prepare(
    "select id, chat_jid, from_me, sender_jid, content, timestamp, raw_payload, media, quoted, deleted, edited, reactions from messages where chat_jid = ? and id = ?"
  );
  const markMessageDeletedStmt = db.prepare(
    "update messages set deleted = 1 where chat_jid = ? and id = ?"
  );
  const updateMessageTextStmt = db.prepare(
    "update messages set content = ?, edited = 1 where chat_jid = ? and id = ?"
  );
  const updateMessageReactionsStmt = db.prepare(
    "update messages set reactions = ? where chat_jid = ? and id = ?"
  );
  const countUnreadAll = db.prepare(
    "select count(*) as c from messages where chat_jid = ? and from_me = 0"
  );
  const countUnreadSince = db.prepare(
    "select count(*) as c from messages where chat_jid = ? and from_me = 0 and timestamp > ?"
  );
  const insertTemplate = db.prepare(`
    insert into templates (id, title, body, media, fallback_name, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict (id) do update set
      title         = excluded.title,
      body          = excluded.body,
      media         = excluded.media,
      fallback_name = excluded.fallback_name,
      updated_at    = excluded.updated_at
  `);
  const updateTemplateStmt = db.prepare(`
    update templates set title = ?, body = ?, media = ?, fallback_name = ?, updated_at = ?
    where id = ?
  `);
  const selectTemplates = db.prepare(`
    select id, title, body, media, fallback_name, created_at from templates
    order by created_at desc, id desc
  `);
  const selectTemplate = db.prepare(`
    select id, title, body, media, fallback_name, created_at from templates where id = ?
  `);
  const deleteTemplateStmt = db.prepare(`delete from templates where id = ?`);
  const insertBroadcast = db.prepare(`
    insert into broadcasts
      (id, template_id, template_title, list_ids, sender_email, min_delay, max_delay,
       send_at, status, total, sent, failed, created_at, started_at, finished_at, error)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectBroadcast = db.prepare(`select * from broadcasts where id = ?`);
  const selectBroadcasts = db.prepare(`
    select * from broadcasts order by created_at desc, id desc
  `);
  const selectScheduledDue = db.prepare(`
    select * from broadcasts
    where status = 'scheduled' and send_at is not null and send_at <= ?
    order by send_at asc, id asc
  `);
  const selectInterrupted = db.prepare(`select * from broadcasts where status = 'sending'`);
  const claimBroadcastScheduled = db.prepare(`
    update broadcasts set status = 'sending', started_at = ?
    where id = ? and status = 'scheduled'
  `);
  const insertBroadcastRecipient = db.prepare(`
    insert into broadcast_recipients (broadcast_id, phone, name, jid, status, error, sent_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `);
  const selectBroadcastRecipients = db.prepare(`
    select * from broadcast_recipients where broadcast_id = ? order by phone asc
  `);
  const insertContact = db.prepare(`
    insert into contacts (id, name, phone, created_at, updated_at)
    values (?, ?, ?, ?, ?)
  `);
  const updateContactStmt = db.prepare(`
    update contacts set name = ?, phone = ?, updated_at = ? where id = ?
  `);
  const selectContacts = db.prepare(`
    select id, name, phone, created_at from contacts order by created_at desc, id desc
  `);
  const selectContactsLike = db.prepare(`
    select id, name, phone, created_at from contacts
    where lower(name) like ? or phone like ?
    order by created_at desc, id desc
  `);
  const selectContact = db.prepare(`
    select id, name, phone, created_at from contacts where id = ?
  `);
  const selectContactByPhone = db.prepare(`
    select id, name, phone, created_at from contacts where phone = ?
  `);
  const selectContactPhones = db.prepare(`select phone from contacts`);
  const deleteContactStmt = db.prepare(`delete from contacts where id = ?`);
  const insertList = db.prepare(`
    insert into lists (id, name, description, created_at, updated_at)
    values (?, ?, ?, ?, ?)
  `);
  const updateListStmt = db.prepare(`
    update lists set name = ?, description = ?, updated_at = ? where id = ?
  `);
  const selectLists = db.prepare(`
    select id, name, description, created_at,
      (select count(*) from list_contacts where list_id = lists.id) as member_count
    from lists
    order by created_at desc, id desc
  `);
  const selectList = db.prepare(`
    select id, name, description, created_at,
      (select count(*) from list_contacts where list_id = lists.id) as member_count
    from lists where id = ?
  `);
  const selectListsForContact = db.prepare(`
    select id, name, description, created_at,
      (select count(*) from list_contacts where list_id = lists.id) as member_count
    from lists
    where id in (select list_id from list_contacts where contact_id = ?)
    order by created_at desc, id desc
  `);
  const deleteListStmt = db.prepare(`delete from lists where id = ?`);
  const selectListContactIds = db.prepare(`
    select contact_id from list_contacts where list_id = ? order by contact_id
  `);
  const insertListContact = db.prepare(`
    insert or ignore into list_contacts (list_id, contact_id) values (?, ?)
  `);
  const deleteListContacts = db.prepare(`delete from list_contacts where list_id = ?`);
  const deleteContactMemberships = db.prepare(`delete from list_contacts where contact_id = ?`);
  const upsertGuardSettings = db.prepare(`
    insert into guard_settings
      (jid, link_guard, toxicity_guard, block_external, block_invites, link_whitelist,
       sensitivity, warn_template, warn_at, kick_at, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      updated_at     = excluded.updated_at
  `);
  const selectGuardSettings = db.prepare(`select * from guard_settings where jid = ?`);
  const insertModeration = db.prepare(`
    insert into moderation_log (id, jid, user_name, actor_jid, action, reason, detail, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectModeration = db.prepare(`select * from moderation_log where id = ?`);
  const selectModerationForJid = db.prepare(`
    select * from moderation_log where jid = ? order by created_at desc, id desc limit ?
  `);
  const selectStrike = db.prepare(`select count, updated_at from guard_strikes where jid = ? and user_jid = ?`);
  const upsertStrike = db.prepare(`
    insert into guard_strikes (jid, user_jid, count, updated_at)
    values (?, ?, ?, ?)
    on conflict (jid, user_jid) do update set
      count      = excluded.count,
      updated_at = excluded.updated_at
  `);
  const deleteStrike = db.prepare(`delete from guard_strikes where jid = ? and user_jid = ?`);
  const insertAutoReply = db.prepare(`
    insert into auto_reply_rules
      (id, keyword, match_type, template_id, enabled, dm, quote, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const selectAutoReply = db.prepare(`select * from auto_reply_rules where id = ?`);
  const selectAllAutoReplies = db.prepare(
    `select * from auto_reply_rules order by created_at asc, id asc`
  );
  const updateAutoReplyRow = db.prepare(`
    update auto_reply_rules
      set keyword = ?, match_type = ?, template_id = ?, enabled = ?, dm = ?, quote = ?, updated_at = ?
      where id = ?
  `);
  const deleteAutoReplyRow = db.prepare(`delete from auto_reply_rules where id = ?`);
  const selectRuleGroups = db.prepare(
    `select jid from auto_reply_groups where rule_id = ? order by jid asc`
  );
  const deleteRuleGroups = db.prepare(`delete from auto_reply_groups where rule_id = ?`);
  const insertRuleGroup = db.prepare(
    `insert or ignore into auto_reply_groups (rule_id, jid) values (?, ?)`
  );
  const selectAwaySettings = db.prepare(`select * from away_settings where id = 1`);
  const upsertAwaySettings = db.prepare(`
    insert into away_settings
      (id, enabled, start_time, end_time, template_id, once_per_contact, quote, time_zone, updated_at)
    values (1, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (id) do update set
      enabled          = excluded.enabled,
      start_time       = excluded.start_time,
      end_time         = excluded.end_time,
      template_id      = excluded.template_id,
      once_per_contact = excluded.once_per_contact,
      quote            = excluded.quote,
      time_zone        = excluded.time_zone,
      updated_at       = excluded.updated_at
  `);
  const insertAwayReply = db.prepare(
    `insert or ignore into away_replies (chat_jid, window_key, sent_at) values (?, ?, ?)`
  );
  const selectAwayReply = db.prepare(
    `select 1 as ok from away_replies where chat_jid = ? and window_key = ?`
  );

  function toMessageView(row) {
    const raw = row.raw_payload ? JSON.parse(row.raw_payload) : null;
    let media = null;
    if (row.media) {
      try {
        media = JSON.parse(row.media);
      } catch {
        media = null; // corrupt sidecar data: treat as no media
      }
    }
    let quoted = null;
    if (row.quoted) {
      try {
        quoted = JSON.parse(row.quoted);
      } catch {
        quoted = null; // corrupt sidecar data: treat as no quote
      }
    }
    let reactions = null;
    if (row.reactions) {
      try {
        reactions = JSON.parse(row.reactions);
      } catch {
        reactions = null; // corrupt sidecar data: treat as no reactions
      }
    }
    return {
      id: row.id,
      chat: row.chat_jid,
      fromMe: Boolean(row.from_me),
      sender: row.sender_jid ?? null,
      text: row.content ?? null,
      tsMs: row.timestamp ? new Date(row.timestamp).getTime() : 0,
      pushName: raw?.pushName ?? null,
      quoted: quoted ?? null,
      deleted: Boolean(row.deleted),
      edited: Boolean(row.edited),
      reactions,
      system: raw?.system ?? null,
      media: media
        ? {
            type: media.type ?? null,
            mimeType: media.mimeType ?? null,
            fileName: media.fileName ?? null,
            url: media.url ?? `/api/media/${media.key}`,
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

  function save(message) {
    const timestamp = new Date(message.receivedAt ?? Date.now()).toISOString();
    const rawPayload =
      message.raw == null && !message.system
        ? null
        : {
            ...(message.raw ?? {}),
            ...(message.system ? { system: message.system } : {}),
          };
    const rawJson = rawPayload == null ? null : JSON.stringify(rawPayload, BufferJSON.replacer);
    const media = message.media ?? null;
    const quoted = message.quoted ?? null;

    // The chat row must exist before the message row (FK), so write both in the
    // same transaction, chat first — same semantics as the Postgres store.
    db.exec("begin");
    try {
      insertChat.run(message.chat, message.isGroup ? 1 : 0);
      insertMessage.run(
        message.id,
        message.chat,
        message.fromMe ? 1 : 0,
        message.sender ?? null,
        message.text ?? null,
        media ? JSON.stringify(media) : null,
        quoted ? JSON.stringify(quoted) : null,
        message.senderEmail ?? null,
        timestamp,
        rawJson
      );
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }

  /** One stored message as a view (with its deleted/edited flags), or null. */
  function getMessage(chat, id) {
    const row = selectMessage.get(chat, id);
    return row ? toMessageView(row) : null;
  }

  /**
   * The Baileys key stored for a message (needed to edit/revoke it on
   * WhatsApp) and the raw content (needed to quote it in a reply), plus whether
   * it was ours. Null when the row is unknown.
   */
  function getMessageRaw(chat, id) {
    const row = selectMessage.get(chat, id);
    if (!row) return null;
    let raw = null;
    try {
      raw = row.raw_payload ? JSON.parse(row.raw_payload) : null;
    } catch {
      raw = null; // corrupt payload: no key to reuse
    }
    return {
      id: row.id,
      chat: row.chat_jid,
      fromMe: Boolean(row.from_me),
      key: raw?.key ?? null,
      message: raw?.message ?? null,
      deleted: Boolean(row.deleted),
    };
  }

  /** Flags a message deleted; returns whether a row changed. */
  function markMessageDeleted(chat, id) {
    return markMessageDeletedStmt.run(chat, id).changes > 0;
  }

  /** Replaces a message's text and flags it edited; returns whether it changed. */
  function updateMessageText(chat, id, text) {
    return updateMessageTextStmt.run(text ?? null, chat, id).changes > 0;
  }

  /**
   * Sets (or, with `entry = null`, removes) one reactor's reaction on a
   * message. Reactions live in a JSON sidecar keyed by reactor ("me" or a bare
   * jid), so each person has at most one per message and the latest write wins.
   * Returns the updated map, or null when the message is unknown.
   */
  function setMessageReaction(chat, id, reactor, entry) {
    const row = selectMessage.get(chat, id);
    if (!row) return null;
    let reactions = null;
    if (row.reactions) {
      try {
        reactions = JSON.parse(row.reactions);
      } catch {
        reactions = null; // corrupt sidecar data: rebuild from scratch
      }
    }
    const next = { ...(reactions ?? {}) };
    if (entry && entry.text) next[reactor] = entry;
    else delete next[reactor];
    updateMessageReactionsStmt.run(
      Object.keys(next).length ? JSON.stringify(next) : null,
      chat,
      id
    );
    return next;
  }

  function listConversations(q = null) {
    return groupConversations(
      { messages: selectMessages.all().map(toMessageView), chats: chatsToMeta(selectChats.all()) },
      { summary: true, q }
    );
  }

  /**
   * Thread detail. Without `limit` this returns today's shape: the conversation
   * with the full thread (ascending). With `limit` (int >= 1) it pages the
   * NEWEST messages via a keyset `before` cursor and returns
   * { conversation, hasMore, nextBefore } — see src/db/inbox.js for the cursor
   * format. `before` must be the decoded { timestamp, id } object (the API
   * validates the raw string and returns 400 on malformed input).
   */
  function getMessages(chatJid, { limit = null, before = null } = {}) {
    if (!limit) {
      const messages = selectMessagesOf.all(chatJid).map(toMessageView);
      const chat = selectChat.get(chatJid);
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

    const chat = selectChat.get(chatJid);
    const newest = selectNewest.get(chatJid);
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
    const rowsDesc = before
      ? selectPageBefore.all(chatJid, before.timestamp, before.timestamp, before.id, take)
      : selectPageFirst.all(chatJid, take);
    const hasMore = rowsDesc.length > limit;
    const page = hasMore ? rowsDesc.slice(0, limit) : rowsDesc;
    const messages = [...page].reverse().map(toMessageView);
    const newestThem = selectNewestThem.get(chatJid);

    // Meta (name, unread, lastMessageAt) comes from the whole conversation,
    // not the page, so every page agrees on it.
    const conversation = buildThreadConversation({
      jid: chatJid,
      chatName: chat?.name ?? null,
      isGroup: Boolean(chat?.is_group),
      flagged: Boolean(chat?.flagged),
      unread: chat?.read_at == null
        ? countUnreadAll.get(chatJid).c
        : countUnreadSince.get(chatJid, chat.read_at).c,
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

  function markRead(chatJid) {
    db.exec("begin");
    try {
      db.prepare("insert or ignore into chats (jid, is_group) values (?, 0)").run(chatJid);
      db.prepare("update chats set read_at = ? where jid = ?").run(new Date().toISOString(), chatJid);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }

  function setFlagged(chatJid, flagged) {
    db.exec("begin");
    try {
      db.prepare("insert or ignore into chats (jid, is_group) values (?, 0)").run(chatJid);
      db.prepare("update chats set flagged = ? where jid = ?").run(flagged ? 1 : 0, chatJid);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }

  /* ----------------------------- identities ------------------------------- */

  const nowIso = () => new Date().toISOString();

  /** Later of two ISO timestamps (null-safe). */
  function laterIso(a, b) {
    if (!a) return b ?? null;
    if (!b) return a;
    return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
  }

  /** Canonical chat id for a jid, or the jid itself when no alias is known. */
  function resolveChatJid(jid) {
    if (!jid) return jid;
    const row = selectChatAlias.get(jid);
    return row?.canonical_jid ?? jid;
  }

  /**
   * Folds `aliasJid` into `canonicalJid`: records the alias, re-points the
   * alias's messages at the canonical chat and merges the two chat rows
   * (name/username/read_at/flagged, latest updated_at), then drops the alias
   * row. Idempotent — a second call with the same pair is a no-op. Returns the
   * canonical id.
   */
  function canonicalizeChat(aliasJid, canonicalJid) {
    if (!aliasJid) return canonicalJid ?? aliasJid;
    const canonical = resolveChatJid(canonicalJid ?? aliasJid);
    const now = nowIso();
    if (aliasJid === canonical) {
      insertChatAlias.run(aliasJid, canonical, now);
      return canonical;
    }
    const alias = selectChatFull.get(aliasJid);
    const target = selectChatFull.get(canonical);
    db.exec("begin");
    try {
      insertChatRow.run(canonical, 0);
      moveChatMessages.run(canonical, aliasJid);
      updateChatMeta.run(
        target?.name ?? alias?.name ?? null,
        target?.username ?? alias?.username ?? null,
        laterIso(target?.read_at ?? null, alias?.read_at ?? null),
        (target?.flagged || alias?.flagged) ? 1 : 0,
        laterIso(laterIso(target?.updated_at ?? null, alias?.updated_at ?? null), now),
        canonical
      );
      deleteChatRow.run(aliasJid);
      insertChatAlias.run(aliasJid, canonical, now);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
    return canonical;
  }

  /**
   * Stores the address-book name (and @username) WhatsApp synced for a chat.
   * Uses coalesce semantics so a later sync without a name never wipes one we
   * already have. Group jids are flagged as groups (is_group = 1) so a chat row
   * created here is never mistaken for a 1:1.
   */
  function setChatName(jid, name, username = null) {
    if (!jid) return;
    const clean = typeof name === "string" ? name.trim() : "";
    const user = typeof username === "string" ? username.trim() : "";
    if (!clean && !user) return;
    const group = isGroupJid(jid);
    db.exec("begin");
    try {
      insertChatRow.run(jid, group ? 1 : 0);
      db.prepare(
        "update chats set name = coalesce(?, name), username = coalesce(?, username), is_group = ?, updated_at = ? where jid = ?"
      ).run(clean || null, user || null, group ? 1 : 0, nowIso(), jid);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }

  /**
   * The stored address-book/group name we know for a jid (resolved to its
   * canonical chat), or null when there is none. Used to decorate group
   * participants (and any other jid) with the best name the store has.
   */
  function resolveChatName(jid) {
    if (!jid) return null;
    const row = selectChatFull.get(resolveChatJid(jid));
    const name = row?.name;
    return typeof name === "string" && name.trim() ? name : null;
  }

  /**
   * Persists a group metadata snapshot on the group's chat row (see
   * src/whatsapp/group-snapshot.js for the shape). Mirrors the Postgres store.
   * A non-group jid is refused so a stray event can't seed a 1:1 row.
   */
  function saveGroupSnapshot(jid, snapshot) {
    if (!jid || !isGroupJid(jid) || !snapshot) return;
    upsertGroupSnapshot.run(jid, JSON.stringify(snapshot), nowIso(), nowIso());
  }

  /**
   * The stored snapshot for a group, or null. Returns { snapshot, fetchedAt }
   * with fetchedAt as epoch ms (0 when unknown) so the route can decide whether
   * it is fresh enough to skip WhatsApp.
   */
  function getGroupSnapshot(jid) {
    if (!jid) return null;
    const row = selectGroupSnapshot.get(jid);
    if (!row?.group_snapshot) return null;
    let snapshot;
    try {
      snapshot = JSON.parse(row.group_snapshot);
    } catch {
      return null;
    }
    const at = row.group_snapshot_at ? new Date(row.group_snapshot_at).getTime() : 0;
    return { snapshot, fetchedAt: Number.isFinite(at) ? at : 0 };
  }

  /**
   * One-time (idempotent) backfill: learns lid<->pn pairs from stored raw
   * payloads and merges already-split chats onto their canonical id. Runs at
   * store creation so existing databases heal on the next start.
   */
  function backfillChatIdentities() {
    const rows = selectRawPayloads.all();
    const pairs = [];
    for (const row of rows) {
      let raw = null;
      try {
        raw = JSON.parse(row.raw_payload);
      } catch {
        continue; // corrupt payload: nothing to learn
      }
      const pair = pairFromRaw(raw);
      if (pair) pairs.push(pair);
    }
    for (const [jid, canonical] of clusterIdentities(pairs)) {
      if (jid !== canonical) canonicalizeChat(jid, canonical);
      else insertChatAlias.run(jid, canonical, nowIso());
    }
  }

  backfillChatIdentities();

  function templateToView(row) {
    let media = null;
    if (row.media) {
      try {
        media = JSON.parse(row.media);
      } catch {
        media = null; // corrupt ref: treat as no media
      }
    }
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
            url: media.url ?? `/api/media/${media.key}`,
          }
        : null,
      createdAt: row.created_at ?? null,
    };
  }

  /**
   * Upserts a template. `id` defaults to a new uuid (create); pass one to
   * overwrite (used by the API's update when it wants to replace wholesale).
   * `media` is the stored ref { key, type, mimeType, fileName } or null.
   */
  function saveTemplate({ id = randomUUID(), title, body = "", media = null, fallbackName = "" } = {}) {
    const now = new Date().toISOString();
    insertTemplate.run(
      id,
      title ?? "",
      body ?? "",
      media ? JSON.stringify(media) : null,
      fallbackName ?? "",
      now,
      now
    );
    return templateToView(selectTemplate.get(id));
  }

  /** All templates, newest first. */
  function listTemplates() {
    return selectTemplates.all().map(templateToView);
  }

  /** One template (with its media view) or null. */
  function getTemplate(id) {
    const row = selectTemplate.get(id);
    return row ? templateToView(row) : null;
  }

  /**
   * Updates an existing template. `media` semantics:
   *   undefined -> keep the current attachment, null -> clear it, ref -> replace.
   * Returns the updated view, or null when no template has that id.
   */
  function updateTemplate(id, { title, body = "", media, fallbackName } = {}) {
    const current = selectTemplate.get(id);
    if (!current) return null;
    const now = new Date().toISOString();
    const nextMedia = media === undefined
      ? current.media
      : media
        ? JSON.stringify(media)
        : null;
    const nextFallback = fallbackName === undefined ? (current.fallback_name ?? "") : (fallbackName ?? "");
    updateTemplateStmt.run(title ?? "", body ?? "", nextMedia, nextFallback, now, id);
    return templateToView(selectTemplate.get(id));
  }

  /** Deletes a template; returns whether a row was removed. */
  function deleteTemplate(id) {
    return deleteTemplateStmt.run(id).changes > 0;
  }

  /* ------------------------------- broadcasts ------------------------------ */

  // Mutable columns the API may patch on a broadcast / recipient row.
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

  /** Runs a dynamic UPDATE built from a column whitelist; returns changes. */
  function patchBroadcast(id, patch, columns) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (Object.hasOwn(patch, key) && patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key]);
      }
    }
    if (!sets.length) return 0;
    values.push(id);
    return db.prepare(`update broadcasts set ${sets.join(", ")} where id = ?`).run(...values).changes;
  }

  /**
   * Creates a broadcast plus its recipient rows (all `pending`) in a single
   * transaction. `recipients` is [{ phone, name }] and is deduped by phone;
   * `total` is derived from the deduped list.
   */
  function createBroadcast({
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
    const now = createdAt ?? new Date().toISOString();
    const members = dedupeRecipients(recipients);
    db.exec("begin");
    try {
      insertBroadcast.run(
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
        error ?? null
      );
      for (const r of members) {
        insertBroadcastRecipient.run(id, r.phone, r.name ?? null, null, "pending", null, null);
      }
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
    return broadcastToView(selectBroadcast.get(id));
  }

  /** One broadcast view, or null. */
  function getBroadcast(id) {
    const row = selectBroadcast.get(id);
    return row ? broadcastToView(row) : null;
  }

  /** All broadcasts, newest first. */
  function listBroadcasts() {
    return selectBroadcasts.all().map(broadcastToView);
  }

  /**
   * Applies a partial patch to a broadcast (status/sent/failed/startedAt/
   * finishedAt/error). Returns the updated view, or null when missing.
   */
  function updateBroadcast(id, patch = {}) {
    const changes = patchBroadcast(id, patch, BROADCAST_PATCH_COLUMNS);
    if (changes === 0 && !selectBroadcast.get(id)) return null;
    return getBroadcast(id);
  }

  /** All recipients of a broadcast, ordered by phone. */
  function listBroadcastRecipients(broadcastId) {
    return selectBroadcastRecipients.all(broadcastId).map(recipientToView);
  }

  /** Updates one recipient row (status/error/jid/sentAt). */
  function markBroadcastRecipient(broadcastId, phone, patch = {}) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(RECIPIENT_PATCH_COLUMNS)) {
      if (Object.hasOwn(patch, key)) {
        sets.push(`${column} = ?`);
        values.push(patch[key] ?? null);
      }
    }
    if (!sets.length) return false;
    values.push(broadcastId, phone);
    const info = db
      .prepare(`update broadcast_recipients set ${sets.join(", ")} where broadcast_id = ? and phone = ?`)
      .run(...values);
    return info.changes > 0;
  }

  /**
   * Atomically claims scheduled broadcasts whose send_at has arrived: each
   * due row flips to 'sending' (guarded on the old status) and is returned.
   * The status guard means a row can only be claimed once.
   */
  function claimDueBroadcasts(now = new Date().toISOString()) {
    const due = selectScheduledDue.all(now);
    const claimed = [];
    for (const row of due) {
      if (claimBroadcastScheduled.run(now, row.id).changes === 1) {
        claimed.push(broadcastToView(selectBroadcast.get(row.id)));
      }
    }
    return claimed;
  }

  /** Broadcasts left in 'sending' by a previous process (startup resume). */
  function listInterruptedBroadcasts() {
    return selectInterrupted.all().map(broadcastToView);
  }

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
  function listContacts(q = null) {
    const term = q == null ? "" : String(q).trim();
    if (!term) return selectContacts.all().map(contactToView);
    const like = `%${term.toLowerCase()}%`;
    return selectContactsLike.all(like, like).map(contactToView);
  }

  function getContact(id) {
    const row = selectContact.get(id);
    return row ? contactToView(row) : null;
  }

  /** Existing contact with this canonical phone, or null (for 409 checks). */
  function getContactByPhone(phone) {
    const row = selectContactByPhone.get(phone);
    return row ? contactToView(row) : null;
  }

  function createContact({ name = "", phone } = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();
    insertContact.run(id, cleanName(name), requirePhone(phone), now, now);
    return contactToView(selectContact.get(id));
  }

  function updateContact(id, { name = "", phone } = {}) {
    const normalized = requirePhone(phone);
    const changes = updateContactStmt.run(
      cleanName(name),
      normalized,
      new Date().toISOString(),
      id
    ).changes;
    if (changes === 0) return null;
    return contactToView(selectContact.get(id));
  }

  /** Deletes a contact and its list memberships. Deleting a contact keeps lists. */
  function deleteContact(id) {
    db.exec("begin");
    try {
      deleteContactMemberships.run(id);
      const changes = deleteContactStmt.run(id).changes;
      db.exec("commit");
      return changes > 0;
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }

  /**
   * Bulk delete: removes every listed contact and its list memberships in one
   * transaction. Lists are always kept. Returns how many contacts actually
   * existed and were removed (unknown ids are ignored).
   */
  function deleteContacts(ids) {
    const unique = [...new Set((ids ?? []).map(String))];
    if (!unique.length) return 0;
    db.exec("begin");
    try {
      let deleted = 0;
      for (const id of unique) {
        deleteContactMemberships.run(id);
        deleted += deleteContactStmt.run(id).changes;
      }
      db.exec("commit");
      return deleted;
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }

  /**
   * Bulk insert. Rows with an unsupported number are skipped as "invalid
   * number"; duplicates (already stored, or repeated in this batch) are skipped
   * as "already exists". The valid rows are inserted in one transaction.
   */
  function importContacts(rows) {
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

    const stored = new Set(selectContactPhones.all().map((r) => r.phone));
    const toInsert = [];
    for (const c of candidates) {
      if (stored.has(c.phone)) skipped.push({ phone: c.phone, reason: "already exists" });
      else toInsert.push(c);
    }

    const now = new Date().toISOString();
    db.exec("begin");
    try {
      for (const c of toInsert) insertContact.run(randomUUID(), c.name, c.phone, now, now);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
    return { imported: toInsert.length, skipped };
  }

  /** Keeps only the ids that actually exist, de-duped (mirrors the FK filter). */
  function existingContactIds(contactIds) {
    const ids = [...new Set((contactIds ?? []).map(String))];
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return db
      .prepare(`select id from contacts where id in (${placeholders})`)
      .all(...ids)
      .map((r) => r.id);
  }

  /** All lists newest first, each with its computed memberCount. */
  function listLists() {
    return selectLists.all().map(listToView);
  }

  /** All lists that contain the given contact, newest first. */
  function listListsForContact(contactId) {
    return selectListsForContact.all(contactId).map(listToView);
  }

  /** One list with memberCount plus its member contactIds, or null. */
  function getList(id) {
    const row = selectList.get(id);
    if (!row) return null;
    const contactIds = selectListContactIds.all(id).map((r) => r.contact_id);
    return { ...listToView(row), contactIds };
  }

  function createList({ name, description = "", contactIds = [] } = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const members = existingContactIds(contactIds);
    db.exec("begin");
    try {
      insertList.run(id, String(name ?? "").trim(), String(description ?? ""), now, now);
      for (const contactId of members) insertListContact.run(id, contactId);
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
    return listToView(selectList.get(id));
  }

  /**
   * Updates a list. When `contactIds` is provided the whole membership is
   * replaced (unknown ids are dropped); when it is undefined the membership is
   * left untouched. Returns the updated view, or null when the list is missing.
   */
  function updateList(id, { name, description = "", contactIds } = {}) {
    const now = new Date().toISOString();
    db.exec("begin");
    try {
      const changes = updateListStmt.run(
        String(name ?? "").trim(),
        String(description ?? ""),
        now,
        id
      ).changes;
      if (changes === 0) {
        db.exec("rollback");
        return null;
      }
      if (contactIds !== undefined) {
        deleteListContacts.run(id);
        for (const contactId of existingContactIds(contactIds)) insertListContact.run(id, contactId);
      }
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
    return listToView(selectList.get(id));
  }

  /** Deletes a list and its memberships; the contacts themselves are kept. */
  function deleteList(id) {
    db.exec("begin");
    try {
      deleteListContacts.run(id);
      const changes = deleteListStmt.run(id).changes;
      db.exec("commit");
      return changes > 0;
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
  }

  /* --------------------------------- guards -------------------------------- */

  /** Saved guard settings view, or null when the group is unguarded. */
  function getGuardSettings(jid) {
    const row = selectGuardSettings.get(jid);
    return row ? guardSettingsToView(row) : null;
  }

  /**
   * Upserts a group's guard settings (full replace). `created_at` is preserved
   * on update; `updated_at` always moves to now. Returns the saved view.
   */
  function saveGuardSettings(jid, settings = {}) {
    const value = { ...DEFAULT_GUARD_SETTINGS, ...settings };
    const now = new Date().toISOString();
    upsertGuardSettings.run(
      jid,
      value.linkGuard ? 1 : 0,
      value.toxicityGuard ? 1 : 0,
      value.blockExternal ? 1 : 0,
      value.blockInvites ? 1 : 0,
      JSON.stringify(Array.isArray(value.linkWhitelist) ? value.linkWhitelist : []),
      value.sensitivity ?? DEFAULT_GUARD_SETTINGS.sensitivity,
      value.warnTemplate ?? "",
      Number.isInteger(value.warnAt) ? value.warnAt : DEFAULT_GUARD_SETTINGS.warnAt,
      Number.isInteger(value.kickAt) ? value.kickAt : DEFAULT_GUARD_SETTINGS.kickAt,
      now,
      now
    );
    return getGuardSettings(jid);
  }

  /** Appends a moderation log entry (explicit ISO timestamp) and returns it. */
  function logModeration({
    id = randomUUID(),
    jid,
    user = null,
    actorJid = null,
    action,
    reason = "",
    detail = null,
    time = null,
  } = {}) {
    const createdAt = time ?? new Date().toISOString();
    insertModeration.run(id, jid, user ?? null, actorJid ?? null, action, reason ?? "", detail ?? null, createdAt);
    return moderationEntryToView(selectModeration.get(id));
  }

  /** A group's moderation log, newest first (default 50). */
  function listModeration(jid, limit = 50) {
    const size = Number.isInteger(limit) && limit > 0 ? limit : 50;
    return selectModerationForJid.all(jid, size).map(moderationEntryToView);
  }

  /** Current strike record { count, updatedAt } (zeroed when none/expired). */
  function getStrikes(jid, userJid, { now = Date.now(), decayMs = STRIKE_DECAY_MS } = {}) {
    const row = selectStrike.get(jid, userJid);
    if (!row) return { count: 0, updatedAt: null };
    const at = row.updated_at ? new Date(row.updated_at).getTime() : NaN;
    if (!Number.isFinite(at) || now - at > decayMs) return { count: 0, updatedAt: null };
    return { count: Number(row.count) || 0, updatedAt: row.updated_at };
  }

  /**
   * Records a new offence and returns the resulting (decayed) strike count.
   * A stale record restarts at 1 rather than continuing an old tally.
   */
  function bumpStrike(jid, userJid, { now = Date.now(), decayMs = STRIKE_DECAY_MS } = {}) {
    const current = getStrikes(jid, userJid, { now, decayMs });
    const count = current.count + 1;
    upsertStrike.run(jid, userJid, count, new Date(now).toISOString());
    return count;
  }

  /** Clears a member's strikes (e.g. after a warning/kick). Returns whether one existed. */
  function resetStrikes(jid, userJid) {
    return deleteStrike.run(jid, userJid).changes > 0;
  }

  /* ------------------------------ automation ------------------------------- */

  function ruleGroups(ruleId) {
    return selectRuleGroups.all(ruleId).map((row) => row.jid);
  }

  /** Replaces a rule's group scope (unknown/duplicate jids are dropped). */
  function setRuleGroups(ruleId, groups) {
    deleteRuleGroups.run(ruleId);
    const seen = new Set();
    for (const raw of Array.isArray(groups) ? groups : []) {
      const jid = typeof raw === "string" ? raw.trim() : "";
      if (!jid || seen.has(jid)) continue;
      seen.add(jid);
      insertRuleGroup.run(ruleId, jid);
    }
  }

  /** One auto-reply rule view, or null when it doesn't exist. */
  function getAutoReply(id) {
    const row = selectAutoReply.get(id);
    return row ? autoReplyToView(row, ruleGroups(id)) : null;
  }

  /** Every auto-reply rule, oldest first (evaluation order). */
  function listAutoReplies() {
    return selectAllAutoReplies.all().map((row) => autoReplyToView(row, ruleGroups(row.id)));
  }

  /** Creates an auto-reply rule and returns its view. */
  function createAutoReply({
    id = randomUUID(),
    keyword,
    match = "contains",
    templateId = null,
    enabled = true,
    dm = true,
    quote = true,
    groups = [],
  } = {}) {
    const now = new Date().toISOString();
    insertAutoReply.run(
      id,
      keyword ?? "",
      MATCH_TYPES.includes(match) ? match : "contains",
      templateId ?? null,
      enabled ? 1 : 0,
      dm ? 1 : 0,
      quote ? 1 : 0,
      now,
      now
    );
    setRuleGroups(id, groups);
    return getAutoReply(id);
  }

  /**
   * Updates a rule; omitted fields keep their current value. `groups` replaces
   * the scope only when provided. Returns the updated view, or null if missing.
   */
  function updateAutoReply(id, patch = {}) {
    const existing = selectAutoReply.get(id);
    if (!existing) return null;
    const match = patch.match ?? existing.match_type;
    updateAutoReplyRow.run(
      patch.keyword !== undefined ? patch.keyword : existing.keyword,
      MATCH_TYPES.includes(match) ? match : "contains",
      patch.templateId !== undefined ? (patch.templateId ?? null) : existing.template_id,
      (patch.enabled !== undefined ? patch.enabled : Boolean(existing.enabled)) ? 1 : 0,
      (patch.dm !== undefined ? patch.dm : Boolean(existing.dm)) ? 1 : 0,
      (patch.quote !== undefined ? patch.quote : existing.quote !== 0) ? 1 : 0,
      new Date().toISOString(),
      id
    );
    if (patch.groups !== undefined) setRuleGroups(id, patch.groups);
    return getAutoReply(id);
  }

  /** Deletes a rule (its group scope cascades). Returns whether one existed. */
  function deleteAutoReply(id) {
    return deleteAutoReplyRow.run(id).changes > 0;
  }

  /** Away-mode settings (defaults when never saved). */
  function getAwaySettings() {
    return awaySettingsToView(selectAwaySettings.get());
  }

  /** Upserts the single away-mode row; omitted fields keep their value. */
  function saveAwaySettings(patch = {}) {
    const value = { ...getAwaySettings(), ...patch };
    upsertAwaySettings.run(
      value.enabled ? 1 : 0,
      value.start ?? DEFAULT_AWAY_SETTINGS.start,
      value.end ?? DEFAULT_AWAY_SETTINGS.end,
      value.templateId ?? null,
      value.oncePerContact ? 1 : 0,
      value.quote ? 1 : 0,
      value.timeZone ?? "",
      new Date().toISOString()
    );
    return getAwaySettings();
  }

  /** Records that the away message was sent to a chat in this window instance. */
  function markAwayReply(chatJid, windowKey) {
    insertAwayReply.run(chatJid, windowKey, new Date().toISOString());
  }

  /** Whether the away message was already sent to a chat in this window. */
  function hasAwayReply(chatJid, windowKey) {
    return Boolean(selectAwayReply.get(chatJid, windowKey));
  }

  /**
   * Deletes every row from every table, in one transaction. Children go first
   * (join/recipient/log tables) so the foreign keys stay satisfied.
   *
   * Powers the "clear backend data" action. The WhatsApp session lives in the
   * auth store (./auth or Postgres), not here, so the device stays linked.
   *
   * @returns {number} the number of tables emptied
   */
  function clearAll() {
    const tables = [
      "broadcast_recipients",
      "broadcasts",
      "list_contacts",
      "lists",
      "contacts",
      "templates",
      "messages",
      "chat_aliases",
      "chats",
      "moderation_log",
      "guard_strikes",
      "guard_settings",
      "auto_reply_groups",
      "auto_reply_rules",
      "away_replies",
      "away_settings",
    ];
    db.exec("begin");
    try {
      for (const table of tables) db.prepare(`delete from ${table}`).run();
      db.exec("commit");
    } catch (err) {
      db.exec("rollback");
      throw err;
    }
    return tables.length;
  }

  return {
    save,
    listConversations,
    getMessages,
    getMessage,
    getMessageRaw,
    markMessageDeleted,
    updateMessageText,
    setMessageReaction,
    markRead,
    setFlagged,
    resolveChatJid,
    canonicalizeChat,
    setChatName,
    resolveChatName,
    saveGroupSnapshot,
    getGroupSnapshot,
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
    clearAll,
    close() {
      db.close();
    },
  };
}