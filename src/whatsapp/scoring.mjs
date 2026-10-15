/**
 * RoninClash scoring + question parsing.
 *
 * Shared by the backend game engine (`game.js`) and the API's validation. Kept
 * dependency-free so it can also be unit-tested.
 *
 * Kahoot-style spreadsheet layout (one question per row):
 *
 *   | # | Question | Answer 1 | Answer 2 | Answer 3 | Answer 4 | Time limit (sec) | Correct answer(s) |
 *
 * `Correct answer(s)` accepts letters (A-D), numbers (1-4) or the option text,
 * separated by commas, semicolons, pipes or spaces for multi-answer rows.
 */

/** Longest accepted question text. */
export const MAX_QUESTION_LENGTH = 500;
/** Longest accepted answer option. */
export const MAX_OPTION_LENGTH = 200;

/**
 * Where a player's personal clock starts: the delivery receipt, falling back to
 * the send time. Never trusts a receipt beyond `sentAt + graceMs` (an offline
 * phone that acks an hour later must not inflate a player's elapsed time).
 */
export function questionStartMs(sentAt, deliveredAt, graceMs = 10_000) {
  // A missing send time is unknown; a missing/undelivered receipt means "use
  // the send time". `Number(null) === 0` would otherwise read as epoch 0.
  if (sentAt === null || sentAt === undefined) return null;
  const sent = Number(sentAt);
  if (!Number.isFinite(sent)) return null;
  if (deliveredAt === null || deliveredAt === undefined) return sent;
  const delivered = Number(deliveredAt);
  if (!Number.isFinite(delivered)) return sent;
  return Math.min(delivered, sent + graceMs);
}

/** Canonical header aliases (lowercased, collapsed whitespace). */
const HEADER_ALIASES = {
  "#": "no",
  "no": "no",
  "no.": "no",
  "number": "no",
  "question": "question",
  "answer 1": "a1",
  "answer 2": "a2",
  "answer 3": "a3",
  "answer 4": "a4",
  "answer1": "a1",
  "answer2": "a2",
  "answer3": "a3",
  "answer4": "a4",
  "time limit (sec)": "limit",
  "time limit (secs)": "limit",
  "time limit": "limit",
  "time (sec)": "limit",
  "time limit in seconds": "limit",
  "correct answer(s)": "correct",
  "correct answers": "correct",
  "correct answer": "correct",
  "correct": "correct",
};

/** Normalizes a header cell: underscores/hyphens -> spaces, collapse, lowercase. */
function normalizeHeader(key) {
  return String(key ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when every cell of a row is blank (trailing Excel rows). */
export function isBlankRow(row = {}) {
  return Object.values(row).every(
    (v) => v === null || v === undefined || String(v).trim() === ""
  );
}

/**
 * Maps one raw spreadsheet row (keyed by its header cells) to canonical field
 * names (`no`, `question`, `a1`..`a4`, `limit`, `correct`). Unknown headers are
 * ignored; the first value for a canonical field wins.
 */
export function normalizeRow(row = {}) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const field = HEADER_ALIASES[normalizeHeader(key)];
    if (field && out[field] === undefined) out[field] = value;
  }
  return out;
}

/**
 * "1", "A", "B,C", "1,3", "A and C", "New York" -> sorted unique option
 * indexes (0-3). The whole cell is matched against the option texts first so
 * multi-word options ("New York") resolve; only then is the cell tokenized on
 * commas/semicolons/pipes/"and", falling back to whitespace ("A B", "1 3").
 * Tokens that don't resolve to a valid option are dropped.
 */
export function parseCorrectIndexes(raw, options = []) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const opts = (options ?? []).map((o) => String(o ?? "").trim());

  const matchOption = (value) => {
    const lower = value.trim().toLowerCase();
    if (!lower) return -1;
    return opts.findIndex((o) => o.toLowerCase() === lower);
  };
  const resolve = (token) => {
    const upper = token.toUpperCase();
    if (/^[A-D]$/.test(upper)) return upper.charCodeAt(0) - 65;
    if (/^[1-4]$/.test(token)) return Number(token) - 1;
    return matchOption(token);
  };

  const out = new Set();

  // 1) The whole cell is one option ("New York", "yes/no", ...).
  const whole = matchOption(text);
  if (whole !== -1) out.add(whole);

  if (!out.size) {
    // 2) Explicit separators: every part must resolve whole (letter, number
    //    or exact option text). If any part fails, fall back to splitting the
    //    unresolved parts on whitespace ("A B", "1 3").
    const parts = text
      .split(/[,;/|]|\band\b/i)
      .map((p) => p.trim())
      .filter(Boolean);
    const resolved = parts.map(resolve);
    if (resolved.every((r) => r !== -1)) {
      for (const r of resolved) out.add(r);
    } else {
      for (const [i, part] of parts.entries()) {
        if (resolved[i] !== -1) {
          out.add(resolved[i]);
          continue;
        }
        for (const token of part.split(/\s+/)) {
          const idx = resolve(token);
          if (idx !== -1) out.add(idx);
        }
      }
    }
  }

  // Drop anything pointing past the provided options, then dedupe + sort.
  return [...out].filter((i) => i >= 0 && i < opts.length).sort((a, b) => a - b);
}

/**
 * Parses Kahoot-style rows into normalized questions.
 *
 * @param {Array<Record<string, unknown>>} rows header-keyed raw rows
 * @param {{ defaultTimeLimit?: number }} [options]
 * @returns {{ questions: Array, errors: Array<{ row: number, message: string }> }}
 *   `row` is 1-based over the data rows (header excluded). Bad rows are skipped;
 *   good rows survive so the UI can show every error at once.
 */
export function parseQuestions(rows, { defaultTimeLimit = 20 } = {}) {
  const fallbackLimit =
    Number.isFinite(Number(defaultTimeLimit)) && Number(defaultTimeLimit) > 0
      ? Math.round(Number(defaultTimeLimit))
      : 20;

  const questions = [];
  const errors = [];
  const list = Array.isArray(rows) ? rows : [];

  list.forEach((raw, i) => {
    const rowNumber = i + 1;
    if (isBlankRow(raw ?? {})) return;

    const row = normalizeRow(raw);

    const question = String(row.question ?? "").trim();
    if (!question) {
      errors.push({ row: rowNumber, message: "Question text is required" });
      return;
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      errors.push({ row: rowNumber, message: `Question is longer than ${MAX_QUESTION_LENGTH} characters` });
      return;
    }

    const options = [];
    for (const value of [row.a1, row.a2, row.a3, row.a4]) {
      const text = String(value ?? "").trim();
      if (!text) break; // options must be contiguous from Answer 1
      if (text.length > MAX_OPTION_LENGTH) {
        errors.push({ row: rowNumber, message: "An answer option is too long" });
        return;
      }
      options.push(text);
    }
    if (options.length < 2) {
      errors.push({ row: rowNumber, message: "At least 2 answer options are required" });
      return;
    }

    const correct = parseCorrectIndexes(row.correct, options);
    if (!correct.length) {
      errors.push({ row: rowNumber, message: "Mark at least one correct answer" });
      return;
    }

    const rawLimit = Number(row.limit);
    const timeLimit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.round(rawLimit) : fallbackLimit;
    if (timeLimit < 1 || timeLimit > 3600) {
      errors.push({ row: rowNumber, message: "Time limit must be between 1 and 3600 seconds" });
      return;
    }

    questions.push({
      index: questions.length,
      number: Number(row.no) || questions.length + 1,
      question,
      options,
      correct,
      timeLimit,
      multi: correct.length > 1,
    });
  });

  return { questions, errors };
}

/** Exact-set correctness: the selected option indexes must match the key exactly. */
export function isCorrect(selected, correct) {
  const a = [...new Set((selected ?? []).map(Number))].sort((x, y) => x - y);
  const b = [...new Set((correct ?? []).map(Number))].sort((x, y) => x - y);
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * Points for a correct answer at `seconds` on a `limit`-second question:
 *   round(1000 * (1 - (seconds / limit) / 2))
 * -> ~1000 instantly, ~500 exactly at the deadline, 0 for late/wrong.
 */
export function calcScore(seconds, limit) {
  const limitSeconds = Number(limit);
  const elapsed = Number(seconds);
  if (!Number.isFinite(limitSeconds) || limitSeconds <= 0) return 0;
  if (!Number.isFinite(elapsed) || elapsed < 0) return 0;
  const points = Math.round(1000 * (1 - elapsed / limitSeconds / 2));
  return Math.max(0, Math.min(1000, points));
}

/** Whole + fractional seconds between a player's start and their vote. */
export function elapsedSeconds(startedAt, votedAt) {
  const start = Number(startedAt);
  const vote = Number(votedAt);
  if (!Number.isFinite(start) || !Number.isFinite(vote) || vote <= start) return 0;
  return (vote - start) / 1000;
}
