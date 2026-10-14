/**
 * Shared helpers that turn raw message/chat rows into the "conversation"
 * shape the inbox API returns. The Postgres and SQLite stores both normalize
 * their rows into message views and call groupConversations() here, so the
 * two backends stay byte-for-byte consistent.
 *
 * A message view is:    { id, chat, fromMe, sender, text, tsMs, pushName, media?, quoted?, deleted?, edited?, reactions?, system? }
 *   media  = { type, mimeType, fileName, url } when the message carries one.
 *   quoted = { id, text, media?: { type }, sender? } when it's a reply — the
 *            display snapshot of the message it quotes (bytes are never fetched).
 *   reactions = [{ text, from, sender? }] — one entry per reactor, derived from
 *            the stored { "<reactor>": { text, at, name? } } map.
 *   system  = { action, actor, participants } for group membership lines
 *            ("Alice added Bob"); the row's `text` is the rendered sentence.
 *   (Internally the connection/column holds { key, type, mimeType, fileName };
 *   views derive url = /api/media/<key> from it.)
 * A chat meta is:       { name, isGroup, flagged, readAtMs }
 *
 * unread semantics: messages from "them" whose timestamp is newer than the
 * chat's read_at. This mirrors WhatsApp's inbox badge behaviour and is what
 * the frontend's markAsRead() maps to.
 *
 * Thread pagination: GET /api/inbox/:jid?limit=&before= pages through a
 * conversation with keyset cursors. A cursor is base64url("${timestamp}|${id}")
 * where `timestamp` is the exact ISO timestamp of a message row, so the next
 * page can be fetched strictly below (timestamp, id). encodeCursor/decodeCursor
 * below are shared by both stores.
 */

export function shortJid(jid = "") {
  return jid.replace(/@.*$/, "");
}

/** "2m", "1h", "Yesterday", "3d", "Oct 2" — relative label for the inbox. */
export function relativeTime(value) {
  const ms = typeof value === "number" ? value : new Date(value).getTime();
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d}d`;
  return new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

function resolveConversationName({ jid, isGroup, chatName, latestThem }) {
  if (chatName) return chatName;
  if (isGroup) return "Group";
  return latestThem?.pushName || shortJid(latestThem?.sender) || shortJid(jid);
}

/**
 * Whether a route `:jid` looks like a WhatsApp address (a local part followed
 * by an `@domain`, e.g. `2348052928072@s.whatsapp.net` or `...@g.us`). Used to
 * decide whether a chat with no stored history should 404 or degrade to an
 * empty thread — the latter lets the UI start a brand-new conversation.
 */
export function looksLikeJid(jid) {
  return typeof jid === "string" && /^[^@/]+@[^@/]+$/.test(jid);
}

/**
 * Turns one message into the shape the inbox API and the SSE stream expose:
 *   { id, from: "me"|"them", text, time, sender?, media?, quoted?, deleted?, edited? }
 * Accepts either a store view ({ ..., tsMs, pushName, media: {type,mimeType,
 * fileName,url} }) or the connection's simplified message ({ ..., receivedAt,
 * name, media: {key,type,mimeType,fileName} }) so the send response, the SSE
 * feed and a reloaded thread all produce byte-for-byte the same shape.
 *
 * `deleted`/`edited` are flags only; a deleted message still carries its
 * original text/media/quoted here so an authorized admin can reveal it (the UI
 * hides it behind a tombstone by default).
 */
export function toMessageView(m, isGroup) {
  const view = {
    id: m.id,
    from: m.fromMe ? "me" : "them",
    text: m.text ?? "",
    time: new Date(m.tsMs ?? m.receivedAt ?? 0).toISOString(),
  };
  if (m.deleted) view.deleted = true;
  if (m.edited) view.edited = true;
  if (m.system) view.system = m.system;
  if (m.reactions && typeof m.reactions === "object") {
    const reactions = [];
    for (const [reactor, entry] of Object.entries(m.reactions)) {
      if (!entry?.text) continue;
      const mine = reactor === "me";
      const item = { text: entry.text, from: mine ? "me" : "them" };
      // In groups, name who reacted (the store freezes a display name when it
      // knew one at ingest; otherwise show their number). DMs need no name.
      if (!mine && isGroup) item.sender = entry.name || shortJid(reactor);
      reactions.push(item);
    }
    if (reactions.length) view.reactions = reactions;
  }
  if (m.media?.url || m.media?.key) {
    view.media = {
      type: m.media.type ?? null,
      mimeType: m.media.mimeType ?? null,
      fileName: m.media.fileName ?? null,
      url: m.media.url ?? `/api/media/${m.media.key}`,
    };
  }
  if (m.quoted && (m.quoted.text || m.quoted.media?.type)) {
    // The message this one replies to. `media` is the bucket only (shown as an
    // icon + label); `sender` is named in groups, "You" for our own quotes.
    view.quoted = {
      id: m.quoted.id ?? null,
      text: m.quoted.text ?? "",
    };
    if (m.quoted.media?.type) view.quoted.media = { type: m.quoted.media.type };
    if (isGroup && m.quoted.sender) {
      view.quoted.sender = m.quoted.fromMe ? "You" : shortJid(m.quoted.sender);
    }
  }
  if (isGroup) {
    // Only name senders we actually know (the frontend already renders its own
    // group messages as "You: ..."), and omit the key when unknown.
    const sender = m.pushName ?? m.name ?? (m.sender ? shortJid(m.sender) : undefined);
    if (sender) view.sender = sender;
  }
  return view;
}

/* ------------------------------------------------------------------ */
/*  Keyset cursors for paginated threads                               */
/* ------------------------------------------------------------------ */

const CURSOR_SEP = "|";

/**
 * Encodes one page-boundary message as an opaque cursor.
 * @param {string} timestamp the exact timestamp stored in the message row
 *                 (ISO-8601; kept verbatim so (timestamp, id) comparisons
 *                 round-trip without precision loss).
 * @param {string} id        the message id (the tiebreaker when timestamps
 *                 collide, matching ORDER BY timestamp DESC, id DESC).
 */
export function encodeCursor(timestamp, id) {
  return Buffer.from(`${timestamp}${CURSOR_SEP}${id}`, "utf8").toString("base64url");
}

/**
 * Decodes a `before`/`nextBefore` cursor back into { timestamp, id },
 * or returns null when the cursor is malformed (not base64url, no separator,
 * empty parts, or a timestamp that doesn't parse).
 */
export function decodeCursor(cursor) {
  if (typeof cursor !== "string" || !cursor) return null;
  let raw;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const sep = raw.lastIndexOf(CURSOR_SEP);
  if (sep <= 0 || sep === raw.length - 1) return null;
  const timestamp = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!timestamp || !id || Number.isNaN(new Date(timestamp).getTime())) return null;
  return { timestamp, id };
}

/**
 * The exact stored timestamp of a message row, normalized to the ISO string
 * both stores persist. Cursors are built from this so the `before` page can
 * compare against the stored column value losslessly.
 */
export function cursorTimestamp(row) {
  const ts = row?.timestamp;
  return ts instanceof Date ? ts.toISOString() : String(ts ?? "");
}

/**
 * Builds the conversation meta for a paginated thread. The meta (name, unread,
 * lastMessageAt, time) is derived from the *whole* conversation — not the page —
 * so every page of a thread agrees on them; only `messages` differs. Mirrors
 * the shape groupConversations() produces so pages and full threads match.
 *
 * `messages` are the store's rows/views (normalized by each store); they are
 * mapped to the API message view here so pages carry the same { id, from,
 * text, time, media? } shape as the no-limit thread, the inbox list, SSE
 * frames and send responses.
 */
export function buildThreadConversation({
  jid,
  chatName = null,
  isGroup = false,
  flagged = false,
  unread = 0,
  newest = null, // newest store row (for lastMessageAt / time)
  latestThem = null, // newest incoming store row (for the 1:1 name)
  messages = [],
} = {}) {
  const lastTs = newest?.tsMs ?? 0;
  return {
    id: jid,
    jid,
    name: resolveConversationName({ jid, isGroup, chatName, latestThem }),
    isGroup,
    unread,
    flagged,
    lastMessageAt: new Date(lastTs).toISOString(),
    time: relativeTime(lastTs),
    messages: messages.map((m) => toMessageView(m, isGroup)),
  };
}

/**
 * Groups message views by chat and returns conversations ordered by most
 * recent activity, shaped for the inbox screen:
 *   full:    { id, jid, name, isGroup, unread, flagged, lastMessageAt, time, messages[] }
 *   summary: { id, jid, name, isGroup, unread, flagged, lastMessageAt, time, lastMessage }
 *
 * Options:
 *   summary: true replaces the full `messages` array with the single newest
 *            message view (`lastMessage`) — the lightweight inbox shape meant
 *            to be cached offline.
 *   q:       server-side search; keeps only conversations whose resolved name
 *            or any message text contains the needle (case-insensitive). This
 *            replaces the frontend searching the embedded array.
 */
export function groupConversations(
  { messages = [], chats = new Map() } = {},
  { summary = false, q = null } = {}
) {
  const needle = typeof q === "string" && q.trim() ? q.trim().toLowerCase() : null;

  const byChat = new Map();
  for (const m of messages) {
    let entry = byChat.get(m.chat);
    if (!entry) byChat.set(m.chat, (entry = { messages: [] }));
    entry.messages.push(m);
  }

  const conversations = [];
  for (const [jid, { messages: msgs }] of byChat) {
    msgs.sort((a, b) => a.tsMs - b.tsMs);
    const meta = chats.get(jid) ?? {};
    const readAtMs = meta.readAtMs ?? 0;
    const last = msgs[msgs.length - 1];
    const isGroup = Boolean(meta.isGroup);
    const views = msgs.map((m) => toMessageView(m, isGroup));
    const name = resolveConversationName({
      jid,
      isGroup,
      chatName: meta.name,
      latestThem: [...msgs].reverse().find((m) => !m.fromMe),
    });

    if (needle) {
      const hit =
        (name ?? "").toLowerCase().includes(needle) ||
        views.some((v) => (v.text ?? "").toLowerCase().includes(needle));
      if (!hit) continue;
    }

    conversations.push({
      id: jid,
      jid,
      name,
      isGroup,
      // Group membership lines ("Alice added Bob") are activity, but they must
      // not inflate the unread badge — WhatsApp treats them as notices.
      unread: msgs.filter((m) => !m.fromMe && !m.system && m.tsMs > readAtMs).length,
      flagged: Boolean(meta.flagged),
      lastMessageAt: new Date(last.tsMs).toISOString(),
      time: relativeTime(last.tsMs),
      ...(summary ? { lastMessage: views[views.length - 1] } : { messages: views }),
    });
  }

  conversations.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
  return conversations;
}

/** One conversation (all messages, ascending) or null when nothing exists. */
export function conversationThread({ jid, messages = [], chat = {} } = {}) {
  const list = groupConversations({ messages, chats: new Map([[jid, chat]]) });
  return list[0] ?? null;
}