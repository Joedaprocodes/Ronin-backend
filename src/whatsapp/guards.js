/**
 * Guards engine — per-group auto-moderation.
 *
 * Subscribes to the connection's "message" events and, for each incoming group
 * message, checks two independent pipelines (links first, then language) when
 * the relevant guard is enabled. The engine runs whenever either switch is on:
 *
 *  - links: gated by `linkGuard`. Every URL/domain in the text is reduced to a
 *    bare host; a host is an offense when it isn't whitelisted and is either an
 *    invite domain (chat.whatsapp.com / wa.me while `blockInvites`) or any
 *    external domain (while `blockExternal`).
 *  - language: gated by `toxicityGuard`. The normalized text is matched against
 *    the sensitivity tier's wordlist (see wordlists.js).
 *
 * An offense revokes the message via the connection and bumps the offender's
 * strike count. The resulting count drives the action — `Deleted` below
 * `warnAt`, `Warned` with a rendered template from `warnAt`, `Kicked` at
 * `kickAt` (which resets the strikes). Enforcement only runs for groups where
 * the linked account is an admin, and admin messages are exempt.
 *
 * Every action is appended to the store's moderation log and emitted as a
 * `guard` event on the connection (which the API streams over /api/events).
 */

import {
  DEFAULT_GUARD_SETTINGS,
  normalizeHost,
  renderWarnTemplate,
} from "../db/guards.js";
import { bareJid } from "./identity.js";
import { matchesToxicity, SENSITIVITY_TIERS } from "./wordlists.js";

/**
 * Matches a bare domain anywhere in the text — with or without scheme/www, and
 * with or without a port/path/query/hash. Group 1 is the bare host.
 */
const URL_HOST_RE = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?::\d+)?(?:[/?#][^\s<]*)?/gi;

/** Every distinct bare host appearing in `text` (lowercase, no `www.`). */
export function extractHosts(text) {
  const hosts = [];
  const source = String(text ?? "");
  const re = new RegExp(URL_HOST_RE.source, "gi");
  let match;
  while ((match = re.exec(source)) !== null) {
    const host = match[1] ? match[1].toLowerCase().replace(/^www\./, "") : "";
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * Classifies one bare host against the guard settings. Returns an offense
 * reason ("invite link" | "link") or null when the host is allowed — a
 * whitelisted host always wins, including invite domains.
 */
export function classifyLink(host, settings = {}) {
  const h = String(host ?? "").toLowerCase().replace(/^www\./, "");
  if (!h) return null;
  const whitelist = Array.isArray(settings.linkWhitelist) ? settings.linkWhitelist : [];
  const allowed = whitelist.some((entry) => {
    const e = normalizeHost(entry);
    if (!e) return false;
    return h === e || h.endsWith(`.${e}`);
  });
  if (allowed) return null;
  if (settings.blockInvites && (h === "chat.whatsapp.com" || h === "wa.me")) return "invite link";
  if (settings.blockExternal) return "link";
  return null;
}

/** A display fallback for an unnamed offender: their phone digits. */
function fallbackName(jid) {
  const digits = String(jid ?? "").replace(/\D/g, "");
  return digits || "someone";
}

/** The linked account's own bare jid (used as the moderation actor). */
function ownAccountJid(connection) {
  const id = connection?.user?.id ?? connection?.sock?.user?.id;
  return typeof id === "string" ? bareJid(id) : null;
}

/**
 * Builds the guards engine. Returns `{ stop, moderate }` (moderate is exposed
 * for tests and manual triggering) or null when there is nothing to wire up.
 */
export function createGuardsEngine({ connection, store } = {}) {
  if (!connection || !store) return null;

  const onMessage = (message) => {
    if (!message?.isGroup || message.fromMe) return;
    maybeModerate(message).catch((err) => connection.emit?.("failure", err));
  };
  connection.on?.("message", onMessage);

  async function maybeModerate(message) {
    // Only groups, never our own messages, and only real text.
    if (!message?.isGroup || message.fromMe) return;
    const text = message.text;
    if (typeof text !== "string" || !text.trim()) return;
    const chat = message.chat;
    const sender = bareJid(message.sender);
    if (!chat || !sender) return;
    // The raw Baileys key is required to revoke the message.
    const rawKey = message.rawKey;
    if (!rawKey?.id) return;

    // Saved settings (or defaults). Each pipeline has its own switch; the
    // engine runs when either is on. Both stores already map rows to views; an
    // unconfigured group is the defaults.
    let settings;
    try {
      settings = (await store.getGuardSettings(chat)) ?? { ...DEFAULT_GUARD_SETTINGS };
    } catch (err) {
      connection.emit?.("failure", err);
      return;
    }
    const linkOn = settings.linkGuard === true;
    const toxicOn = settings.toxicityGuard === true;
    if (!linkOn && !toxicOn) return;

    // Only enforce groups where the linked account is an admin; admin
    // messages are exempt. When the connection can't verify, enforce anyway
    // (the engine's own helpers report false for unknown groups).
    const ownJid = ownAccountJid(connection);
    if (ownJid && typeof connection.participantIsAdmin === "function") {
      try {
        if (!(await connection.participantIsAdmin(chat, ownJid))) return;
      } catch {
        return;
      }
      try {
        if (await connection.participantIsAdmin(chat, sender)) return;
      } catch {
        // a failed admin check on the sender must not veto the offense
      }
    }

    // Offense precedence: links first (when the link guard is on), then bad
    // language (when the toxicity guard is on).
    let reason = null;
    let detail = null;
    if (linkOn) {
      for (const host of extractHosts(text)) {
        const offense = classifyLink(host, settings);
        if (offense) {
          reason = offense;
          detail = host;
          break;
        }
      }
    }
    if (!reason && toxicOn) {
      const tier = SENSITIVITY_TIERS[settings.sensitivity] ?? SENSITIVITY_TIERS.medium;
      const hit = matchesToxicity(text, tier);
      if (hit) {
        reason = "bad language";
        detail = hit;
      }
    }
    if (!reason) return;

    // Revoke the offending message first. If WhatsApp can't delete it the
    // offense is silently skipped: no strike, no log, no warning.
    let deleted = false;
    if (typeof connection.deleteMessage === "function") {
      try {
        deleted = await connection.deleteMessage(chat, rawKey);
      } catch {
        deleted = false;
      }
    }
    if (!deleted) return;

    // Record the offense (strikes decay over 7 days) and act on the new count.
    let strikes = 0;
    try {
      strikes = await store.bumpStrike(chat, sender);
    } catch (err) {
      connection.emit?.("failure", err);
    }
    const warnAt = Number.isInteger(settings.warnAt) ? settings.warnAt : 2;
    const kickAt = Number.isInteger(settings.kickAt) ? settings.kickAt : 5;
    const time = new Date().toISOString();

    const logEntry = {
      jid: chat,
      user: message.name?.trim() || sender,
      actorJid: ownJid,
      reason: reason ?? "",
      detail: detail ?? null,
      time,
    };

    if (strikes >= kickAt) {
      let removed = false;
      if (typeof connection.removeParticipants === "function") {
        try {
          await connection.removeParticipants(chat, [sender]);
          removed = true;
        } catch {
          removed = false;
        }
      }
      emitEntry(await writeEntry({ ...logEntry, action: "Kicked" }));
      if (removed) {
        // Start a clean slate after the kick.
        try {
          await store.resetStrikes(chat, sender);
        } catch (err) {
          connection.emit?.("failure", err);
        }
      }
    } else if (strikes >= warnAt) {
      try {
        const mention = sender ? `@${sender.replace(/[^\d]/g, "")}` : "";
        const text = renderWarnTemplate(settings.warnTemplate, {
          name: message.name ?? fallbackName(sender),
          mention,
          strikes,
          kickAt,
          reason: reason ?? "",
        });
        const content = { text };
        if (mention) content.mentions = [sender];
        if (typeof connection.sendMessage === "function") {
          await connection.sendMessage(chat, content, null);
        }
      } catch (err) {
        connection.emit?.("failure", err);
      }
      emitEntry(await writeEntry({ ...logEntry, action: "Warned" }));
    } else {
      emitEntry(await writeEntry({ ...logEntry, action: "Deleted" }));
    }
  }

  /**
   * Persists a moderation entry and returns its stored view (or null on
   * failure). The view is the exact shape `GET /api/guards/:jid/log` returns,
   * so SSE consumers can prepend it verbatim.
   */
  async function writeEntry(entry) {
    try {
      return await store.logModeration(entry);
    } catch (err) {
      connection.emit?.("failure", err);
      return null;
    }
  }

  /** Emits a persisted moderation entry as a `guard` event (the API wraps it). */
  function emitEntry(entry) {
    if (entry) connection.emit?.("guard", entry);
  }

  return { stop: () => connection.off?.("message", onMessage), moderate: maybeModerate };
}