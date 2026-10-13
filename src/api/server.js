import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { decodeCursor, toMessageView } from "../db/inbox.js";
import {
  MAX_LIST_DESCRIPTION,
  MAX_LIST_NAME,
  MAX_PHONE_DIGITS,
  MIN_PHONE_DIGITS,
  normalizePhone,
} from "../db/contacts.js";
import { MEDIA_TYPES } from "../media/store.js";
import { buildTemplateContent, loadTemplateMedia } from "../broadcasts/content.js";
import { DEFAULT_GUARD_SETTINGS, validateGuardSettings } from "../db/guards.js";
import {
  validateAutoReply,
  validateAwaySettings,
} from "../db/automation.js";
import { canonicalId } from "../whatsapp/identity.js";

const MAX_TEXT_LENGTH = 4096; // WhatsApp text limit
const MAX_TITLE_LENGTH = 200; // template titles / fallback names
const MAX_IMPORT_CONTACTS = 5000; // POST /api/contacts/import row cap
const MAX_BROADCAST_LISTS = 100; // POST /api/broadcasts/send list id cap
const MAX_BROADCAST_RECIPIENTS = 5000; // resolved-recipient cap (matches import)
const DEFAULT_MIN_DELAY = 8; // broadcast seconds between messages
const DEFAULT_MAX_DELAY = 25;
const MAX_BROADCAST_DELAY = 3600; // 1 hour
const MAX_SENDER_EMAIL = 320;
const BROADCAST_POLL_MS = 15_000; // scheduled-broadcast scheduler tick
const DEFAULT_MAX_MEDIA_BYTES = 20 * 1024 * 1024;
const EVENT_HEARTBEAT_MS = 25_000; // ~25s SSE keep-alive comment

/**
 * Maps live Baileys group metadata onto the public group-info response.
 * Participant ids are canonicalized (LID preferred) and each participant is
 * decorated with the best display name we have stored: the chat name first,
 * then their WhatsApp @username, then their phone digits.
 */
async function toGroupInfo(meta, store) {
  const participants = [];
  for (const p of meta.participants ?? []) {
    const id = canonicalId(p.id, p.lid);
    let name = null;
    if (store && typeof store.resolveChatName === "function") {
      try {
        name = await store.resolveChatName(id);
      } catch {
        name = null;
      }
    }
    // p.phoneNumber is already a JID; for PN participants the id itself is one.
    const phoneSrc = p.phoneNumber ?? (id.endsWith("@s.whatsapp.net") ? id : null);
    participants.push({
      id,
      name,
      username: typeof p.username === "string" && p.username ? p.username : null,
      phone: phoneSrc ? String(phoneSrc).replace(/\D/g, "") || null : null,
      admin: typeof p.admin === "string" && p.admin ? p.admin : null,
    });
  }
  return {
    jid: meta.id ?? null,
    name: typeof meta.subject === "string" && meta.subject.trim() ? meta.subject : null,
    description: typeof meta.desc === "string" && meta.desc.trim() ? meta.desc : null,
    owner: meta.owner ? canonicalId(meta.owner, meta.ownerPn) : null,
    ownerPn: meta.ownerPn ? canonicalId(meta.ownerPn) : null,
    createdAt: Number.isInteger(meta.creation) ? new Date(meta.creation * 1000).toISOString() : null,
    size: Number.isInteger(meta.size) ? meta.size : (meta.participants?.length ?? 0),
    announce: Boolean(meta.announce),
    restrict: Boolean(meta.restrict),
    isCommunity: Boolean(meta.isCommunity),
    ephemeralDuration: Number.isInteger(meta.ephemeralDuration) ? meta.ephemeralDuration : null,
    participants,
  };
}

function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Accepts either a plain base64 string or a fully formed data: URL (as produced
 * by FileReader.readAsDataURL) and returns the decoded bytes.
 */
function decodeMedia(data) {
  let base64 = String(data).trim();
  if (base64.startsWith("data:")) {
    const comma = base64.indexOf(",");
    if (comma === -1) throw new Error("invalid data URL");
    base64 = base64.slice(comma + 1);
  }
  base64 = base64.replace(/\s+/g, "");
  if (!base64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error("media data is not valid base64");
  }
  const buf = Buffer.from(base64, "base64");
  if (!buf.length) throw new Error("media data is empty");
  return buf;
}

const EVENT_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-api-token",
};

/**
 * Tiny HTTP API for the inbox screen, built on node:http so it needs no extra
 * dependencies (this project runs in environments without npm access).
 * Mount it from src/index.js; it stays separate from the WhatsApp wiring.
 *
 * Conversation identity: a conversation's `id` IS its `jid` (both are the same
 * opaque string, e.g. "15551234567@s.whatsapp.net"). Every :jid route param,
 * the inbox/thread response, and every SSE `jid` field uses that same key, so
 * they are interchangeable. Note: the top-level `id` in the send response is the
 * *message* id, not the jid.
 *
 * Endpoints (base URL http://localhost:${API_PORT}.):
 *   GET  /api/inbox?q=...                    -> { conversations: [...] } — lightweight:
 *                                              each conversation carries today's meta
 *                                              (id, jid, name, isGroup, unread, flagged,
 *                                              lastMessageAt, time) plus a single
 *                                              `lastMessage` view — the full message
 *                                              array is gone, so the payload is small
 *                                              enough to cache offline. `q` filters
 *                                              server-side by conversation name or any
 *                                              message text (case-insensitive).
 *   GET  /api/inbox/:jid?limit=&before=     -> thread detail
 *                                              no `limit`: exactly today's response,
 *                                              { conversation } with the whole thread.
 *                                              with `limit` (int, clamped to 1..200):
 *                                              { conversation, hasMore, nextBefore } —
 *                                              `conversation.messages` is the page of
 *                                              the NEWEST messages ascending, `hasMore`
 *                                              says older rows exist, and `nextBefore`
 *                                              is an opaque cursor for the next page
 *                                              (null when done). Malformed `before`
 *                                              returns 400.
 *   POST /api/inbox/:jid/read              -> { ok, jid, unread: 0 }
 *   POST /api/inbox/:jid/flag              -> body { flagged: bool }  -> { ok, jid, flagged }
 *   POST /api/inbox/:jid/send              -> send a text and/or a media message
 *   GET  /api/events                       -> Server-Sent-Events stream of messages
 *   GET  /api/groups/:jid                  -> { group } — live group details:
 *                                              subject, description, owner,
 *                                              creation date, member count,
 *                                              settings (announce/restrict/
 *                                              community/ephemeral) and the
 *                                              participant list (canonical ids
 *                                              + best stored name, @username,
 *                                              phone digits, admin role).
 *                                              Requires the connection open:
 *                                              503 no connection, 409 not open,
 *                                              404 unknown group, 502 failures.
 *   GET  /api/guards                       -> { groups: [...] } — every group where
 *                                              the linked account is an admin (the
 *                                              only configurable ones); each is
 *                                              { jid, name, memberCount, guarded }
 *                                              where `guarded` is true when the
 *                                              link or toxicity guard is on (a
 *                                              saved row with both off counts as
 *                                              unguarded). Requires the connection
 *                                              open: 503 no connection, 409 not
 *                                              open, 502 groups could not be read.
 *   GET  /api/guards/:jid                  -> { settings } — this group's guard
 *                                              settings merged over the server
 *                                              defaults (unguarded groups get the
 *                                              defaults). A token-free store read.
 *   PUT  /api/guards/:jid                  -> full settings replace; body is
 *                                              { linkGuard, toxicityGuard,
 *                                              blockExternal, blockInvites,
 *                                              linkWhitelist, sensitivity,
 *                                              warnTemplate, warnAt, kickAt }
 *                                              -> { ok, settings }. Needs
 *                                              the x-api-token header when
 *                                              configured; 400 on invalid
 *                                              thresholds, sensitivity or
 *                                              whitelist hosts / template tokens.
 *   GET  /api/guards/:jid/log?limit=       -> { entries: [...] } — moderation
 *                                              actions newest first, each
 *                                              { id, jid, user, actorJid, action,
 *                                              reason, detail, time } with `action`
 *                                              one of Deleted | Warned | Kicked;
 *                                              `limit` defaults to 50.
 *   GET  /api/account                      -> { ok, connected, state, user } — the linked
 *                                              WhatsApp account, so the UI can show who is
 *                                              sending. `state` is the live connection state
 *                                              (idle/connecting/qr/open/closed/logged_out/
 *                                              replaced), `connected` is true only when the
 *                                              state is "open", and `user` = { id, name }
 *                                              (the account jid + WhatsApp profile name)
 *                                              once a socket has opened, null otherwise. The
 *                                              QR / pairing code are deliberately NOT exposed.
 *                                              Returns 503 when no connection is configured.
 *   GET  /api/media/:messageId             -> raw stored media bytes
 *   GET  /api/templates                    -> { templates: [...] } — broadcast
 *                                              templates (like saved messages),
 *                                              newest first; each is
 *                                              { id, title, body, fallbackName,
 *                                              media, createdAt }.
 *   GET  /api/templates/:id                -> { template } | 404
 *   POST /api/templates                    -> create; body
 *                                              { title, body?, fallbackName?, media? }
 *                                              -> 201 { ok, template }
 *   PUT  /api/templates/:id                -> update; same body, `media` omitted
 *                                              keeps the saved attachment, null
 *                                              clears it, an object replaces it;
 *                                              omitted `fallbackName` is kept too
 *                                              -> { ok, template } | 404
 *   DELETE /api/templates/:id              -> { ok, id } | 404
 *   GET  /api/contacts?q=                  -> { contacts: [...] } — address book
 *                                              (name + canonical phone), newest first;
 *                                              `q` matches name or phone case-insensitively.
 *   GET  /api/contacts/:id                 -> { contact } | 404
 *   GET  /api/contacts/:id/lists           -> { ok, lists } — the broadcast
 *                                              lists containing this contact,
 *                                              newest first | 404
 *   POST /api/contacts                     -> body { name?, phone }
 *                                              -> 201 { ok, contact } (400 bad phone,
 *                                              409 duplicate number)
 *   PUT  /api/contacts/:id                 -> body { name?, phone } -> { ok, contact }
 *                                              | 404 | 409
 *   DELETE /api/contacts/:id               -> { ok, id } | 404
 *   POST /api/contacts/import              -> body { contacts: [{ name?, phone }] }
 *                                              -> 200 { ok, imported, skipped } | 413
 *                                              (>5000 rows); invalid/duplicate rows are
 *                                              reported in `skipped`
 *                                              [{ phone, reason }].
 *   POST /api/contacts/delete              -> body { ids: [<contact id>, ...] }
 *                                              -> 200 { ok, deleted } — deletes the
 *                                              given contacts and their list
 *                                              memberships in one transaction;
 *                                              unknown ids are ignored and lists are
 *                                              always kept. 400 invalid/empty ids,
 *                                              413 over 5000.
 *   GET  /api/lists                        -> { lists: [...] } — broadcast lists
 *                                              (audiences), newest first, each with a
 *                                              computed `memberCount`.
 *   GET  /api/lists/:id                    -> { list } (adds `contactIds`) | 404
 *   POST /api/lists                        -> body { name, description?, contactIds? }
 *                                              -> 201 { ok, list }
 *   PUT  /api/lists/:id                    -> same body; a `contactIds` array replaces
 *                                              the whole membership -> { ok, list } | 404
 *   DELETE /api/lists/:id                  -> { ok, id } | 404
 *   POST /api/broadcasts/send              -> resolve a template + audience and
 *                                              send (now or scheduled). Body
 *                                              { templateId, listIds,
 *                                              minDelay?, maxDelay?, sendAt?,
 *                                              senderEmail? } -> 200
 *                                              { ok, broadcast } immediately
 *                                              (status "sending" | "scheduled");
 *                                              `senderEmail` is stored for
 *                                              reference. 400 invalid, 401 token,
 *                                              404 template/list, 409 WhatsApp
 *                                              not connected, 413 too many
 *                                              recipients, 502 template media
 *                                              unreadable, 503 no store.
 *   GET  /api/broadcasts                   -> { broadcasts: [...] } newest first
 *   GET  /api/broadcasts/:id               -> { broadcast, recipients } | 404
 *                                              (recipients = per-phone
 *                                              [{ phone, name, status, error,
 *                                              sentAt }])
 *   GET  /api/health                       -> { ok: true }
 *
 * Broadcasts: a broadcast resolves its recipients server-side (union of the
 * selected lists' contacts, deduped by canonical phone) and stores one row per
 * recipient. Sends are sequential with a random whole-second gap in
 * [minDelay, maxDelay] between messages, each persisted like a normal send
 * (so it appears in the recipient's thread with the operator's senderEmail).
 * A sendAt in the future schedules it; a 15s scheduler fires due rows and, on
 * startup, resumes interrupted broadcasts from their still-pending recipients.
 * In a template body, {{full_name}} is the recipient's full name and {{name}}
 * the first word of it; when a contact has no name the template's
 * `fallbackName` is used, then the phone number. Other {{tokens}} are left
 * as-is.
 *
 * Send body:
 *   { text?, email?, media?: { type, data, mimeType?, fileName?, caption? } }
 *   type: "image" | "video" | "audio" | "document"; data is base64 or a data: URL.
 *   At least text or media is required; document requires fileName + mimeType.
 *   Responses: 200 { ok, jid, id, message } | 400 invalid | 401 token | 409 not
 *   connected | 413 media too large | 422 not on WhatsApp | 502 send failed.
 *   `message` mirrors the thread shape ({ id, from: "me", text, time, sender?,
 *   media? }) and is the persisted message a reload will show.
 *
 * Media: outgoing media bytes are persisted to the media store
 * (src/media/store.js, MEDIA_DIR default ./data/media) at send time; incoming
 * media is downloaded and stored the same way. Message rows keep a media ref
 * { key, type, mimeType, fileName } and message views carry
 * `media: { type, mimeType, fileName, url }` (url = /api/media/<key>) when the
 * message is a media one (omitted otherwise). GET /api/media/:messageId serves
 * the bytes with the right Content-Type plus an `inline` Content-Disposition
 * carrying the file name for documents. Note: <img src> / <a href> can't set
 * request headers, so this route stays open like the other reads (localhost);
 * if the GETs get locked down later, accept ?token= here just like /api/events.
 *
 * Templates: a template is created "like a message" — `title` (required,
 * trimmed, max 200 chars) + `body` text (max 4096) and/or one `media`
 * attachment. The media payload follows the send rules exactly (type in
 * image/video/audio/document, base64 or data: URL `data`, document requires
 * fileName + mimeType, 20 MB cap); there is no separate caption field — the
 * template `body` doubles as the caption at broadcast time. Template media
 * bytes are stored via the media store up front (not at send time) and the
 * template's media view is the same { type, mimeType, fileName, url } shape.
 * An optional `fallbackName` (trimmed, max 200) is used by broadcast
 * personalization when a recipient's contact has no name.
 *
 * Contacts & lists: a contact is { id, name, phone, createdAt } with the phone
 * canonicalized to +<digits> (7..15 digits, unique) so the same number can't be
 * added twice. A broadcast list (audience) is
 * { id, name, description, memberCount, createdAt }; its detail adds
 * `contactIds`. Lists and contacts are independent — deleting a contact drops
 * its memberships but keeps the lists, and deleting a list keeps its contacts.
 * `POST /api/contacts/import` inserts the valid rows in one transaction and
 * reports each skipped row as { phone, reason: "invalid number" | "already
 * exists" } (a number repeated within the batch counts as a duplicate).
 * `POST /api/contacts/delete` bulk-removes contacts (and their list
 * memberships) in one transaction and reports how many existed; the lists are
 * always kept. These routes need only the contact store and never require the
 * API token.
 *
 * Events (/api/events): one SSE frame `data: { jid, message: {...} }\n\n` per
 * incoming AND outgoing message, plus a `: ping\n\n` comment heartbeat every
 * ~25s. Pass ?jid=<jid> to filter to a single conversation. When `apiToken` is
 * set, this route (and only this route) accepts the token via a ?token= query
 * param because EventSource cannot set request headers; other callers may keep
 * using the x-api-token header.
 *
 * Security: the send route can be protected with an optional API token. When
 * `apiToken` is set, requests must send the `x-api-token` header with the exact
 * value (compared in constant time). When it's null/empty the route stays open.
 *
 * Responses are CORS-open so a Vite/Next dev server can call them directly.
 *
 * @param {object}  params
 * @param {object}  [params.messageStore]  store exposing listConversations(q?),
 *                  getMessages(jid[, { limit?, before? }]), markRead(jid),
 *                  setFlagged(jid, flag).
 * @param {object}  [params.connection]    WhatsAppConnection-like object with
 *                  getStatus(), sendMessage(to, content, email) and an EventEmitter
 *                  "message" event for the SSE stream. When null, send and
 *                  /api/account return 503.
 * @param {object}  [params.mediaStore]    media store exposing read(key) ->
 *                  { buffer, mimeType, fileName } | null (see src/media/store.js);
 *                  backs GET /api/media/:messageId; also stores template
 *                  attachments at save time.
 * @param {object}  [params.templateStore] store exposing listTemplates(),
 *                  getTemplate(id), saveTemplate({...}), updateTemplate(id, {...}),
 *                  deleteTemplate(id). Defaults to `messageStore` — the backend
 *                  passes the same dual store for both, so most callers only
 *                  need `messageStore`.
 * @param {object}  [params.contactStore]  store exposing listContacts(q?),
 *                  getContact(id), getContactByPhone(phone), createContact({...}),
 *                  updateContact(id, {...}), deleteContact(id), deleteContacts(ids),
 *                  importContacts(rows),
 *                  listLists(), listListsForContact(contactId), getList(id),
 *                  createList({...}), updateList(id, {...}),
 *                  deleteList(id). Defaults to `messageStore`.
 * @param {object}  [params.broadcastStore] store exposing createBroadcast(row),
 *                  getBroadcast(id), listBroadcasts(), updateBroadcast(id, patch),
 *                  listBroadcastRecipients(id),
 *                  markBroadcastRecipient(id, phone, patch),
 *                  claimDueBroadcasts(now), listInterruptedBroadcasts().
 *                  Defaults to `messageStore`.
 * @param {object}  [params.guardStore]    store exposing getGuardSettings(jid),
 *                  saveGuardSettings(jid, settings), listModeration(jid, limit).
 *                  Defaults to `messageStore`.
 * @param {object}  [params.automationStore] store exposing listAutoReplies(),
 *                  getAutoReply(id), createAutoReply({...}),
 *                  updateAutoReply(id, patch), deleteAutoReply(id),
 *                  getAwaySettings(), saveAwaySettings(patch),
 *                  markAwayReply(jid, key), hasAwayReply(jid, key).
 *                  Defaults to `messageStore`.
 * @param {string}  [params.apiToken]      if set, required on every send call
 *                  (x-api-token header) and on /api/events (?token=).
 * @param {number}  [params.maxMediaBytes] decoded media size cap (default 20 MB).
 * @param {number}  [params.eventsHeartbeatMs] SSE heartbeat interval (default 25s).
 * @param {boolean} [params.startScheduler=true] start the scheduled-broadcast
 *                  poller (tests may pass false and drive it manually).
 */
export function createApiServer({
  messageStore = null,
  connection = null,
  mediaStore = null,
  templateStore = null,
  contactStore = null,
  broadcastStore = null,
  guardStore = null,
  automationStore = null,
  apiToken = null,
  maxMediaBytes = DEFAULT_MAX_MEDIA_BYTES,
  eventsHeartbeatMs = EVENT_HEARTBEAT_MS,
  startScheduler = true,
} = {}) {
  // Templates and contacts live in the same dual store as messages, so the
  // backend passes the same object twice; a server built with only
  // `messageStore` also gets them.
  const tStore = templateStore ?? messageStore;
  const cStore = contactStore ?? messageStore;
  const bStore = broadcastStore ?? messageStore;
  const gStore = guardStore ?? messageStore;
  const aStore = automationStore ?? messageStore;
  const JSON_HEADERS = {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers": "content-type, x-api-token",
  };

  function sendJson(res, status, body) {
    res.writeHead(status, JSON_HEADERS);
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf-8");
          resolve(raw ? JSON.parse(raw) : {});
        } catch (err) {
          reject(err);
        }
      });
      req.on("error", reject);
    });
  }

  /** Reads + parses the JSON body; on failure sends 400 and returns undefined. */
  async function readJson(req, res) {
    try {
      return await readBody(req);
    } catch {
      sendJson(res, 400, { error: "invalid JSON body" });
      return undefined;
    }
  }

  /**
   * Resolves a route `:jid` to the canonical chat id when the store knows an
   * alias for it (LID <-> phone number). Old/bookmarked ids, and a frontend
   * cache predating a merge, keep landing on the same thread.
   */
  async function resolveInboxJid(jid) {
    if (messageStore && typeof messageStore.resolveChatJid === "function") {
      try {
        return (await messageStore.resolveChatJid(jid)) ?? jid;
      } catch {
        return jid;
      }
    }
    return jid;
  }

  /**
   * Server-Sent-Events stream. One frame per incoming + outgoing message; the
   * heartbeat keeps proxies from killing the connection.
   */
  function handleEvents(req, res, url) {
    // EventSource can't set request headers, so a configured API_TOKEN is
    // accepted through the token query parameter on this route only.
    if (apiToken && !tokenMatches(url.searchParams.get("token"), apiToken)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    const filterJid = url.searchParams.get("jid") ?? null;

    res.writeHead(200, EVENT_HEADERS);
    res.flushHeaders?.();
    res.write(": connected\n\n");

    const heartbeat = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        // socket is gone; cleanup runs on close
      }
    }, eventsHeartbeatMs);

    const onMessage = (msg) => {
      if (filterJid && msg.chat !== filterJid) return;
      const frame = JSON.stringify({ jid: msg.chat, message: toMessageView(msg, msg.isGroup ?? false) });
      try {
        res.write(`data: ${frame}\n\n`);
      } catch {
        // connection dying; cleanup handles the rest
      }
    };
    connection?.on?.("message", onMessage);

    // Guard moderation actions arrive as their own frame so the Guards screen can
    // prepend a log entry without confusing them with messages.
    const onGuard = (entry) => {
      if (!entry || typeof entry !== "object") return;
      const guardJid = entry.jid;
      if (filterJid && guardJid !== filterJid) return;
      const frame = JSON.stringify({ type: "guard", jid: guardJid, entry });
      try {
        res.write(`data: ${frame}\n\n`);
      } catch {
        // connection dying; cleanup handles the rest
      }
    };
    connection?.on?.("guard", onGuard);

    const cleanup = () => {
      clearInterval(heartbeat);
      connection?.off?.("message", onMessage);
      connection?.off?.("guard", onGuard);
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
  }

  async function handleSend(req, res, jid, body) {
    if (apiToken && !tokenMatches(req.headers["x-api-token"], apiToken)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (!connection) return sendJson(res, 503, { error: "no WhatsApp connection" });
    if (connection.getStatus?.().state !== "open") {
      return sendJson(res, 409, { error: "WhatsApp is not connected" });
    }

    const { text, email, media } = body ?? {};
    const hasText = typeof text === "string" && text.trim().length > 0;
    const hasMedia = Boolean(media && typeof media.data === "string" && media.data.trim().length > 0);
    if (!hasText && !hasMedia) return sendJson(res, 400, { error: "text or media.data is required" });
    if (hasText && text.length > MAX_TEXT_LENGTH) {
      return sendJson(res, 400, { error: `text is too long (max ${MAX_TEXT_LENGTH} characters)` });
    }
    if (email != null && typeof email !== "string") {
      return sendJson(res, 400, { error: "email must be a string" });
    }

    let content = {};
    if (!hasMedia) {
      content.text = text;
    } else {
      const type = media.type;
      if (!MEDIA_TYPES.includes(type)) {
        return sendJson(res, 400, { error: `unsupported media type: ${JSON.stringify(type)}` });
      }
      if (type === "document" && (!media.fileName || !media.mimeType)) {
        return sendJson(res, 400, { error: "document media requires fileName and mimeType" });
      }

      let buf;
      try {
        buf = decodeMedia(media.data);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
      if (buf.length > maxMediaBytes) {
        return sendJson(res, 413, {
          error: `media is too large (max ${Math.round(maxMediaBytes / 1e6)} MB)`,
        });
      }

      const caption = media.caption ?? (type === "image" || type === "video" ? text : undefined);
      if (media.mimeType) content.mimetype = media.mimeType;
      content[type] = buf;
      if (type === "document") content.fileName = media.fileName;
      if ((type === "image" || type === "video") && caption) content.caption = caption;
    }

    try {
      const result = await connection.sendMessage(jid, content, email ?? null);
      const id = result?.key?.id ?? null;
      // Prefer the persisted message the connection wrote (so `time` and `media`
      // match a reload) and fall back for bare/fake connections.
      const message = result?.persisted
        ? toMessageView(result.persisted, result.persisted.isGroup ?? false)
        : { id, from: "me", text: content.text ?? content.caption ?? "", time: new Date().toISOString() };
      return sendJson(res, 200, { ok: true, jid, id, message });
    } catch (err) {
      const msg = String(err?.message ?? "send failed");
      return sendJson(res, /is not on WhatsApp/.test(msg) ? 422 : 502, { error: msg });
    }
  }

  /**
   * Validates a template create/update payload. `body` here is the request
   * body's `body` field (the template text); validated under the same limits as
   * a send's `text`, and a template needs text or media just like a message.
   * `allowTextMediaFree` relaxes that for updates that keep an already-saved
   * attachment (media omitted) — a media-only template may be edited with only
   * its title/body changing.
   */
  function validateTemplateInput(reqBody, { allowTextMediaFree = false } = {}) {
    const { title } = reqBody ?? {};
    if (typeof title !== "string" || !title.trim()) {
      return { error: "title is required" };
    }
    if (title.trim().length > MAX_TITLE_LENGTH) {
      return { error: `title is too long (max ${MAX_TITLE_LENGTH} characters)` };
    }
    const text = typeof reqBody?.body === "string" ? reqBody.body : "";
    if (text.length > MAX_TEXT_LENGTH) {
      return { error: `body is too long (max ${MAX_TEXT_LENGTH} characters)` };
    }
    let fallbackName = "";
    if (reqBody?.fallbackName != null) {
      if (typeof reqBody.fallbackName !== "string") {
        return { error: "fallbackName must be a string" };
      }
      fallbackName = reqBody.fallbackName.trim();
      if (fallbackName.length > MAX_TITLE_LENGTH) {
        return { error: `fallbackName is too long (max ${MAX_TITLE_LENGTH} characters)` };
      }
    }
    const hasMedia =
      reqBody?.media != null && typeof reqBody.media === "object" && !Array.isArray(reqBody.media);
    if (!text.trim() && !hasMedia && !allowTextMediaFree) {
      return { error: "text or media is required" };
    }
    return { title: title.trim(), text, fallbackName };
  }

  /**
   * Validates and persists a template attachment, mirroring the send path's
   * media rules (decodeMedia, MEDIA_TYPES, document fileName+mimeType, size cap).
   * Returns { ref } on success or { status, error } on failure.
   */
  async function persistTemplateMedia(media) {
    const type = media.type;
    if (!MEDIA_TYPES.includes(type)) {
      return { error: `unsupported media type: ${JSON.stringify(type)}` };
    }
    if (type === "document" && (!media.fileName || !media.mimeType)) {
      return { error: "document media requires fileName and mimeType" };
    }
    if (!mediaStore) return { status: 503, error: "no media store configured" };
    let buf;
    try {
      buf = decodeMedia(media.data);
    } catch (err) {
      return { error: err.message };
    }
    if (buf.length > maxMediaBytes) {
      return {
        status: 413,
        error: `media is too large (max ${Math.round(maxMediaBytes / 1e6)} MB)`,
      };
    }
    const saved = await mediaStore.save({
      id: randomUUID(),
      buffer: buf,
      type,
      mimeType: media.mimeType ?? null,
      fileName: media.fileName ?? null,
    });
    if (!saved) return { error: "media could not be stored" };
    return { ref: { key: saved.key, type: saved.type, mimeType: saved.mimeType, fileName: saved.fileName } };
  }

  async function handleTemplateCreate(req, res, reqBody) {
    const parsed = validateTemplateInput(reqBody);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    let media = null;
    if (reqBody?.media != null) {
      const result = await persistTemplateMedia(reqBody.media);
      if (result.error) return sendJson(res, result.status ?? 400, { error: result.error });
      media = result.ref;
    }
    const template = await tStore.saveTemplate({ title: parsed.title, body: parsed.text, media, fallbackName: parsed.fallbackName });
    return sendJson(res, 201, { ok: true, template });
  }

  async function handleTemplateUpdate(req, res, id, reqBody) {
    // Media omitted -> the store keeps the current attachment, so an empty body
    // is allowed (media-only templates keep working); media: null or a media
    // object must carry text or media of their own.
    const keepMedia = reqBody?.media === undefined;
    const parsed = validateTemplateInput(reqBody, { allowTextMediaFree: keepMedia });
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    let media;
    if (keepMedia) {
      media = undefined; // keep existing attachment
    } else if (reqBody.media == null) {
      media = null; // clear the attachment
    } else {
      const result = await persistTemplateMedia(reqBody.media);
      if (result.error) return sendJson(res, result.status ?? 400, { error: result.error });
      media = result.ref;
    }
    const template = await tStore.updateTemplate(id, {
      title: parsed.title,
      body: parsed.text,
      media,
      // Omit fallbackName when the caller didn't send it, so the store keeps
      // the current value (mirrors the `media` keep-on-undefined semantics).
      ...(reqBody?.fallbackName === undefined ? {} : { fallbackName: parsed.fallbackName }),
    });
    if (!template) return sendJson(res, 404, { error: "template not found" });
    return sendJson(res, 200, { ok: true, template });
  }

  /**
   * Validates a contact create/update payload: `phone` is required and must
   * normalize to a canonical +<digits> (7..15 digits); `name` is optional.
   * Returns { name, phone } or { error }.
   */
  function validateContactInput(reqBody) {
    const rawPhone = reqBody?.phone;
    if (rawPhone == null || (typeof rawPhone === "string" && !rawPhone.trim())) {
      return { error: "phone is required" };
    }
    const phone = normalizePhone(rawPhone);
    if (!phone) {
      return { error: `invalid phone number (need ${MIN_PHONE_DIGITS}-${MAX_PHONE_DIGITS} digits)` };
    }
    let name = "";
    if (reqBody?.name != null) {
      if (typeof reqBody.name !== "string") return { error: "name must be a string" };
      name = reqBody.name.trim();
    }
    return { name, phone };
  }

  /**
   * Validates a list create/update payload. `contactIds` is returned as
   * undefined when absent (so updates keep the current membership) or as the
   * given array (which replaces the membership).
   */
  function validateListInput(reqBody) {
    const name = reqBody?.name;
    if (typeof name !== "string" || !name.trim()) return { error: "name is required" };
    if (name.trim().length > MAX_LIST_NAME) {
      return { error: `name is too long (max ${MAX_LIST_NAME} characters)` };
    }
    let description = "";
    if (reqBody?.description != null) {
      if (typeof reqBody.description !== "string") {
        return { error: "description must be a string" };
      }
      if (reqBody.description.length > MAX_LIST_DESCRIPTION) {
        return { error: `description is too long (max ${MAX_LIST_DESCRIPTION} characters)` };
      }
      description = reqBody.description;
    }
    let contactIds;
    if (reqBody?.contactIds !== undefined) {
      if (!Array.isArray(reqBody.contactIds) || reqBody.contactIds.some((id) => typeof id !== "string")) {
        return { error: "contactIds must be an array of strings" };
      }
      contactIds = reqBody.contactIds;
    }
    return { name: name.trim(), description, contactIds };
  }

  async function handleContactCreate(req, res, reqBody) {
    const parsed = validateContactInput(reqBody);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    if (await cStore.getContactByPhone(parsed.phone)) {
      return sendJson(res, 409, { error: "a contact with that number already exists" });
    }
    const contact = await cStore.createContact(parsed);
    return sendJson(res, 201, { ok: true, contact });
  }

  async function handleContactUpdate(req, res, id, reqBody) {
    const parsed = validateContactInput(reqBody);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    const existing = await cStore.getContact(id);
    if (!existing) return sendJson(res, 404, { error: "contact not found" });
    if (parsed.phone !== existing.phone && (await cStore.getContactByPhone(parsed.phone))) {
      return sendJson(res, 409, { error: "a contact with that number already exists" });
    }
    const contact = await cStore.updateContact(id, parsed);
    if (!contact) return sendJson(res, 404, { error: "contact not found" });
    return sendJson(res, 200, { ok: true, contact });
  }

  async function handleContactImport(req, res, reqBody) {
    const rows = reqBody?.contacts;
    if (!Array.isArray(rows)) return sendJson(res, 400, { error: "contacts must be an array" });
    if (rows.length > MAX_IMPORT_CONTACTS) {
      return sendJson(res, 413, {
        error: `too many contacts to import (max ${MAX_IMPORT_CONTACTS})`,
      });
    }
    const result = await cStore.importContacts(rows);
    return sendJson(res, 200, { ok: true, imported: result.imported, skipped: result.skipped });
  }

  /**
   * Validates a bulk contact-delete payload: `ids` must be a non-empty array of
   * strings. Returns { ids } de-duped, or { error }.
   */
  function validateContactIdsInput(reqBody) {
    const ids = reqBody?.ids;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      return { error: "ids must be an array of strings" };
    }
    const unique = [...new Set(ids)];
    if (!unique.length) return { error: "ids must not be empty" };
    return { ids: unique };
  }

  async function handleContactDeleteMany(req, res, reqBody) {
    const parsed = validateContactIdsInput(reqBody);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    if (parsed.ids.length > MAX_IMPORT_CONTACTS) {
      return sendJson(res, 413, {
        error: `too many contacts to delete (max ${MAX_IMPORT_CONTACTS})`,
      });
    }
    const deleted = await cStore.deleteContacts(parsed.ids);
    return sendJson(res, 200, { ok: true, deleted });
  }

  async function handleListCreate(req, res, reqBody) {
    const parsed = validateListInput(reqBody);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    const list = await cStore.createList(parsed);
    return sendJson(res, 201, { ok: true, list });
  }

  async function handleListUpdate(req, res, id, reqBody) {
    const parsed = validateListInput(reqBody);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });
    const list = await cStore.updateList(id, parsed);
    if (!list) return sendJson(res, 404, { error: "list not found" });
    return sendJson(res, 200, { ok: true, list });
  }

  /* ------------------------------- broadcasts ------------------------------ */

  /**
   * Validates POST /api/broadcasts/send. `sendAt` must parse and be strictly in
   * the future (no grace); delays are whole seconds in [0, 3600] with
   * min <= max. Returns the parsed fields or { error }.
   */
  function validateBroadcastInput(reqBody) {
    const rawTemplateId = reqBody?.templateId;
    if (typeof rawTemplateId !== "string" || !rawTemplateId.trim()) {
      return { error: "templateId is required" };
    }
    const templateId = rawTemplateId.trim();

    const rawListIds = reqBody?.listIds;
    if (!Array.isArray(rawListIds) || rawListIds.length === 0) {
      return { error: "listIds must be a non-empty array" };
    }
    if (rawListIds.length > MAX_BROADCAST_LISTS) {
      return { error: `listIds must contain at most ${MAX_BROADCAST_LISTS} ids` };
    }
    if (rawListIds.some((id) => typeof id !== "string" || !id.trim())) {
      return { error: "listIds must be an array of strings" };
    }
    const listIds = [...new Set(rawListIds.map((id) => id.trim()))];

    const minDelay = reqBody?.minDelay ?? DEFAULT_MIN_DELAY;
    const maxDelay = reqBody?.maxDelay ?? DEFAULT_MAX_DELAY;
    if (!Number.isInteger(minDelay) || minDelay < 0 || minDelay > MAX_BROADCAST_DELAY) {
      return { error: `minDelay must be an integer between 0 and ${MAX_BROADCAST_DELAY}` };
    }
    if (!Number.isInteger(maxDelay) || maxDelay < 0 || maxDelay > MAX_BROADCAST_DELAY) {
      return { error: `maxDelay must be an integer between 0 and ${MAX_BROADCAST_DELAY}` };
    }
    if (minDelay > maxDelay) {
      return { error: "minDelay must be less than or equal to maxDelay" };
    }

    let sendAt = null;
    if (reqBody?.sendAt != null) {
      if (typeof reqBody.sendAt !== "string") {
        return { error: "sendAt must be an ISO-8601 string or null" };
      }
      const ts = Date.parse(reqBody.sendAt);
      if (!Number.isFinite(ts)) {
        return { error: "sendAt must be a valid ISO-8601 timestamp" };
      }
      if (ts <= Date.now()) {
        return { error: "sendAt must be in the future" };
      }
      sendAt = new Date(ts).toISOString();
    }

    let senderEmail = null;
    if (reqBody?.senderEmail != null) {
      if (typeof reqBody.senderEmail !== "string") {
        return { error: "senderEmail must be a string" };
      }
      const trimmed = reqBody.senderEmail.trim();
      if (trimmed.length > MAX_SENDER_EMAIL) {
        return { error: `senderEmail is too long (max ${MAX_SENDER_EMAIL} characters)` };
      }
      senderEmail = trimmed || null;
    }

    return { templateId, listIds, minDelay, maxDelay, sendAt, senderEmail };
  }

  /** A random whole number of seconds in [min, max] (inclusive). */
  function randomDelaySeconds(min, max) {
    const lo = Math.min(min, max);
    const hi = Math.max(min, max);
    return Math.floor(Math.random() * (hi - lo + 1)) + lo;
  }

  function delayMs(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.(); // never hold the process open for a broadcast gap
    });
  }

  // Broadcast ids currently being processed by THIS server (guards double-send).
  const activeBroadcasts = new Set();

  /**
   * Sequential broadcast worker. Sends to every `pending` recipient, recording
   * each result and honouring a random [minDelay, maxDelay]-second gap between
   * messages (none before the first or after the last). Safe to re-invoke after
   * a restart: only pending recipients are sent, so already-sent ones are
   * skipped. Re-entry for the same broadcast is ignored.
   */
  async function runBroadcast(broadcast) {
    const id = broadcast.id;
    if (activeBroadcasts.has(id)) return;
    activeBroadcasts.add(id);
    try {
      // Don't burn through recipients while the socket is down: leave them
      // pending and let the scheduler resume once WhatsApp is open again.
      if (connection.getStatus?.().state !== "open") return;

      const template = await tStore.getTemplate(broadcast.templateId);
      if (!template) {
        await bStore.updateBroadcast(id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: "template not found",
        });
        return;
      }
      const loaded = await loadTemplateMedia(template, mediaStore);
      if (loaded.error) {
        await bStore.updateBroadcast(id, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          error: loaded.error,
        });
        return;
      }

      const recipients = await bStore.listBroadcastRecipients(id);
      let sent = recipients.filter((r) => r.status === "sent").length;
      let failed = recipients.filter((r) => r.status === "failed").length;
      const pending = recipients.filter((r) => r.status === "pending");

      for (let i = 0; i < pending.length; i++) {
        const recipient = pending[i];
        try {
          const content = buildTemplateContent(template, loaded.media, recipient);
          const result = await connection.sendMessage(
            recipient.phone,
            content,
            broadcast.senderEmail ?? null
          );
          await bStore.markBroadcastRecipient(id, recipient.phone, {
            status: "sent",
            jid: result?.key?.remoteJid ?? null,
            sentAt: new Date().toISOString(),
          });
          sent++;
        } catch (err) {
          // "is not on WhatsApp" and friends count as a failed recipient, not
          // a fatal error for the whole broadcast.
          await bStore.markBroadcastRecipient(id, recipient.phone, {
            status: "failed",
            error: String(err?.message ?? "send failed"),
          });
          failed++;
        }
        await bStore.updateBroadcast(id, { sent, failed });
        if (i < pending.length - 1) {
          await delayMs(randomDelaySeconds(broadcast.minDelay, broadcast.maxDelay) * 1000);
        }
      }

      const allFailed = recipients.length > 0 && sent === 0 && failed === recipients.length;
      await bStore.updateBroadcast(id, {
        status: allFailed ? "failed" : "done",
        sent,
        failed,
        finishedAt: new Date().toISOString(),
        error: allFailed ? "all recipients failed" : null,
      });
    } finally {
      activeBroadcasts.delete(id);
    }
  }

  let broadcastTimer = null;

  /** True while the WhatsApp socket is open (scheduled/resumed sends wait). */
  function connectionOpen() {
    return connection?.getStatus?.().state === "open";
  }

  /**
   * One scheduler tick: claims scheduled broadcasts whose send_at has arrived
   * and picks up any broadcast still marked "sending" (crash/restart), starting
   * a worker for each not already running. No-ops until the socket is open so a
   * boot-time resume can't fail recipients against a disconnected socket.
   */
  async function runDueBroadcasts(now = new Date().toISOString()) {
    if (!bStore || !connection || !connectionOpen()) return [];
    const due = await bStore.claimDueBroadcasts(now);
    const interrupted = await bStore.listInterruptedBroadcasts();
    const seen = new Set();
    const jobs = [];
    for (const broadcast of [...due, ...interrupted]) {
      if (seen.has(broadcast.id)) continue;
      seen.add(broadcast.id);
      jobs.push(broadcast);
    }
    for (const broadcast of jobs) runBroadcast(broadcast).catch(() => {});
    return jobs;
  }

  /** Resumes broadcasts interrupted by a previous process (pending recipients). */
  async function resumeInterruptedBroadcasts() {
    if (!bStore || !connection || !connectionOpen()) return [];
    const rows = await bStore.listInterruptedBroadcasts();
    for (const broadcast of rows) runBroadcast(broadcast).catch(() => {});
    return rows;
  }

  function startBroadcastScheduler() {
    if (broadcastTimer || !bStore || !connection || !startScheduler) return;
    // Re-arm anything interrupted before this process started, then poll.
    runDueBroadcasts().catch(() => {});
    broadcastTimer = setInterval(() => {
      runDueBroadcasts().catch(() => {});
    }, BROADCAST_POLL_MS);
    broadcastTimer.unref?.();
  }

  function stopBroadcastScheduler() {
    if (broadcastTimer) {
      clearInterval(broadcastTimer);
      broadcastTimer = null;
    }
  }

  /**
   * POST /api/broadcasts/send: resolves the audience server-side, persists the
   * broadcast (+ pending recipients) and returns immediately. Immediate sends
   * run after the response; scheduled ones are picked up by the scheduler.
   */
  async function handleBroadcastSend(req, res, reqBody) {
    if (apiToken && !tokenMatches(req.headers["x-api-token"], apiToken)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (!connection) return sendJson(res, 503, { error: "no WhatsApp connection" });
    if (connection.getStatus?.().state !== "open") {
      return sendJson(res, 409, { error: "WhatsApp is not connected" });
    }
    if (!bStore) return sendJson(res, 503, { error: "no broadcast store configured" });

    const parsed = validateBroadcastInput(reqBody);
    if (parsed.error) return sendJson(res, 400, { error: parsed.error });

    const template = await tStore.getTemplate(parsed.templateId);
    if (!template) return sendJson(res, 404, { error: "template not found" });

    const lists = [];
    for (const id of parsed.listIds) {
      const list = await cStore.getList(id);
      if (!list) return sendJson(res, 404, { error: "list not found", id });
      lists.push(list);
    }

    // Union every selected list's contact ids, then resolve to canonical
    // phones with one contacts call, dropping ids that no longer resolve and
    // deduping by phone (a contact in two lists is messaged once).
    const contactIds = new Set();
    for (const list of lists) {
      for (const contactId of list.contactIds ?? []) contactIds.add(contactId);
    }
    const contacts = await cStore.listContacts();
    const byId = new Map(contacts.map((c) => [c.id, c]));
    const byPhone = new Map();
    for (const contactId of contactIds) {
      const contact = byId.get(contactId);
      if (!contact) continue;
      const phone = normalizePhone(contact.phone);
      if (!phone || byPhone.has(phone)) continue;
      byPhone.set(phone, { phone, name: (contact.name ?? "").trim() });
    }
    const recipients = [...byPhone.values()];
    if (recipients.length > MAX_BROADCAST_RECIPIENTS) {
      return sendJson(res, 413, {
        error: `too many recipients (max ${MAX_BROADCAST_RECIPIENTS})`,
      });
    }

    // Fail before creating anything when the attachment bytes are gone.
    const loaded = await loadTemplateMedia(template, mediaStore);
    if (loaded.error) return sendJson(res, 502, { error: loaded.error });

    const id = randomUUID();
    const now = new Date().toISOString();
    const broadcast = await bStore.createBroadcast({
      id,
      templateId: template.id,
      templateTitle: template.title,
      listIds: parsed.listIds,
      senderEmail: parsed.senderEmail,
      minDelay: parsed.minDelay,
      maxDelay: parsed.maxDelay,
      sendAt: parsed.sendAt,
      status: parsed.sendAt ? "scheduled" : "sending",
      createdAt: now,
      startedAt: parsed.sendAt ? null : now,
      recipients,
    });

    sendJson(res, 200, { ok: true, broadcast });
    if (!parsed.sendAt) runBroadcast(broadcast).catch(() => {});
  }

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, JSON_HEADERS);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    try {
      if (req.method === "GET" && path === "/api/health") {
        return sendJson(res, 200, { ok: true });
      }

      // The event stream only needs the connection, not the message store.
      if (req.method === "GET" && path === "/api/events") {
        return handleEvents(req, res, url);
      }

      // The connected account only needs the connection, not the message store.
      // `user` mirrors connection.user ({ id, name }) once the socket opened;
      // the QR / pairing code are kept server-side.
      if (req.method === "GET" && path === "/api/account") {
        if (!connection) return sendJson(res, 503, { error: "no WhatsApp connection" });
        const status = connection.getStatus?.() ?? {};
        const state = status.state ?? "unknown";
        const user = status.user ?? null;
        return sendJson(res, 200, {
          ok: true,
          connected: state === "open",
          state,
          user: user ? { id: user.id ?? null, name: user.name ?? null } : null,
        });
      }

      // Media bytes live in the media store (not the message store), so this
      // route stays available even when message persistence isn't configured.
      const mediaMatch = path.match(/^\/api\/media\/([^/]+)$/);
      if (req.method === "GET" && mediaMatch) {
        const found = await mediaStore?.read(decodeURIComponent(mediaMatch[1]));
        if (!found) return sendJson(res, 404, { error: "media not found" });
        const headers = {
          "content-type": found.mimeType || "application/octet-stream",
          "content-length": found.buffer.length,
          "cache-control": "private, max-age=31536000, immutable",
          "access-control-allow-origin": "*",
        };
        if (found.fileName) {
          // encodeURIComponent keeps the header valid for non-ASCII names
          headers["content-disposition"] = `inline; filename="${encodeURIComponent(found.fileName)}"`;
        }
        res.writeHead(200, headers);
        return res.end(found.buffer);
      }

      // Templates are message-style broadcast drafts. They only need the
      // template store (the same dual store used for messages) plus the media
      // store when an attachment is supplied, so they're not gated on the
      // message store guard below.
      const templateMatch = path.match(/^\/api\/templates\/([^/]+)$/);
      if (path === "/api/templates" || templateMatch) {
        if (!tStore) {
          return sendJson(res, 503, { error: "no template store configured" });
        }

        if (req.method === "GET" && path === "/api/templates") {
          const templates = await tStore.listTemplates();
          return sendJson(res, 200, { templates });
        }

        if (req.method === "POST" && path === "/api/templates") {
          let body;
          try {
            body = await readBody(req);
          } catch {
            return sendJson(res, 400, { error: "invalid JSON body" });
          }
          return handleTemplateCreate(req, res, body);
        }

        if (templateMatch) {
          const id = decodeURIComponent(templateMatch[1]);
          if (req.method === "GET") {
            const template = await tStore.getTemplate(id);
            if (!template) return sendJson(res, 404, { error: "template not found" });
            return sendJson(res, 200, { template });
          }
          if (req.method === "PUT") {
            let body;
            try {
              body = await readBody(req);
            } catch {
              return sendJson(res, 400, { error: "invalid JSON body" });
            }
            return handleTemplateUpdate(req, res, id, body);
          }
          if (req.method === "DELETE") {
            const removed = await tStore.deleteTemplate(id);
            if (!removed) return sendJson(res, 404, { error: "template not found" });
            return sendJson(res, 200, { ok: true, id });
          }
        }
      }

      // Contacts + broadcast lists (audiences). They only need the contact
      // store (the same dual store used for messages), so — like templates —
      // they're not gated on the message-store guard below.
      const contactDetail = path.match(/^\/api\/contacts\/([^/]+)$/);
      const contactLists = path.match(/^\/api\/contacts\/([^/]+)\/lists$/);
      const listDetail = path.match(/^\/api\/lists\/([^/]+)$/);
      if (path === "/api/contacts" || path === "/api/contacts/import" || path === "/api/contacts/delete" || contactDetail || contactLists || path === "/api/lists" || listDetail) {
        if (!cStore) {
          return sendJson(res, 503, { error: "no contact store configured" });
        }

        if (req.method === "GET" && path === "/api/contacts") {
          const q = url.searchParams.get("q");
          const contacts = await cStore.listContacts(q);
          return sendJson(res, 200, { contacts });
        }

        if (req.method === "POST" && path === "/api/contacts") {
          const body = await readJson(req, res);
          if (body === undefined) return;
          return handleContactCreate(req, res, body);
        }

        if (req.method === "POST" && path === "/api/contacts/import") {
          const body = await readJson(req, res);
          if (body === undefined) return;
          return handleContactImport(req, res, body);
        }

        if (req.method === "POST" && path === "/api/contacts/delete") {
          const body = await readJson(req, res);
          if (body === undefined) return;
          return handleContactDeleteMany(req, res, body);
        }

        if (req.method === "GET" && contactLists) {
          const id = decodeURIComponent(contactLists[1]);
          const contact = await cStore.getContact(id);
          if (!contact) return sendJson(res, 404, { error: "contact not found" });
          const lists = await cStore.listListsForContact(id);
          return sendJson(res, 200, { ok: true, lists });
        }

        if (contactDetail && contactDetail[1] !== "import" && contactDetail[1] !== "delete") {
          const id = decodeURIComponent(contactDetail[1]);
          if (req.method === "GET") {
            const contact = await cStore.getContact(id);
            if (!contact) return sendJson(res, 404, { error: "contact not found" });
            return sendJson(res, 200, { contact });
          }
          if (req.method === "PUT") {
            const body = await readJson(req, res);
            if (body === undefined) return;
            return handleContactUpdate(req, res, id, body);
          }
          if (req.method === "DELETE") {
            const removed = await cStore.deleteContact(id);
            if (!removed) return sendJson(res, 404, { error: "contact not found" });
            return sendJson(res, 200, { ok: true, id });
          }
        }

        if (req.method === "GET" && path === "/api/lists") {
          const lists = await cStore.listLists();
          return sendJson(res, 200, { lists });
        }

        if (req.method === "POST" && path === "/api/lists") {
          const body = await readJson(req, res);
          if (body === undefined) return;
          return handleListCreate(req, res, body);
        }

        if (listDetail) {
          const id = decodeURIComponent(listDetail[1]);
          if (req.method === "GET") {
            const list = await cStore.getList(id);
            if (!list) return sendJson(res, 404, { error: "list not found" });
            return sendJson(res, 200, { list });
          }
          if (req.method === "PUT") {
            const body = await readJson(req, res);
            if (body === undefined) return;
            return handleListUpdate(req, res, id, body);
          }
          if (req.method === "DELETE") {
            const removed = await cStore.deleteList(id);
            if (!removed) return sendJson(res, 404, { error: "list not found" });
            return sendJson(res, 200, { ok: true, id });
          }
        }
      }

      // Broadcasts need the WhatsApp connection, so they follow the send
      // route's token/409/503 rules (not the token-free contacts/lists block).
      const broadcastDetail = path.match(/^\/api\/broadcasts\/([^/]+)$/);
      if (path === "/api/broadcasts/send" || path === "/api/broadcasts" || broadcastDetail) {
        if (!bStore) {
          return sendJson(res, 503, { error: "no broadcast store configured" });
        }

        if (req.method === "POST" && path === "/api/broadcasts/send") {
          const body = await readJson(req, res);
          if (body === undefined) return;
          return handleBroadcastSend(req, res, body);
        }

        if (req.method === "GET" && path === "/api/broadcasts") {
          const broadcasts = await bStore.listBroadcasts();
          return sendJson(res, 200, { broadcasts });
        }

        if (req.method === "GET" && broadcastDetail) {
          const id = decodeURIComponent(broadcastDetail[1]);
          const broadcast = await bStore.getBroadcast(id);
          if (!broadcast) return sendJson(res, 404, { error: "broadcast not found" });
          const recipients = await bStore.listBroadcastRecipients(id);
          return sendJson(res, 200, { broadcast, recipients });
        }
      }

      // Guards (per-group auto-moderation) only need the guard store (the same
      // dual store used for messages) plus, for the group list, the live
      // connection. Writes are gated by the API token like the send route.
      const guardDetail = path.match(/^\/api\/guards\/([^/]+)$/);
      const guardLog = path.match(/^\/api\/guards\/([^/]+)\/log$/);
      if (path === "/api/guards" || guardDetail || guardLog) {
        if (req.method === "PUT" && apiToken && !tokenMatches(req.headers["x-api-token"], apiToken)) {
          return sendJson(res, 401, { error: "unauthorized" });
        }
        if (!gStore) {
          return sendJson(res, 503, { error: "no guard store configured" });
        }

        if (req.method === "GET" && path === "/api/guards") {
          if (!connection) return sendJson(res, 503, { error: "no WhatsApp connection" });
          if (connection.getStatus?.().state !== "open") {
            return sendJson(res, 409, { error: "WhatsApp is not connected" });
          }
          if (typeof connection.listAdminGroups !== "function") {
            return sendJson(res, 502, { error: "groups could not be read" });
          }
          let adminGroups;
          try {
            adminGroups = await connection.listAdminGroups();
          } catch {
            return sendJson(res, 502, { error: "groups could not be read" });
          }
          const groups = [];
          for (const meta of adminGroups ?? []) {
            const saved = await gStore.getGuardSettings(meta.id);
            groups.push({
              jid: meta.id,
              name: typeof meta.subject === "string" && meta.subject.trim() ? meta.subject : null,
              memberCount: Number.isInteger(meta.size) ? meta.size : (meta.participants?.length ?? 0),
              guarded: saved != null && (saved.linkGuard === true || saved.toxicityGuard === true),
            });
          }
          return sendJson(res, 200, { groups });
        }

        if (req.method === "GET" && guardDetail) {
          const jid = await resolveInboxJid(decodeURIComponent(guardDetail[1]));
          const saved = await gStore.getGuardSettings(jid);
          return sendJson(res, 200, { settings: saved ?? { ...DEFAULT_GUARD_SETTINGS } });
        }

        if (req.method === "PUT" && guardDetail) {
          const body = await readJson(req, res);
          if (body === undefined) return;
          const parsed = validateGuardSettings(body ?? {});
          if (parsed.error) return sendJson(res, 400, { error: parsed.error });
          const jid = await resolveInboxJid(decodeURIComponent(guardDetail[1]));
          const settings = await gStore.saveGuardSettings(jid, parsed.settings);
          return sendJson(res, 200, { ok: true, settings });
        }

        if (req.method === "GET" && guardLog) {
          const jid = await resolveInboxJid(decodeURIComponent(guardLog[1]));
          const limitParam = url.searchParams.get("limit");
          let limit = 50;
          if (limitParam != null && limitParam !== "") {
            const parsedLimit = Number(limitParam);
            if (!Number.isInteger(parsedLimit)) {
              return sendJson(res, 400, { error: "limit must be an integer" });
            }
            limit = Math.min(200, Math.max(1, parsedLimit));
          }
          const entries = await gStore.listModeration(jid, limit);
          return sendJson(res, 200, { entries });
        }
      }

      // Automation (auto-replies + away mode) shares the dual store used for
      // messages/templates. Reads are open; writes are gated by the API token.
      const replyDetail = path.match(/^\/api\/automation\/replies\/([^/]+)$/);
      if (path === "/api/automation" || path.startsWith("/api/automation/")) {
        if (
          ["POST", "PUT", "DELETE"].includes(req.method) &&
          apiToken &&
          !tokenMatches(req.headers["x-api-token"], apiToken)
        ) {
          return sendJson(res, 401, { error: "unauthorized" });
        }
        if (!aStore) {
          return sendJson(res, 503, { error: "no automation store configured" });
        }

        // Every reply is a template, so reject ids the template store doesn't
        // know about before writing a rule/setting that could never send.
        const templateExists = async (id) => {
          if (!id) return false;
          if (!tStore || typeof tStore.getTemplate !== "function") return true;
          try {
            return (await tStore.getTemplate(id)) != null;
          } catch {
            return false;
          }
        };

        if (req.method === "GET" && path === "/api/automation/groups") {
          if (!connection) return sendJson(res, 503, { error: "no WhatsApp connection" });
          if (connection.getStatus?.().state !== "open") {
            return sendJson(res, 409, { error: "WhatsApp is not connected" });
          }
          if (typeof connection.listGroups !== "function") {
            return sendJson(res, 502, { error: "groups could not be read" });
          }
          let all;
          try {
            all = await connection.listGroups();
          } catch {
            return sendJson(res, 502, { error: "groups could not be read" });
          }
          const groups = (all ?? []).map((meta) => ({
            jid: meta.id,
            name: typeof meta.subject === "string" && meta.subject.trim() ? meta.subject : null,
            memberCount: Number.isInteger(meta.size) ? meta.size : (meta.participants?.length ?? 0),
          }));
          return sendJson(res, 200, { groups });
        }

        if (req.method === "GET" && path === "/api/automation/replies") {
          const rules = await aStore.listAutoReplies();
          return sendJson(res, 200, { rules });
        }

        if (req.method === "POST" && path === "/api/automation/replies") {
          const body = await readJson(req, res);
          if (body === undefined) return;
          const parsed = validateAutoReply(body ?? {});
          if (parsed.error) return sendJson(res, 400, { error: parsed.error });
          if (!(await templateExists(parsed.rule.templateId))) {
            return sendJson(res, 400, { error: "template not found" });
          }
          const rule = await aStore.createAutoReply(parsed.rule);
          return sendJson(res, 201, { ok: true, rule });
        }

        if (replyDetail) {
          const id = decodeURIComponent(replyDetail[1]);
          if (req.method === "PUT") {
            const body = await readJson(req, res);
            if (body === undefined) return;
            // Merge onto the stored rule so partial updates keep the rest.
            const current = await aStore.getAutoReply(id);
            if (!current) return sendJson(res, 404, { error: "auto-reply not found" });
            const parsed = validateAutoReply({ ...current, ...(body ?? {}) });
            if (parsed.error) return sendJson(res, 400, { error: parsed.error });
            if (!(await templateExists(parsed.rule.templateId))) {
              return sendJson(res, 400, { error: "template not found" });
            }
            const rule = await aStore.updateAutoReply(id, parsed.rule);
            if (!rule) return sendJson(res, 404, { error: "auto-reply not found" });
            return sendJson(res, 200, { ok: true, rule });
          }
          if (req.method === "DELETE") {
            const deleted = await aStore.deleteAutoReply(id);
            if (!deleted) return sendJson(res, 404, { error: "auto-reply not found" });
            return sendJson(res, 200, { ok: true, id });
          }
        }

        if (req.method === "GET" && path === "/api/automation/away") {
          const away = await aStore.getAwaySettings();
          return sendJson(res, 200, { away });
        }

        if (req.method === "PUT" && path === "/api/automation/away") {
          const body = await readJson(req, res);
          if (body === undefined) return;
          const current = await aStore.getAwaySettings();
          const parsed = validateAwaySettings({ ...current, ...(body ?? {}) });
          if (parsed.error) return sendJson(res, 400, { error: parsed.error });
          if (parsed.settings.templateId && !(await templateExists(parsed.settings.templateId))) {
            return sendJson(res, 400, { error: "template not found" });
          }
          const away = await aStore.saveAwaySettings(parsed.settings);
          return sendJson(res, 200, { ok: true, away });
        }

        return sendJson(res, 404, { error: "not found" });
      }

      if (!messageStore) {
        return sendJson(res, 503, { error: "no message store configured" });
      }

      if (req.method === "GET" && path === "/api/inbox") {
        const q = url.searchParams.get("q") ?? null;
        const conversations = await messageStore.listConversations(q);
        return sendJson(res, 200, { conversations });
      }

      const detail = path.match(/^\/api\/inbox\/([^/]+)$/);
      if (req.method === "GET" && detail) {
        const jid = await resolveInboxJid(decodeURIComponent(detail[1]));
        const limitParam = url.searchParams.get("limit");
        const beforeParam = url.searchParams.get("before");

        if (limitParam == null || limitParam === "") {
          // No limit -> exactly today's response: the thread alone, no
          // pagination keys. (A stray `before` without `limit` is ignored.)
          const conversation = await messageStore.getMessages(jid);
          if (!conversation) return sendJson(res, 404, { error: "conversation not found" });
          return sendJson(res, 200, { conversation });
        }

        const parsed = Number(limitParam);
        if (!Number.isInteger(parsed)) {
          return sendJson(res, 400, { error: "limit must be an integer" });
        }
        const limit = Math.min(200, Math.max(1, parsed));

        let before = null;
        if (beforeParam != null && beforeParam !== "") {
          before = decodeCursor(beforeParam);
          if (!before) return sendJson(res, 400, { error: "invalid before cursor" });
        }

        const result = await messageStore.getMessages(jid, { limit, before });
        if (!result) return sendJson(res, 404, { error: "conversation not found" });
        return sendJson(res, 200, {
          conversation: result.conversation,
          hasMore: result.hasMore,
          nextBefore: result.nextBefore,
        });
      }

      const action = path.match(/^\/api\/inbox\/([^/]+)\/(read|flag)$/);
      if (req.method === "POST" && action) {
        const jid = await resolveInboxJid(decodeURIComponent(action[1]));
        if (action[2] === "read") {
          await messageStore.markRead(jid);
          return sendJson(res, 200, { ok: true, jid, unread: 0 });
        }
        const body = await readBody(req);
        const flagged = Boolean(body.flagged);
        await messageStore.setFlagged(jid, flagged);
        return sendJson(res, 200, { ok: true, jid, flagged });
      }

      const sendMatch = path.match(/^\/api\/inbox\/([^/]+)\/send$/);
      if (req.method === "POST" && sendMatch) {
        const jid = await resolveInboxJid(decodeURIComponent(sendMatch[1]));
        let body;
        try {
          body = await readBody(req);
        } catch {
          return sendJson(res, 400, { error: "invalid JSON body" });
        }
        return handleSend(req, res, jid, body);
      }

      // Group info is a live WhatsApp read (token-free GET, same posture as
      // /api/account). It needs the connection open and maps Baileys
      // metadata — including the resolved participant name enrichment — onto
      // the public shape. Refreshing it also re-persists the latest subject.
      const groupMatch = path.match(/^\/api\/groups\/([^/]+)$/);
      if (req.method === "GET" && groupMatch) {
        if (!connection) {
          return sendJson(res, 503, { error: "no WhatsApp connection" });
        }
        if (connection.getStatus?.().state !== "open") {
          return sendJson(res, 409, { error: "WhatsApp is not connected" });
        }
        if (typeof connection.groupMetadata !== "function") {
          return sendJson(res, 502, { error: "group metadata could not be read" });
        }
        const jid = await resolveInboxJid(decodeURIComponent(groupMatch[1]));
        let meta;
        try {
          meta = await connection.groupMetadata(jid);
        } catch (err) {
          // Baileys throws a Boom whose output.statusCode carries the
          // downstream error's code (404 = unknown group, 409 = not open).
          const status = err?.output?.statusCode ?? err?.data?.statusCode;
          if (status === 404) return sendJson(res, 404, { error: "group not found" });
          if (status === 409) return sendJson(res, 409, { error: "WhatsApp is not connected" });
          return sendJson(res, 502, { error: "group metadata could not be read" });
        }
        if (!meta) return sendJson(res, 502, { error: "group metadata could not be read" });
        // Keep the stored subject fresh for the inbox list.
        const subject = typeof meta.subject === "string" ? meta.subject.trim() : "";
        if (subject && meta.id && messageStore && typeof messageStore.setChatName === "function") {
          try {
            await messageStore.setChatName(meta.id, subject);
          } catch {
            // name refresh is best-effort
          }
        }
        return sendJson(res, 200, { group: await toGroupInfo(meta, messageStore) });
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });

  // The scheduled-broadcast poller starts with the server (guarded by the
  // startScheduler option + a configured store/connection). The worker methods
  // are exposed on the server so tests can drive them deterministically.
  server.runDueBroadcasts = (now) => runDueBroadcasts(now);
  server.resumeInterruptedBroadcasts = () => resumeInterruptedBroadcasts();
  server.startBroadcastScheduler = startBroadcastScheduler;
  server.stopBroadcastScheduler = stopBroadcastScheduler;
  server.on("close", stopBroadcastScheduler);
  startBroadcastScheduler();

  return server;
}