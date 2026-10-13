/**
 * Automation engine — auto-replies and away mode.
 *
 * Subscribes to the connection's "message" events (like the guards engine) and
 * answers incoming messages with saved broadcast templates:
 *
 *  - away mode (direct messages only): while `now` falls inside the configured
 *    daily window (evaluated in the setting's time zone), an incoming DM gets
 *    the away template. `oncePerContact` sends it at most once per contact per
 *    window instance. Away mode takes precedence: while it is active,
 *    auto-replies are skipped.
 *  - auto-replies: the first enabled rule (oldest first) whose keyword matches
 *    the message text and whose scope covers the chat (a DM when `dm` is true,
 *    or a group listed in `groups`) gets its template back. Matching is
 *    case-insensitive; `contains` is a substring test, `exact` compares the
 *    whole (trimmed) text.
 *
 * Both paths render through the shared broadcast content helpers, so a
 * template sends identically here and from a broadcast (name substitution,
 * image/video captions, document/audio attachments). A rule or away setting
 * pointing at a deleted template is skipped silently.
 *
 * By default a reply is a WhatsApp **quoted reply** to the message that
 * triggered it (`quote`); turning `quote` off sends the template as a
 * standalone message. The trigger is quoted only when the connection supplied
 * the original message (`message.quoted`); otherwise we fall back to a plain
 * send.
 */

import { evaluateAwayWindow } from "../db/automation.js";
import { buildTemplateContent, loadTemplateMedia } from "../broadcasts/content.js";

/** The phone digits of a 1:1 jid, or "" for group/LID ids (best-effort name fallback). */
function phoneDigits(jid) {
  return String(jid ?? "").endsWith("@s.whatsapp.net") ? String(jid).replace(/\D/g, "") : "";
}

/** Case-insensitive keyword test against a message body. */
export function ruleMatches(rule, text) {
  const needle = String(rule?.keyword ?? "").trim().toLowerCase();
  if (!needle) return false;
  const haystack = String(text ?? "").toLowerCase();
  return rule.match === "exact" ? haystack.trim() === needle : haystack.includes(needle);
}

/** Whether a rule is scoped to this chat. */
export function ruleCovers(rule, chat, isGroup) {
  if (isGroup) return Array.isArray(rule?.groups) && rule.groups.includes(chat);
  return rule?.dm === true;
}

/**
 * Builds the automation engine. Returns `{ stop, handle }` (handle is exposed
 * for tests and manual triggering) or null when there is nothing to wire up.
 */
export function createAutomationEngine({ connection, store, templateStore, mediaStore } = {}) {
  if (!connection || !store) return null;
  const tStore = templateStore ?? store;

  const onMessage = (message) => {
    if (!message || message.fromMe) return;
    handle(message).catch((err) => connection.emit?.("failure", err));
  };
  connection.on?.("message", onMessage);

  async function handle(message) {
    if (!message || message.fromMe) return;
    const chat = message.chat;
    if (!chat) return;
    const isGroup = Boolean(message.isGroup);

    // Away mode: DMs only, and it wins over auto-replies while active.
    if (!isGroup) {
      const handled = await maybeAway(message);
      if (handled) return;
    }

    const text = typeof message.text === "string" ? message.text : "";
    if (!text.trim()) return;

    let rules;
    try {
      rules = await store.listAutoReplies();
    } catch (err) {
      connection.emit?.("failure", err);
      return;
    }
    const rule = rules.find(
      (r) => r.enabled && ruleCovers(r, chat, isGroup) && ruleMatches(r, text)
    );
    if (!rule) return;
    await sendTemplate(rule.templateId, message, { quote: rule.quote !== false });
  }

  /**
   * Handles away mode for a DM. Returns true when the message falls under away
   * mode (whether or not a reply was actually sent), so the caller can skip
   * auto-replies.
   */
  async function maybeAway(message) {
    let away;
    try {
      away = await store.getAwaySettings();
    } catch (err) {
      connection.emit?.("failure", err);
      return false;
    }
    if (!away?.enabled) return false;

    const window = evaluateAwayWindow({
      start: away.start,
      end: away.end,
      timeZone: away.timeZone,
    });
    if (!window.active) return false;

    if (away.oncePerContact) {
      let already;
      try {
        already = await store.hasAwayReply(message.chat, window.key);
      } catch (err) {
        connection.emit?.("failure", err);
        already = false;
      }
      if (already) return true;
    }

    const sent = await sendTemplate(away.templateId, message, { quote: away.quote !== false });
    if (sent && away.oncePerContact) {
      try {
        await store.markAwayReply(message.chat, window.key);
      } catch (err) {
        connection.emit?.("failure", err);
      }
    }
    return true;
  }

  /**
   * Renders `templateId` for this message and sends it. Returns whether a
   * message was sent; a deleted template (or unreadable media) is skipped
   * silently, matching the "no dangling reply" rule. When `quote` is set the
   * send is a quoted reply to the triggering message (if the connection
   * provided it), otherwise a standalone send.
   */
  async function sendTemplate(templateId, message, { quote = false } = {}) {
    if (!templateId) return false;
    let template;
    try {
      template = await tStore.getTemplate(templateId);
    } catch (err) {
      connection.emit?.("failure", err);
      return false;
    }
    if (!template) return false;

    let media;
    try {
      const loaded = await loadTemplateMedia(template, mediaStore);
      if (loaded.error) return false;
      media = loaded.media;
    } catch (err) {
      connection.emit?.("failure", err);
      return false;
    }

    const content = buildTemplateContent(template, media, {
      name: message.name ?? "",
      phone: phoneDigits(message.chat),
    });

    const options = quote && message.quoted ? { quoted: message.quoted } : undefined;
    try {
      await connection.sendMessage(message.chat, content, null, options);
      return true;
    } catch (err) {
      connection.emit?.("failure", err);
      return false;
    }
  }

  return { stop: () => connection.off?.("message", onMessage), handle };
}
