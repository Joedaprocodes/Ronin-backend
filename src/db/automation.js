/**
 * Shared auto-reply / away-mode helpers used by both the SQLite and Postgres
 * stores and by the API's request validation. Keeping the defaults, validation
 * and the row -> view mapping in one place guarantees the two stores stay
 * behaviourally identical.
 *
 * An **auto-reply rule** answers messages that contain (or exactly match) a
 * keyword, using a saved broadcast template as the reply. A rule is scoped to
 * direct messages (`dm`) and/or a set of group jids (`groups`). `quote` makes
 * the reply a WhatsApp quoted reply to the message that triggered it; when
 * false the template is sent as a standalone message.
 *
 * **Away mode** is a single account-wide setting: during a daily window
 * [start, end] (evaluated in `timeZone`) an incoming DM gets the away template
 * back. `oncePerContact` limits that to one reply per contact per window.
 */

/* -------------------------------------------------------------------------- */
/*  Auto-reply rules                                                          */
/* -------------------------------------------------------------------------- */

/** How a rule's keyword is compared to the incoming text. */
export const MATCH_TYPES = ["contains", "exact"];

/** Longest accepted keyword (a rule keyword, not a message). */
export const MAX_KEYWORD_LENGTH = 200;

/** How many groups a single rule may be scoped to. */
export const MAX_RULE_GROUPS = 200;

/** Rule defaults; missing fields fall back to these. */
export const DEFAULT_AUTO_REPLY = {
  keyword: "",
  match: "contains",
  templateId: null,
  enabled: true,
  dm: true,
  quote: true,
  groups: [],
};

/**
 * Validates a POST/PUT body for one auto-reply rule. Returns `{ rule }`
 * (normalized) or `{ error }`. `templateId` is required: the reply content is
 * always a template, shared with broadcasts.
 */
export function validateAutoReply(input = {}) {
  const rule = { ...DEFAULT_AUTO_REPLY };

  if (input.keyword === undefined) return { error: "keyword is required" };
  if (typeof input.keyword !== "string") return { error: "keyword must be a string" };
  const keyword = input.keyword.trim();
  if (!keyword) return { error: "keyword is required" };
  if (keyword.length > MAX_KEYWORD_LENGTH) {
    return { error: `keyword is too long (max ${MAX_KEYWORD_LENGTH} characters)` };
  }
  rule.keyword = keyword;

  if (input.match !== undefined) {
    if (!MATCH_TYPES.includes(input.match)) {
      return { error: `match must be one of ${MATCH_TYPES.join(", ")}` };
    }
    rule.match = input.match;
  }

  if (input.templateId !== undefined) {
    if (input.templateId === null || input.templateId === "") {
      return { error: "templateId is required" };
    }
    if (typeof input.templateId !== "string") {
      return { error: "templateId must be a string" };
    }
    rule.templateId = input.templateId;
  }
  if (!rule.templateId) return { error: "templateId is required" };

  for (const key of ["enabled", "dm", "quote"]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") return { error: `${key} must be a boolean` };
    rule[key] = input[key];
  }

  if (input.groups !== undefined) {
    if (!Array.isArray(input.groups)) return { error: "groups must be an array of group ids" };
    const seen = new Set();
    const groups = [];
    for (const raw of input.groups) {
      if (typeof raw !== "string") return { error: "groups must be an array of group ids" };
      const jid = raw.trim();
      if (!jid || seen.has(jid)) continue;
      seen.add(jid);
      groups.push(jid);
    }
    if (groups.length > MAX_RULE_GROUPS) {
      return { error: `groups may contain at most ${MAX_RULE_GROUPS} entries` };
    }
    rule.groups = groups;
  }

  return { rule };
}

/** Auto-reply view: { id, keyword, match, templateId, enabled, dm, quote, groups, createdAt }. */
export function autoReplyToView(row, groups = []) {
  return {
    id: row.id,
    keyword: row.keyword ?? "",
    match: MATCH_TYPES.includes(row.match_type) ? row.match_type : "contains",
    templateId: row.template_id ?? null,
    enabled: Boolean(row.enabled),
    dm: Boolean(row.dm),
    quote: row.quote === undefined ? DEFAULT_AUTO_REPLY.quote : Boolean(row.quote),
    groups: Array.isArray(groups) ? groups.filter((jid) => typeof jid === "string") : [],
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Away mode                                                                 */
/* -------------------------------------------------------------------------- */

/** Away defaults. An empty `timeZone` means "use the server's zone". */
export const DEFAULT_AWAY_SETTINGS = {
  enabled: false,
  start: "22:00",
  end: "07:00",
  templateId: null,
  oncePerContact: true,
  quote: true,
  timeZone: "",
};

/** Parses "HH:MM" into minutes past midnight (null when invalid). */
export function parseTimeOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Whether a string is a usable IANA time zone (e.g. "Africa/Lagos"). */
export function isValidTimeZone(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock parts of `date` in `timeZone` (hour uses the 0-23 cycle). */
function localParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/** "YYYY-MM-DD" for a local y/m/d, optionally shifted by whole days. */
function localDateKey({ year, month, day }, dayOffset = 0) {
  const shifted = new Date(Date.UTC(year, month - 1, day) - dayOffset * 86_400_000);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Evaluates whether `now` falls inside the daily away window and, when it
 * does, which window instance it belongs to.
 *
 * Returns `{ active, key }`:
 *  - `active`: true while away mode should reply.
 *  - `key`:    the window's start date in `timeZone` ("YYYY-MM-DD"), used to
 *              enforce "once per contact per window". For an overnight window
 *              (start > end) a message after midnight belongs to the window
 *              that started the previous day, so its key rolls back a day.
 *              `null` when inactive or the window is malformed.
 */
export function evaluateAwayWindow({ start, end, timeZone = "", now = new Date() } = {}) {
  const startMin = parseTimeOfDay(start);
  const endMin = parseTimeOfDay(end);
  if (startMin === null || endMin === null || startMin === endMin) {
    return { active: false, key: null };
  }
  const zone = timeZone && isValidTimeZone(timeZone)
    ? timeZone
    : Intl.DateTimeFormat().resolvedOptions().timeZone;

  let parts;
  try {
    parts = localParts(now, zone);
  } catch {
    return { active: false, key: null };
  }
  const nowMin = parts.hour * 60 + parts.minute;

  if (startMin < endMin) {
    // Same-day window, e.g. 09:00 -> 17:00.
    if (nowMin < startMin || nowMin >= endMin) return { active: false, key: null };
    return { active: true, key: localDateKey(parts) };
  }

  // Overnight window, e.g. 22:00 -> 07:00.
  if (nowMin >= startMin) return { active: true, key: localDateKey(parts) };
  if (nowMin < endMin) return { active: true, key: localDateKey(parts, 1) };
  return { active: false, key: null };
}

/**
 * Validates a PUT /api/automation/away body. Missing fields fall back to the
 * defaults, so the route is a full replace with forgiving partials. Returns
 * `{ settings }` (normalized) or `{ error }`. A template is required while
 * away mode is enabled.
 */
export function validateAwaySettings(input = {}) {
  const settings = { ...DEFAULT_AWAY_SETTINGS };

  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") return { error: "enabled must be a boolean" };
    settings.enabled = input.enabled;
  }
  if (input.oncePerContact !== undefined) {
    if (typeof input.oncePerContact !== "boolean") {
      return { error: "oncePerContact must be a boolean" };
    }
    settings.oncePerContact = input.oncePerContact;
  }
  if (input.quote !== undefined) {
    if (typeof input.quote !== "boolean") return { error: "quote must be a boolean" };
    settings.quote = input.quote;
  }

  for (const key of ["start", "end"]) {
    if (input[key] === undefined) continue;
    if (parseTimeOfDay(input[key]) === null) {
      return { error: `${key} must be a time like "22:00"` };
    }
    settings[key] = String(input[key]).trim();
  }
  if (parseTimeOfDay(settings.start) === parseTimeOfDay(settings.end)) {
    return { error: "start and end time can't be the same" };
  }

  if (input.templateId !== undefined) {
    if (input.templateId !== null && typeof input.templateId !== "string") {
      return { error: "templateId must be a string or null" };
    }
    settings.templateId = input.templateId ? input.templateId : null;
  }
  if (settings.enabled && !settings.templateId) {
    return { error: "choose a template before turning on away mode" };
  }

  if (input.timeZone !== undefined) {
    if (typeof input.timeZone !== "string") return { error: "timeZone must be a string" };
    const zone = input.timeZone.trim();
    if (zone && !isValidTimeZone(zone)) return { error: `unknown time zone: ${zone}` };
    settings.timeZone = zone;
  }

  return { settings };
}

/** Away-mode view: { enabled, start, end, templateId, oncePerContact, quote, timeZone, updatedAt }. */
export function awaySettingsToView(row) {
  if (!row) return { ...DEFAULT_AWAY_SETTINGS, updatedAt: null };
  return {
    enabled: Boolean(row.enabled),
    start: row.start_time ?? DEFAULT_AWAY_SETTINGS.start,
    end: row.end_time ?? DEFAULT_AWAY_SETTINGS.end,
    templateId: row.template_id ?? null,
    oncePerContact: Boolean(row.once_per_contact),
    quote: row.quote === undefined ? DEFAULT_AWAY_SETTINGS.quote : Boolean(row.quote),
    timeZone: row.time_zone ?? "",
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}
