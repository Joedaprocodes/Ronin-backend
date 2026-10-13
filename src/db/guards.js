/**
 * Shared guards / auto-moderation helpers used by both the SQLite and Postgres
 * stores and by the API's request validation. Keeping the defaults, validation
 * and the row -> view mapping in one place guarantees the two stores stay
 * behaviourally identical.
 *
 * A "guard" is configured per group (chat jid) and drives three unrelated
 * checks: a link guard (external URLs + group invites, with a host whitelist),
 * a toxicity filter (low/medium/strict word tiers) and the strike thresholds
 * that turn repeated offenses into warnings and, eventually, a kick.
 */

/** Server-side defaults; `GET /api/guards/:jid` merges saved settings over these. */
export const DEFAULT_GUARD_SETTINGS = {
  linkGuard: false,
  toxicityGuard: false,
  blockExternal: true,
  blockInvites: true,
  linkWhitelist: [],
  sensitivity: "medium",
  warnTemplate: "",
  warnAt: 2,
  kickAt: 5,
};

/** Sensitivity tiers, least to most aggressive. */
export const SENSITIVITY_LEVELS = ["low", "medium", "strict"];

/**
 * A strike is forgotten after this long without a new offence, so a group
 * member's count decays back to zero instead of accumulating forever.
 */
export const STRIKE_DECAY_MS = 7 * 24 * 60 * 60 * 1000;

/** How many hosts a group may whitelist. */
export const MAX_GUARD_WHITELIST = 50;

/** Mirrors MAX_TEXT_LENGTH in src/api/server.js (WhatsApp's text limit). */
export const MAX_WARN_TEMPLATE = 4096;

/** Used when a group leaves `warnTemplate` empty. */
export const DEFAULT_WARN_TEMPLATE =
  "⚠️ {name}, your message was removed ({reason}). Strike {strikes}/{kickAt}.";

/** The only placeholders allowed in a custom warning template. */
export const WARN_TEMPLATE_TOKENS = ["name", "mention", "strikes", "kickAt", "reason"];

/**
 * A bare hostname: at least two dot-separated labels, each alphanumeric with
 * optional inner hyphens. Lowercase only (input is lowercased before testing),
 * so schemes, ports, paths and underscores are all rejected.
 */
const HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

/** Whether a value is a plausible bare lowercase hostname (e.g. "example.com"). */
export function isValidHost(host) {
  return typeof host === "string" && host.length <= 253 && HOST_RE.test(host);
}

/**
 * Reduces pasted input to a bare hostname the same way the frontend does:
 * strips the scheme, userinfo, `www.`, the port and any path/query/hash, then
 * lowercases. Used by the enforcement engine, not by validation (which rejects
 * anything that isn't already bare).
 */
export function normalizeHost(value) {
  let host = String(value ?? "").trim().toLowerCase();
  if (!host) return "";
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme://
  host = host.split(/[/?#]/)[0]; // path / query / hash
  host = host.split("@").pop(); // userinfo@
  host = host.replace(/^www\./, "");
  host = host.replace(/:\d+$/, ""); // :port
  return host;
}

/** The unknown `{token}` names in a warning template (empty when all are valid). */
export function findUnknownTemplateTokens(template) {
  const unknown = [];
  const source = String(template ?? "");
  const re = /\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (!WARN_TEMPLATE_TOKENS.includes(match[1])) unknown.push(match[1]);
  }
  return unknown;
}

/**
 * Renders a warning template, falling back to the default when empty. Unknown
 * tokens are left untouched (the API rejects them on save).
 */
export function renderWarnTemplate(template, context = {}) {
  const source = typeof template === "string" && template.trim() ? template : DEFAULT_WARN_TEMPLATE;
  return source.replace(/\{(\w+)\}/g, (match, token) =>
    Object.prototype.hasOwnProperty.call(context, token) ? String(context[token]) : match
  );
}

/**
 * Validates a PUT /api/guards/:jid payload. Missing fields fall back to the
 * defaults, so the route is a full replace with forgiving partials. Returns
 * `{ settings }` (normalized) or `{ error }`.
 */
export function validateGuardSettings(input = {}) {
  const settings = { ...DEFAULT_GUARD_SETTINGS };

  for (const key of ["linkGuard", "toxicityGuard", "blockExternal", "blockInvites"]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") return { error: `${key} must be a boolean` };
    settings[key] = input[key];
  }

  if (input.sensitivity !== undefined) {
    if (!SENSITIVITY_LEVELS.includes(input.sensitivity)) {
      return { error: `sensitivity must be one of ${SENSITIVITY_LEVELS.join(", ")}` };
    }
    settings.sensitivity = input.sensitivity;
  }

  if (input.warnTemplate !== undefined) {
    if (typeof input.warnTemplate !== "string") {
      return { error: "warnTemplate must be a string" };
    }
    if (input.warnTemplate.length > MAX_WARN_TEMPLATE) {
      return { error: `warnTemplate is too long (max ${MAX_WARN_TEMPLATE} characters)` };
    }
    const unknown = findUnknownTemplateTokens(input.warnTemplate);
    if (unknown.length) {
      return { error: `unknown template token: {${unknown[0]}}` };
    }
    settings.warnTemplate = input.warnTemplate;
  }

  for (const key of ["warnAt", "kickAt"]) {
    if (input[key] === undefined) continue;
    if (!Number.isInteger(input[key]) || input[key] < 1) {
      return { error: `${key} must be a whole number of 1 or more` };
    }
    settings[key] = input[key];
  }
  if (settings.kickAt <= settings.warnAt) {
    return { error: "kickAt must be greater than warnAt" };
  }

  if (input.linkWhitelist !== undefined) {
    if (!Array.isArray(input.linkWhitelist)) {
      return { error: "linkWhitelist must be an array of hostnames" };
    }
    const seen = new Set();
    const hosts = [];
    for (const raw of input.linkWhitelist) {
      if (typeof raw !== "string") {
        return { error: "linkWhitelist must be an array of hostnames" };
      }
      // Incoming links are reduced with `www.` stripped, so a stored "www."
      // prefix would never match — normalize it away before validating.
      const host = raw.trim().toLowerCase().replace(/^www\./, "");
      if (!isValidHost(host)) {
        return { error: `invalid hostname: ${raw}` };
      }
      if (!seen.has(host)) {
        seen.add(host);
        hosts.push(host);
      }
    }
    if (hosts.length > MAX_GUARD_WHITELIST) {
      return { error: `linkWhitelist may contain at most ${MAX_GUARD_WHITELIST} hosts` };
    }
    settings.linkWhitelist = hosts;
  }

  return { settings };
}

/** Parses a whitelist value that may be a JSON string (SQLite) or an array (pg). */
function whitelistToArray(value) {
  const array = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(array)) return [];
  return array.filter((host) => typeof host === "string");
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Settings view: { linkGuard, toxicityGuard, blockExternal, blockInvites, linkWhitelist, sensitivity, warnTemplate, warnAt, kickAt }. */
export function guardSettingsToView(row) {
  return {
    linkGuard: Boolean(row.link_guard),
    toxicityGuard: Boolean(row.toxicity_guard),
    blockExternal: Boolean(row.block_external),
    blockInvites: Boolean(row.block_invites),
    linkWhitelist: whitelistToArray(row.link_whitelist),
    sensitivity: SENSITIVITY_LEVELS.includes(row.sensitivity) ? row.sensitivity : "medium",
    warnTemplate: row.warn_template ?? "",
    warnAt: Number(row.warn_at ?? DEFAULT_GUARD_SETTINGS.warnAt),
    kickAt: Number(row.kick_at ?? DEFAULT_GUARD_SETTINGS.kickAt),
  };
}

/** Moderation view: { id, jid, user, actorJid, action, reason, detail, time }. */
export function moderationEntryToView(row) {
  return {
    id: row.id,
    jid: row.jid,
    user: row.user_name ?? null,
    actorJid: row.actor_jid ?? null,
    action: row.action,
    reason: row.reason ?? "",
    detail: row.detail ?? null,
    time: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}
