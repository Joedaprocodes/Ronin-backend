import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import makeWASocket, {
  Browsers,
  DEF_MEDIA_HOST,
  DisconnectReason,
  downloadMediaMessage,
  getContentType,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { createFileAuth } from "./file-auth.js";
import { MEDIA_TYPES, MESSAGE_KIND_TO_TYPE } from "../media/store.js";
import {
  bareJid,
  canonicalId,
  contactIdentity,
  identityPair,
  isChannelJid,
  isGroupJid,
} from "./identity.js";
import {
  extractQuoted,
  extractText,
  getBaileysVersion,
  GROUP_META_TTL_MS,
  JID_CACHE_TTL_MS,
  MAX_BACKOFF_MS,
  MAX_SEEN_IDS,
  PAIRING_CODE_TTL_MS,
  quotedFromTarget,
} from "./utils.js";

/**
 * Whether `target` (compared as a bare jid) is an admin participant of the
 * given group metadata. Checks the id, LID and phone-number forms so a member
 * is recognised whichever way WhatsApp addressed them.
 */
function participantIsAdminIn(meta, target) {
  if (!meta || !target) return false;
  const want = bareJid(target);
  for (const p of meta.participants ?? []) {
    const admin = typeof p?.admin === "string" && p.admin;
    if (!admin) continue;
    for (const id of [p.id, p.lid, p.phoneNumber]) {
      if (id && bareJid(id) === want) return true;
    }
  }
  if (meta.owner && bareJid(meta.owner) === want) return true;
  if (meta.ownerPn && bareJid(meta.ownerPn) === want) return true;
  return false;
}

/**
 * "Bob" / "Bob and Carol" / "Bob, Carol and Dan" — the member list in a system
 * line.
 */
function joinNames(names) {
  const list = (names ?? []).filter(Boolean);
  if (list.length <= 1) return list[0] ?? "someone";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** A trimmed string, or null when it is empty/not a string. */
function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The unresolvable media host WhatsApp puts on some media protos. */
const PLACEHOLDER_MEDIA_HOST = "a.whatsapp.net";

/**
 * The hostname of a media proto's `url`, or null when it isn't an absolute URL
 * (missing/relative URLs are fine: Baileys falls back to `directPath`).
 */
function mediaHost(url) {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Manages a single WhatsApp (Baileys) session.
 *
 * States: "idle" | "connecting" | "qr" | "open" | "closed" | "logged_out" | "replaced"
 *   ("qr" means: waiting for the phone to link, via QR code or pairing code)
 *
 * Events:
 *  - "state"         (state)            every state change
 *  - "qr"            (qrString)         a new QR is ready to be scanned (QR mode only)
 *  - "pairing_code"  (code)             8-character code to type on the phone (phone-number mode)
 *  - "ready"         ({ id, name })     connected and authenticated
 *  - "message"       (message)          incoming/outgoing message (simplified shape)
 *  - "message:update"(message)          an edit/revoke changed a stored message
 *  - "disconnected"  ({ code })         connection dropped (a reconnect may follow)
 *  - "logged_out"    ()                 the phone unlinked this session
 *  - "failure"       (err)              a (re)start attempt failed; a retry is scheduled
 */
export class WhatsAppConnection extends EventEmitter {
  constructor({
    authDir = "./auth",
    auth = null,
    logLevel = "silent",
    phoneNumber = null,
    messageStore = null,
    mediaStore = null,
  } = {}) {
    super();
    // Where the session is stored: a local folder by default, or pass an auth
    // store such as createPostgresAuth(...) to keep it in a database
    this.auth = auth ?? createFileAuth(authDir);
    this.logger = pino({ level: logLevel });
    // Optional persistence for every message (e.g. createPostgresMessageStore)
    this.messageStore = messageStore;
    // Optional media store (src/media/store.js on disk locally, or the
    // production Supabase bucket from src/media/supabase.js): outgoing media
    // bytes are stored at send time and incoming media is downloaded and
    // stored too. When null, media is neither stored nor served.
    this.mediaStore = mediaStore;
    // Serializes saves so messages hit the store in arrival order
    this.saveChain = Promise.resolve();

    // Digits with country code, no "+" or leading 0. If set, we link with a
    // pairing code instead of a QR code.
    this.phoneNumber = phoneNumber ? String(phoneNumber).replace(/\D/g, "") : null;

    this.sock = null;
    this.state = "idle";
    this.qr = null;
    this.user = null;
    this.pairingCode = null;
    this.pairingCodeAt = 0;
    this.pairingPending = false;

    this.retries = 0;
    this.stopped = false;
    this.starting = false;
    this.reconnectTimer = null;

    // Number -> { jid, at } lookups, so we don't hit WhatsApp on every send
    this.jidCache = new Map();
    // Group jid -> { meta, at }: short-lived cache for guard admin checks
    this.groupMetaCache = new Map();
    // Recently handled message ids, so redeliveries aren't emitted twice
    this.seenIds = new Set();
    // lid|pn pairs already folded onto one canonical chat (avoids repeat work)
    this.canonicalized = new Set();
  }

  /** Snapshot for an API / dashboard later. */
  getStatus() {
    return { state: this.state, qr: this.qr, pairingCode: this.pairingCode, user: this.user };
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit("state", state);
  }

  /* ------------------------------ lifecycle ------------------------------ */

  async start() {
    // Already starting or running: nothing to do
    if (this.starting) return;
    if (this.sock && ["connecting", "qr", "open"].includes(this.state)) return;

    this.starting = true;
    this.stopped = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.pairingPending = false;
    this.pairingCode = null;
    this.pairingCodeAt = 0;
    this.#setState("connecting");

    try {
      // Tear down any previous socket so its timers/handles don't linger
      await this.#disposeSocket();

      // Credentials + keys are persisted in the auth store, so a restart reuses the session
      const { state: authState, saveCreds } = await this.auth.load();
      // Fold the account's own LID and PN forms together (see #learnSelfIdentity),
      // so "message yourself" traffic doesn't split into two conversations.
      // Best-effort and idempotent: creds.me is absent before the first pairing.
      void this.#learnSelfIdentity(authState.creds?.me);
      const { version } = await getBaileysVersion();

      const sock = makeWASocket({
        version,
        auth: {
          creds: authState.creds,
          keys: makeCacheableSignalKeyStore(authState.keys, this.logger),
        },
        logger: this.logger,
        // A canonical browser tuple. WhatsApp's pairing-code `companion_hello`
        // validator rejects custom OS labels (e.g. "Campaign Server") with a
        // 400 bad-request while Baileys still returns a (dead) code — the phone
        // then shows "Couldn't link device". Use the library default instead.
        browser: Browsers.macOS("Chrome"),
        markOnlineOnConnect: false, // don't show "online" every time the server connects
        syncFullHistory: false,
      });
      this.sock = sock;

      sock.ev.on("creds.update", () => {
        // Persisting can fail (e.g. the database is down); surface it, don't crash
        saveCreds().catch((err) => this.emit("failure", err));
      });

      sock.ev.on("connection.update", (update) => {
        if (sock !== this.sock) return; // ignore events from a stale socket
        this.#handleConnectionUpdate(update);
      });

      sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (sock !== this.sock || type !== "notify") return;
        const ownJid = this.sock?.user?.id ?? this.user?.id ?? null;
        for (const msg of messages) {
          const remoteJid = msg.key.remoteJid;
          // Status broadcasts and WhatsApp Channels are not conversations: skip
          // them before anything is downloaded, persisted or emitted, so a
          // channel you follow never turns into an inbox thread.
          if (
            !remoteJid ||
            remoteJid === "status@broadcast" ||
            isChannelJid(remoteJid) ||
            !msg.message
          )
            continue;
          // Revokes/edits arrive as protocol messages. Apply them to the stored
          // row (so the inbox never shows stale content) and skip persisting an
          // empty message for them.
          if (msg.message.protocolMessage) {
            await this.#applyProtocolMessage(msg.key, msg.message.protocolMessage, remoteJid);
            continue;
          }
          // Reactions normally arrive on their own event; if one shows up here
          // anyway, apply it to the reacted-to message rather than storing the
          // emoji as a chat message.
          if (msg.message.reactionMessage) {
            await this.#applyReaction({
              key: msg.message.reactionMessage.key,
              reaction: { text: msg.message.reactionMessage.text, key: msg.key },
            });
            continue;
          }
          if (msg.key.id && !this.#isNewMessage(msg.key.id)) continue; // skip redeliveries

          const isGroup = isGroupJid(remoteJid);
          // One canonical chat id per person: incoming LID traffic is folded
          // onto the same conversation as the phone-number form (and any
          // already-split rows are merged here).
          const chat = isGroup
            ? remoteJid
            : await this.#canonicalChat(remoteJid, msg.key.remoteJidAlt);
          const sender = isGroup
            ? bareJid(canonicalId(msg.key.participant, msg.key.participantAlt))
            : chat;

          const message = {
            id: msg.key.id,
            chat,
            isGroup,
            fromMe: Boolean(msg.key.fromMe),
            sender,
            name: msg.pushName ?? null,
            text: extractText(msg.message),
            // Outgoing messages get their sender email from the send call that
            // persisted them eagerly; a delayed echo adds nothing new.
            senderEmail: null,
            receivedAt: Date.now(),
            // Original Baileys key, so the guards engine can delete the message
            // (sock.sendMessage(chat, { delete: key })).
            rawKey: msg.key,
            // What a quoted reply needs ({ key, message }); consumed by the
            // automation engine and ignored by message views/SSE.
            quotedTarget: { key: msg.key, message: msg.message },
            // Display-only snapshot of the message THIS one replies to (shown as
            // the quote block in the UI); null when it isn't a reply.
            quoted: extractQuoted(msg.message, ownJid),
          };
          // Download & store media bytes first (waited per message so saves and
          // SSE frames stay in arrival order). A failed download yields null
          // media but never drops the message itself.
          message.media = await this.#downloadIncomingMedia(msg);
          this.emit("message", message);

          // Persist every message (incoming and outgoing) in order
          this.#saveMessage(message, msg);
        }
      });

      // Edits and revokes that WhatsApp delivers as message *updates* (rather
      // than as a fresh protocol message): mirror them onto the stored row so a
      // reopened thread shows the current content.
      sock.ev.on("messages.update", async (updates) => {
        if (sock !== this.sock) return;
        for (const item of updates ?? []) {
          const key = item?.key;
          const update = item?.update ?? {};
          if (!key?.id || !key.remoteJid) continue;
          if (key.remoteJid === "status@broadcast" || isChannelJid(key.remoteJid))
            continue;
          if (!("message" in update)) continue; // receipts/status changes carry no message
          const next = update.message;
          if (next?.protocolMessage) {
            await this.#applyProtocolMessage(key, next.protocolMessage, key.remoteJid);
          } else if (next === null) {
            await this.#applyRevoke(key.remoteJid, key.id);
          }
        }
      });

      // Reactions: WhatsApp delivers them on their own event (never through
      // messages.upsert). One reactor keeps at most one reaction per message —
      // a falsy `text` removes it.
      sock.ev.on("messages.reaction", (updates) => {
        if (sock !== this.sock) return;
        for (const item of updates ?? []) {
          this.#applyReaction(item).catch((err) => this.emit("failure", err));
        }
      });

      // Contact sync: the names you saved in WhatsApp, plus lid<->pn pairs.
      // These keep chats named and prevent the same person splitting in two.
      sock.ev.on("contacts.upsert", (contacts) => {
        this.#handleContacts(contacts, true).catch((err) => this.emit("failure", err));
      });
      sock.ev.on("contacts.update", (contacts) => {
        this.#handleContacts(contacts, false).catch((err) => this.emit("failure", err));
      });
      sock.ev.on("lid-mapping.update", (mapping) => {
        this.#handleLidMapping(mapping).catch((err) => this.emit("failure", err));
      });

      // Group subjects keep chats named. groups.update carries partial updates
      // ({ id, subject, ... }, subject present on renames), groups.upsert full
      // metadata — both feed the same handler.
      sock.ev.on("groups.update", (updates) => {
        this.#handleGroupUpdates(updates).catch((err) => this.emit("failure", err));
      });
      sock.ev.on("groups.upsert", (groups) => {
        this.#handleGroupUpdates(groups).catch((err) => this.emit("failure", err));
      });

      // Membership changes (add/remove/leave/promote/demote) become persisted
      // system lines in the thread, e.g. "Alice added Bob" / "You removed Carol".
      sock.ev.on("group-participants.update", (update) => {
        if (sock !== this.sock) return;
        this.#handleParticipantsUpdate(update).catch((err) => this.emit("failure", err));
      });
    } catch (err) {
      // Setup failed before we had a usable socket: stay retryable
      if (!this.sock) this.#setState("closed");
      this.emit("failure", err);
      if (!this.stopped) {
        this.#scheduleReconnect(Math.min(1000 * 2 ** this.retries++, MAX_BACKOFF_MS));
      }
      throw err;
    } finally {
      this.starting = false;
    }
  }

  /** Disconnect without logging out (the session stays linked). */
  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const sock = this.sock;
    if (!sock) {
      this.#setState("closed");
      return;
    }

    // Await the close (end() resolves after the "close" event) so the caller
    // can safely release its own resources next
    try {
      await sock.end(undefined); // emits a "close" -> our handler sets "closed"
    } finally {
      if (this.sock === sock) this.sock = null;
      this.qr = null;
      this.pairingCode = null;
      this.pairingCodeAt = 0;
      this.user = null;
      this.#setState("closed");
    }
  }

  /** Unlink this session from the phone. A fresh QR is produced afterwards. */
  async logout() {
    const sock = this.sock;
    if (!sock) {
      // Nothing connected; just wipe the stored session so the next start is fresh
      await this.auth.clear();
      return;
    }
    // Make sure the "loggedOut" close path clears the session and relinks,
    // even if stop() was called first
    this.stopped = false;
    await sock.logout(); // triggers a "close" with DisconnectReason.loggedOut
  }

  /* --------------------------- connection events -------------------------- */

  #handleConnectionUpdate({ connection, lastDisconnect, qr }) {
    if (qr) {
      this.qr = qr;
      this.#setState("qr");
      if (this.phoneNumber) {
        // Ask for a pairing code once per socket, and again if the previous one
        // expired (WhatsApp rotates the code while we wait)
        const expired = !this.pairingCode || Date.now() - this.pairingCodeAt >= PAIRING_CODE_TTL_MS;
        if (expired) this.#autoPair();
      } else {
        this.emit("qr", qr);
      }
    }

    if (connection === "open") {
      this.qr = null;
      this.pairingCode = null;
      this.pairingCodeAt = 0;
      this.retries = 0;
      this.user = { id: this.sock.user?.id ?? null, name: this.sock.user?.name ?? null };
      this.#setState("open");
      this.emit("ready", this.user);
      // Backfill every group subject we participate in so the inbox lists show
      // real group names straight away. Fire-and-forget: failures are "failure"
      // events but never block messaging.
      void this.#backfillGroupNames();
    }

    if (connection === "close") {
      this.qr = null;
      this.pairingCode = null;
      this.pairingCodeAt = 0;
      this.user = null;
      this.#handleClose(lastDisconnect?.error?.output?.statusCode);
    }
  }

  #handleClose(code) {
    this.emit("disconnected", { code });

    // We closed it on purpose
    if (this.stopped) {
      this.#setState("closed");
      return;
    }

    // The phone removed this linked device: wipe the dead session, then start
    // over so a fresh QR appears
    if (code === DisconnectReason.loggedOut) {
      this.#setState("logged_out");
      this.emit("logged_out");
      this.retries = 0;
      Promise.resolve(this.auth.clear())
        .catch((err) => this.emit("failure", err))
        .finally(() => this.#scheduleReconnect(1000));
      return;
    }

    // Another process took over this session. Reconnecting would just start a
    // tug-of-war, so stop here.
    if (code === DisconnectReason.connectionReplaced) {
      this.#setState("replaced");
      return;
    }

    // Everything else is treated as temporary: reconnect with backoff.
    // restartRequired is normal right after scanning the QR, so retry at once.
    this.#setState("closed");
    const delay =
      code === DisconnectReason.restartRequired
        ? 0
        : Math.min(1000 * 2 ** this.retries++, MAX_BACKOFF_MS);
    this.#scheduleReconnect(delay);
  }

  #scheduleReconnect(delay) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      // start() emits "failure" and schedules the next retry itself on error
      this.start().catch(() => {});
    }, delay);
  }

  /** Ends and detaches the current socket (its events become stale). */
  async #disposeSocket() {
    const sock = this.sock;
    if (!sock) return;
    this.sock = null; // its events are now ignored by the stale-socket guard
    try {
      await sock.end(undefined);
    } catch {
      // already closed / errored
    }
  }

  /* -------------------------------- pairing ------------------------------- */

  #autoPair() {
    if (this.pairingPending) return;
    this.pairingPending = true;
    this.pair(this.phoneNumber)
      .catch((err) => this.emit("failure", err))
      .finally(() => {
        this.pairingPending = false;
      });
  }

  /**
   * Requests an 8-character pairing code for the given phone number (the number
   * of the WhatsApp account you want to link). On the phone: WhatsApp >
   * Linked devices > Link a device > "Link with phone number instead".
   * Calling it again returns a fresh code if the previous one expired.
   */
  async pair(phoneNumber) {
    if (!this.sock || this.state !== "qr") {
      throw new Error(`Not ready to pair (state: ${this.state})`);
    }

    const digits = String(phoneNumber ?? "").replace(/\D/g, "");
    if (digits.length < 8) throw new Error("Invalid phone number");

    const raw = await this.sock.requestPairingCode(digits);
    const code = raw.match(/.{1,4}/g)?.join("-") ?? raw; // e.g. ABCD-EFGH
    this.pairingCode = code;
    this.pairingCodeAt = Date.now();
    this.emit("pairing_code", code);
    return code;
  }

  /* -------------------------------- sending ------------------------------- */

  #requireOpen() {
    const sock = this.sock;
    if (!sock || this.state !== "open") {
      throw new Error("WhatsApp is not connected");
    }
    return sock;
  }

  /**
   * Resolves a phone number (digits with country code, no "+" or leading 0)
   * to a real WhatsApp JID, or throws if the number isn't on WhatsApp.
   * Full JIDs (for example a group id ending in @g.us) are passed through.
   * Pass a captured `sock` to avoid racing a reconnect mid-send.
   */
  async resolveJid(to, sock = null) {
    const s = sock ?? this.#requireOpen();
    if (to.includes("@")) return to;

    const digits = to.replace(/\D/g, "");
    if (!digits) throw new Error("Invalid phone number");

    const cached = this.jidCache.get(digits);
    if (cached && Date.now() - cached.at < JID_CACHE_TTL_MS) return cached.jid;

    const [result] = (await s.onWhatsApp(`${digits}@s.whatsapp.net`)) ?? [];
    if (!result?.exists) throw new Error(`${digits} is not on WhatsApp`);

    this.jidCache.set(digits, { jid: result.jid, at: Date.now() });
    return result.jid;
  }

  /**
   * Sends any Baileys payload (text, media, reply, reaction, ...).
   * Pass an `email` (e.g. the contact's Gmail) and it will be persisted with
   * the outgoing message. `options.quoted` (a WAMessage, or at least
   * `{ key, message }`) turns the send into a quoted reply to that message.
   *
   * The sent message is persisted immediately — WhatsApp's echo of our own
   * message (messages.upsert) is delayed and not a reliable trigger, so waiting
   * for it used to lose sent messages on a quick page reload. The *await* here
   * (and the store's id-dedupe for any later echo) is what makes a send
   * deterministic: by the time this resolves the row is committed.
   *
   * Media bytes (when the content carries a Buffer under `image`/`video`/
   * `audio`/`document`) are stored via this.mediaStore and the persisted
   * message carries the media ref ({ key, type, mimeType, fileName }, plus a
   * `url` for the Supabase bucket), which message views surface as media.url.
   *
   * Resolves with the Baileys send result plus a `persisted` field holding the
   * simplified message that was stored (null if the send returned no id).
   * The persisted message is also emitted as a "message" event so realtime
   * consumers (SSE) see outgoing traffic too.
   */
  async sendMessage(to, content, email = null, options = {}) {
    const sock = this.#requireOpen();
    const jid = await this.resolveJid(to, sock);
    const result = await sock.sendMessage(
      jid,
      content,
      options?.quoted ? { quoted: options.quoted } : undefined
    );

    const id = result?.key?.id;
    if (!id) return { ...result, persisted: null };

    // Store outgoing messages under the recipient's canonical chat id, so a
    // send to the phone-number form lands in the same thread as their LID
    // traffic.
    const chat = await this.#resolveCanonical(jid);
    const media = await this.#persistMedia(id, content);
    const receivedAt = Date.now();
    const persisted = {
      id,
      chat,
      isGroup: chat.endsWith("@g.us"),
      fromMe: true,
      sender: jid,
      name: null,
      text: typeof content.text === "string" ? content.text : (content.caption ?? null),
      senderEmail: email ?? null,
      receivedAt,
      rawKey: { id, remoteJid: jid, fromMe: true },
    };
    // media is the store's { key, type, mimeType, fileName } ref (or null when
    // there is nothing to store, e.g. no mediaStore or oversized bytes).
    persisted.media = media;

    // A quoted reply: snapshot the message we're quoting so the UI renders the
    // same quote block for our own (and automation's) replies.
    if (options?.quoted) {
      persisted.quoted = quotedFromTarget(
        options.quoted,
        this.sock?.user?.id ?? this.user?.id ?? null
      );
    }

    // Mark the id as handled so the delayed echo is skipped, then write the
    // outgoing message now (same shape the upsert handler would build).
    this.#isNewMessage(id);
    if (this.messageStore) await this.#saveMessage(persisted, {
      key: { id, remoteJid: jid, fromMe: true },
      message: content,
    });
    this.emit("message", persisted);
    return { ...result, persisted };
  }

  /* ------------------------------ identities ------------------------------ */

  /**
   * Resolves a 1:1 remoteJid/alt pair to one canonical chat id (LID-preferred).
   * When both halves are known it also asks the store to fold them together —
   * registering the alias and merging any messages already saved under the
   * other form — at most once per pair per process.
   */
  async #canonicalChat(remoteJid, altJid) {
    const pair = identityPair(remoteJid, altJid);
    const canonical = pair.lid ?? pair.pn ?? bareJid(remoteJid);
    const store = this.messageStore;
    if (pair.lid && pair.pn && store && typeof store.canonicalizeChat === "function") {
      const key = `${pair.pn}|${pair.lid}`;
      if (!this.canonicalized.has(key)) {
        this.canonicalized.add(key);
        try {
          await store.canonicalizeChat(pair.pn, pair.lid);
        } catch (err) {
          this.canonicalized.delete(key); // let a later message retry
          this.emit("failure", err);
        }
      }
    }
    return canonical;
  }

  /** Maps any jid to its canonical chat id via the store, or returns it as-is. */
  async #resolveCanonical(jid) {
    const store = this.messageStore;
    if (store && typeof store.resolveChatJid === "function") {
      try {
        return await store.resolveChatJid(jid);
      } catch (err) {
        this.emit("failure", err);
      }
    }
    return jid;
  }

  /**
   * Folds the linked account's own LID and PN forms onto one canonical chat.
   * "Message yourself" traffic arrives under whichever id WhatsApp chooses
   * (often without the alt half), so without this the account's own PN and LID
   * show up as two separate conversations. `me` is Baileys' creds.me entry
   * ({ id, lid, name }); a missing half is a no-op (e.g. before first pairing).
   * The LID wins, matching every other folded contact (see identity.js).
   */
  async #learnSelfIdentity(me) {
    const store = this.messageStore;
    if (!store || typeof store.canonicalizeChat !== "function") return;
    const pair = identityPair(me?.id, me?.lid);
    if (!pair.lid || !pair.pn) return;
    try {
      await store.canonicalizeChat(pair.pn, pair.lid);
    } catch (err) {
      this.emit("failure", err);
    }
  }

  /**
   * Handles WhatsApp's contact sync. `withNames` is true for contacts.upsert
   * (which carries the name you saved + @username); contacts.update only
   * carries the contact's own profile name, so it is used solely to learn
   * lid<->pn pairs.
   */
  async #handleContacts(contacts, withNames) {
    const store = this.messageStore;
    if (!store || typeof store.canonicalizeChat !== "function") return;
    for (const entry of contacts ?? []) {
      if (!entry) continue;
      const pair = contactIdentity(entry);
      if (pair.lid && pair.pn) {
        try {
          await store.canonicalizeChat(pair.pn, pair.lid);
        } catch (err) {
          this.emit("failure", err);
        }
      }
      if (!withNames) continue;
      const canonical = pair.lid ?? pair.pn;
      if (!canonical || typeof store.setChatName !== "function") continue;
      const name = typeof entry.name === "string" ? entry.name : "";
      const username = typeof entry.username === "string" ? entry.username : "";
      if (!name && !username) continue;
      try {
        await store.setChatName(canonical, name, username);
      } catch (err) {
        this.emit("failure", err);
      }
    }
  }

  /** Learns a lid<->pn pair announced by Baileys and folds it together. */
  async #handleLidMapping({ lid, pn } = {}) {
    const store = this.messageStore;
    if (lid && pn && store && typeof store.canonicalizeChat === "function") {
      try {
        await store.canonicalizeChat(pn, lid);
      } catch (err) {
        this.emit("failure", err);
      }
    }
  }

  /**
   * Persists group subjects from Baileys' group events. groups.update carries
   * partial updates ({ id, subject, ... } — subject present on renames) and
   * groups.upsert carries full group metadata; both use `subject`, so they
   * share this handler. Blank subjects are skipped (a group name is never
   * erased by an empty rename event).
   */
  async #handleGroupUpdates(items) {
    const store = this.messageStore;
    if (!store || typeof store.setChatName !== "function") return;
    for (const item of items ?? []) {
      if (!item?.id) continue;
      const name = typeof item.subject === "string" ? item.subject.trim() : "";
      if (!name) continue;
      try {
        await store.setChatName(item.id, name);
      } catch (err) {
        this.emit("failure", err);
      }
    }
  }

  /**
   * On connect, fetches the metadata of every group we participate in and
   * persists each subject into chats.name. Uses the returned map directly
   * (Baileys also emits groups.update for the same data — this just makes the
   * write deterministic). Failures surface as "failure" events but never block
   * messaging.
   */
  async #backfillGroupNames() {
    const sock = this.sock;
    const store = this.messageStore;
    if (!sock || !store || typeof store.setChatName !== "function") return;
    if (typeof sock.groupFetchAllParticipating !== "function") return;
    try {
      const groups = await sock.groupFetchAllParticipating();
      for (const meta of Object.values(groups ?? {})) {
        if (!meta?.id) continue;
        const name = typeof meta.subject === "string" ? meta.subject.trim() : "";
        if (!name) continue;
        try {
          await store.setChatName(meta.id, name);
        } catch (err) {
          this.emit("failure", err);
        }
      }
    } catch (err) {
      this.emit("failure", err);
    }
  }

  /**
   * Maps outgoing Baileys content to the media store and returns the stored
   * ref, or null when the content carries no media / nothing could be stored
   * (no mediaStore, empty buffer, or the payload exceeds the size cap).
   */
  async #persistMedia(id, content = {}) {
    if (!this.mediaStore) return null;
    for (const type of MEDIA_TYPES) {
      const buffer = content[type];
      if (Buffer.isBuffer(buffer)) {
        return this.mediaStore.save({
          id,
          buffer,
          type,
          mimeType: content.mimetype ?? null,
          fileName: content.fileName ?? null,
        });
      }
    }
    return null;
  }

  /**
   * Downloads an incoming message's media bytes (image/video/audio/document/
   * sticker) via Baileys and stores them with this.mediaStore. Never throws: a
   * failed download just yields null media so the message is still emitted and
   * saved.
   */
  async #downloadIncomingMedia(msg) {
    if (!this.mediaStore) return null;
    const kind = getContentType(msg?.message);
    const type = MESSAGE_KIND_TO_TYPE[kind];
    if (!type || !msg?.key?.id) return null;
    const part = msg.message?.[kind] ?? {};
    // WhatsApp stamps some media protos (stickers especially) with the
    // placeholder host "a.whatsapp.net", which doesn't resolve. Baileys prefers
    // a proto's `url` host over its own default, so the fetch dies with
    // ENOTFOUND and the message ends up stored without media. Ignore the
    // placeholder and let the content be fetched from the real CDN instead.
    const host =
      mediaHost(part.url) === PLACEHOLDER_MEDIA_HOST ? DEF_MEDIA_HOST : null;
    try {
      const buffer = await downloadMediaMessage(msg, "buffer", host ? { host } : {}, {
        logger: this.logger,
        reuploadRequest: this.sock?.updateMediaMessage,
      });
      if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
      return this.mediaStore.save({
        id: msg.key.id,
        buffer,
        type,
        mimeType: part.mimetype ?? null,
        fileName: part.fileName ?? null,
      });
    } catch (err) {
      // Surface the failure but keep the message (media stays null)
      this.emit("failure", err);
      return null;
    }
  }

  async sendText(to, text, email = null) {
    return this.sendMessage(to, { text }, email);
  }

  /**
   * Fetches a group's live metadata (subject, description, participants,
   * owner, settings...) through the open socket. Throws "WhatsApp is not
   * connected" when the socket isn't open.
   */
  async groupMetadata(jid) {
    const sock = this.#requireOpen();
    if (typeof sock.groupMetadata !== "function") {
      throw new Error("group metadata is not supported");
    }
    return sock.groupMetadata(jid);
  }

  /**
   * Group metadata with a short TTL cache, so the guards engine's per-message
   * admin checks don't hit WhatsApp every time. The API's group-info route keeps
   * using groupMetadata() directly (it wants a fresh subject).
   */
  async #groupMeta(jid) {
    const cached = this.groupMetaCache.get(jid);
    const at = Date.now();
    if (cached && at - cached.at < GROUP_META_TTL_MS) return cached.meta;
    const meta = await this.groupMetadata(jid);
    this.groupMetaCache.set(jid, { meta, at });
    return meta;
  }

  /** Whether `jid` is an admin (or owner) of the group `chat`. */
  async participantIsAdmin(chat, jid) {
    if (!chat || !jid) return false;
    const meta = await this.#groupMeta(chat);
    return participantIsAdminIn(meta, jid);
  }

  /**
   * Every group the linked account is an admin of, as Baileys metadata entries.
   * Used by GET /api/guards to offer only configurable groups.
   */
  async listAdminGroups() {
    const sock = this.#requireOpen();
    if (typeof sock.groupFetchAllParticipating !== "function") return [];
    const all = await sock.groupFetchAllParticipating();
    const account = this.sock?.user?.id ?? this.user?.id ?? null;
    if (!account) return [];
    const accountId = bareJid(account);
    return Object.values(all ?? {}).filter((meta) => meta?.id && participantIsAdminIn(meta, accountId));
  }

  /**
   * Every group the linked account participates in, as Baileys metadata
   * entries. Used by the automation screen to offer auto-reply scopes; unlike
   * the guards list this is not limited to groups where the account is admin,
   * because sending a reply needs no admin rights.
   */
  async listGroups() {
    const sock = this.#requireOpen();
    if (typeof sock.groupFetchAllParticipating !== "function") return [];
    const all = await sock.groupFetchAllParticipating();
    return Object.values(all ?? {}).filter((meta) => meta?.id);
  }

  /** Deletes a message from a chat via its Baileys key (guards enforcement). */
  async deleteMessage(chat, key) {
    const sock = this.#requireOpen();
    if (!chat || !key?.id) throw new Error("cannot delete without a message key");
    return sock.sendMessage(chat, { delete: key });
  }

  /**
   * Edits a previously sent text message via its Baileys key. WhatsApp only
   * permits this for our own text messages, and only within a short window
   * after sending; the server rejects it otherwise.
   */
  async editMessage(chat, key, text) {
    const sock = this.#requireOpen();
    if (!chat || !key?.id) throw new Error("cannot edit without a message key");
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("cannot edit to an empty message");
    }
    return sock.sendMessage(chat, { text, edit: key });
  }

  /**
   * Adds/removes our own reaction on a stored message. `text` is the emoji (or
   * a falsy value to clear it). The send is written through to the store
   * eagerly so the UI updates without waiting for the echo; returns the raw
   * Baileys result.
   */
  async sendReaction(chat, id, text) {
    const sock = this.#requireOpen();
    if (!chat || !id) throw new Error("cannot react without a message key");
    const store = this.messageStore;
    const raw =
      store && typeof store.getMessageRaw === "function"
        ? await store.getMessageRaw(chat, id)
        : null;
    if (!raw) throw new Error("message not found");
    if (!raw.key?.id) throw new Error("message cannot be reacted to");
    const result = await sock.sendMessage(chat, { react: { text: text || "", key: raw.key } });
    if (store && typeof store.setMessageReaction === "function") {
      const entry = text ? { text, at: Date.now() } : null;
      await store.setMessageReaction(chat, id, "me", entry);
    }
    return result;
  }

  /** Removes members from a group (guards enforcement). Returns the raw result. */
  async removeParticipants(chat, jids) {
    const sock = this.#requireOpen();
    if (typeof sock.groupParticipantsUpdate !== "function") {
      throw new Error("group member updates are not supported");
    }
    const members = (Array.isArray(jids) ? jids : [jids]).filter(Boolean);
    if (!members.length) return [];
    return sock.groupParticipantsUpdate(chat, members, "remove");
  }

  /** Returns false for a message id we've already handled (bounded memory). */
  #isNewMessage(id) {
    if (this.seenIds.has(id)) return false;
    this.seenIds.add(id);
    if (this.seenIds.size > MAX_SEEN_IDS) {
      // Sets keep insertion order, so the first value is the oldest
      this.seenIds.delete(this.seenIds.values().next().value);
    }
    return true;
  }

  /**
   * Persists a message in arrival order if a messageStore is configured.
   * Resolves when THIS save commits (sendMessage awaits it) while the chain
   * swallows failures so one bad write doesn't stall the queue.
   */
  #saveMessage(message, rawMessage) {
    if (!this.messageStore) return null;
    const save = this.saveChain.then(() => this.messageStore.save({ ...message, raw: rawMessage }));
    this.saveChain = save.catch((err) => this.emit("failure", err));
    return save;
  }

  /**
   * Applies a protocol message (a revoke or an edit) to the stored row of the
   * message it targets, then announces the refreshed view. Other protocol types
   * (ephemeral settings, sync notices, …) are ignored.
   */
  async #applyProtocolMessage(key, proto, remoteJid) {
    const target = proto?.key ?? key;
    if (!target?.id) return;
    if (proto?.type === 14 /* MESSAGE_EDIT */) {
      const text = extractText(proto.editedMessage);
      if (text == null) return;
      await this.#applyMessageChange(remoteJid, target.id, { text });
    } else if (proto?.type === 0 /* REVOKE */) {
      await this.#applyRevoke(remoteJid, target.id);
    }
  }

  /** Marks a message deleted (a revoke) in the store and re-announces it. */
  async #applyRevoke(remoteJid, id) {
    if (!id) return;
    await this.#applyMessageChange(remoteJid, id, { deleted: true });
  }

  /**
   * Writes an edit/revoke through to the store and emits the refreshed view as
   * "message:update" — deliberately distinct from "message" so the auto-reply
   * and guards engines only ever see real, new traffic.
   */
  async #applyMessageChange(remoteJid, id, change) {
    const store = this.messageStore;
    if (!store) return;
    const isGroup = isGroupJid(remoteJid);
    let chat = remoteJid;
    if (!isGroup) {
      chat = await this.#canonicalChat(remoteJid).catch(() => bareJid(remoteJid));
    }
    try {
      if (change.deleted && typeof store.markMessageDeleted === "function") {
        await store.markMessageDeleted(chat, id);
      } else if (change.text != null && typeof store.updateMessageText === "function") {
        await store.updateMessageText(chat, id, change.text);
      }
      const view =
        typeof store.getMessage === "function" ? await store.getMessage(chat, id) : null;
      if (view) this.emit("message:update", { ...view, isGroup });
    } catch (err) {
      this.emit("failure", err);
    }
  }

  /**
   * Applies one reaction event — `{ key: reacted-to message, reaction: { text,
   * key: reactor } }` — to the stored row and announces the refreshed view. An
   * empty `reaction.text` removes that reactor's reaction. Reactions for
   * messages we never stored (old history) are ignored.
   */
  async #applyReaction(item) {
    const store = this.messageStore;
    if (!store || typeof store.setMessageReaction !== "function") return;
    const target = item?.key;
    if (
      !target?.id ||
      !target.remoteJid ||
      target.remoteJid === "status@broadcast" ||
      isChannelJid(target.remoteJid)
    )
      return;

    const reactionKey = item?.reaction?.key ?? {};
    const fromMe = Boolean(reactionKey.fromMe);
    const isGroup = isGroupJid(target.remoteJid);
    let chat = target.remoteJid;
    if (!isGroup) {
      chat = await this.#canonicalChat(target.remoteJid).catch(() => bareJid(target.remoteJid));
    }

    const reactor = fromMe
      ? "me"
      : bareJid(reactionKey.participant || reactionKey.remoteJid || chat);
    const text = typeof item?.reaction?.text === "string" ? item.reaction.text : "";

    let entry = null;
    if (text) {
      entry = { text, at: Number(item?.reaction?.senderTimestampMs) || Date.now() };
      if (isGroup && !fromMe) {
        const name = await this.#chatName(reactor);
        if (name) entry.name = name;
      }
    }

    try {
      await store.setMessageReaction(chat, target.id, reactor, entry);
      const view =
        typeof store.getMessage === "function" ? await store.getMessage(chat, target.id) : null;
      if (view) this.emit("message:update", { ...view, isGroup });
    } catch (err) {
      this.emit("failure", err);
    }
  }

  /** The stored display name for a jid, when the store knows one. */
  async #chatName(jid) {
    const store = this.messageStore;
    if (!store || typeof store.resolveChatName !== "function") return null;
    try {
      return (await store.resolveChatName(jid)) || null;
    } catch {
      return null;
    }
  }

  /**
   * Turns a group membership change into a persisted system line:
   * "Alice added Bob", "You removed Carol", "Bob left", "You demoted Dan".
   * Stored as a normal message row carrying `system` metadata (so it paginates
   * and persists with the thread) and announced as "message:update" — never
   * "message" — so the auto-reply/guards engines ignore it.
   */
  async #handleParticipantsUpdate(update) {
    const store = this.messageStore;
    const { id: groupJid, action } = update ?? {};
    if (!store || !isGroupJid(groupJid)) return;
    if (!["add", "remove", "promote", "demote"].includes(action)) return;
    if (!update.author) return;

    const members = (update.participants ?? []).filter(
      (p) => p && (p.id || p.lid || p.phoneNumber)
    );
    if (!members.length) return;

    const labelOf = (jid) => {
      const user = String(jid ?? "").split("@")[0].split(":")[0];
      return user || "someone";
    };
    const nameOf = (p) =>
      nonEmpty(p.notify) ||
      nonEmpty(p.name) ||
      nonEmpty(p.username) ||
      labelOf(p.phoneNumber || p.id || p.lid);

    const ownJid = this.sock?.user?.id ?? this.user?.id ?? null;
    const ownBare = ownJid ? bareJid(ownJid) : null;
    const authorForms = [update.author, update.authorPn]
      .filter(Boolean)
      .map((jid) => bareJid(jid));
    const isAuthor = (p) =>
      [p.id, p.lid, p.phoneNumber]
        .filter(Boolean)
        .some((jid) => authorForms.includes(bareJid(jid)));
    const byMe = Boolean(ownBare) && authorForms.includes(ownBare);

    let actorName = byMe ? "You" : null;
    if (!actorName) {
      const actorParticipant = members.find(isAuthor);
      actorName =
        (actorParticipant ? nameOf(actorParticipant) : null) ||
        (await this.#chatName(bareJid(update.author))) ||
        nonEmpty(update.authorUsername) ||
        labelOf(update.author);
    }

    const memberJids = members.map((p) => bareJid(p.id || p.lid || p.phoneNumber));
    const leftOnOwn = action === "remove" && members.every(isAuthor);
    const list = joinNames(members.map(nameOf));
    let text;
    if (action === "add") text = `${actorName} added ${list}`;
    else if (action === "promote") text = `${actorName} promoted ${list} to admin`;
    else if (action === "demote") text = `${actorName} demoted ${list}`;
    else if (leftOnOwn) text = `${actorName} left`;
    else text = `${actorName} removed ${list}`;

    const message = {
      id: `sys-${Date.now()}-${randomUUID().slice(0, 8)}`,
      chat: groupJid,
      isGroup: true,
      fromMe: false,
      sender: bareJid(update.author),
      name: null,
      text,
      senderEmail: null,
      receivedAt: Date.now(),
      rawKey: null,
      quotedTarget: null,
      quoted: null,
      system: { action, actor: bareJid(update.author), participants: memberJids },
    };

    try {
      await this.#saveMessage(message, null);
      const view =
        typeof store.getMessage === "function" ? await store.getMessage(groupJid, message.id) : null;
      if (view) this.emit("message:update", { ...view, isGroup: true });
    } catch (err) {
      this.emit("failure", err);
    }
  }
}