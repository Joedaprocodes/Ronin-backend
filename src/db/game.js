/**
 * Shared RoninClash game helpers used by both the SQLite and Postgres stores and
 * by the API's request validation. Keeping defaults, validation and the row ->
 * view mapping here guarantees the two stores stay behaviourally identical.
 *
 * A **game** is one scheduled RoninClash round in a WhatsApp group. It moves
 * through the lifecycle scheduled -> lobby -> running -> finished (or
 * cancelled). Players register during the lobby by voting "I'm in" on a join
 * poll; questions live inline as jsonb (parsed from the host's spreadsheet).
 *
 * The password that starts a game is never returned to the client: `gameToView`
 * masks it behind `hasPassword`.
 */

import { randomUUID } from "node:crypto";
import { parseQuestions } from "../whatsapp/scoring.mjs";

/** The lifecycle a game moves through. */
export const GAME_STATUSES = ["scheduled", "lobby", "running", "finished", "cancelled"];

/** How many DMs are sent per batch before the min/max delay is applied. */
export const DEFAULT_BATCH_SIZE = 10;

/** Default delays (seconds) between batches of DMs. */
export const DEFAULT_MIN_DELAY = 8;
export const DEFAULT_MAX_DELAY = 25;

/** Hard bounds on the delay settings. */
export const MAX_DELAY_SECONDS = 3600;
/** Below this, WhatsApp is more likely to flag the account — the UI warns. */
export const RISKY_DELAY_SECONDS = 5;

/** How a question advances once closed. `manual` waits for `.next`. */
export const ADVANCE_MODES = ["auto", "manual"];
/** What a DM answer poll shows as its question line. */
export const DM_QUESTION_VISIBILITY = ["shown", "hidden"];

/** Default pause (seconds) after a question's results before the next one. */
export const DEFAULT_BETWEEN_QUESTIONS_SECONDS = 6;
/** Default pause (seconds) between the group question text and DM polls. */
export const DEFAULT_GROUP_TO_DM_DELAY_SECONDS = 5;

export const MAX_TITLE_LENGTH = 120;
export const MAX_PASSWORD_LENGTH = 64;
export const MAX_QUESTIONS = 200;

/** Longest a poll's question line may be (WhatsApp truncates long polls). */
const MAX_POLL_NAME = 255;
export const MAX_OPTIONS = 4;

/** A game's defaults; missing fields fall back to these. */
export const DEFAULT_GAME = {
  title: "",
  groupJid: "",
  password: "",
  status: "scheduled",
  startAt: null,
  minDelaySeconds: DEFAULT_MIN_DELAY,
  maxDelaySeconds: DEFAULT_MAX_DELAY,
  batchSize: DEFAULT_BATCH_SIZE,
  questionTimeSeconds: null, // null = each question's own sheet time limit
  betweenQuestionsSeconds: DEFAULT_BETWEEN_QUESTIONS_SECONDS,
  advanceMode: "auto",
  groupToDmDelaySeconds: DEFAULT_GROUP_TO_DM_DELAY_SECONDS,
  dmQuestionVisibility: "shown",
  questions: [],
  questionIndex: 0,
};

/**
 * Validates the raw questions payload. Accepts either already-normalized
 * questions (`{ question, options, correct, timeLimit }`) or raw spreadsheet
 * rows (`{ Question, "Answer 1": ..., "Correct answer(s)": ... }`) so the
 * frontend can send whichever it has.
 *
 * @returns {{ questions: Array, errors: Array<{ row: number, message: string }> }}
 */
export function normalizeQuestions(questions = []) {
  const list = Array.isArray(questions) ? questions : [];
  const asRows = list.map((q) => {
    if (q && Array.isArray(q.options)) {
      const correct = (q.correct ?? [])
        .map((i) => String.fromCharCode(65 + Number(i)))
        .join(",");
      return {
        Question: q.question,
        "Answer 1": q.options[0] ?? "",
        "Answer 2": q.options[1] ?? "",
        "Answer 3": q.options[2] ?? "",
        "Answer 4": q.options[3] ?? "",
        "Time limit (sec)": q.timeLimit,
        "Correct answer(s)": correct,
      };
    }
    return q;
  });
  return parseQuestions(asRows);
}

/**
 * Parses the five editable timing/flow fields shared by scheduling and live
 * game updates: `questionTimeSeconds` (nullable per-sheet override),
 * `betweenQuestionsSeconds`, `advanceMode`, `groupToDmDelaySeconds` and
 * `dmQuestionVisibility`. Absent/null keeps the default (so callers merge the
 * result onto DEFAULT_GAME for scheduling, or onto a live row for a PATCH).
 *
 * @returns {{ fields?: object, error?: string }}
 */
function parseTimingFields(input = {}) {
  const fields = {};

  if (input.questionTimeSeconds !== undefined && input.questionTimeSeconds !== null) {
    const qt = Number(input.questionTimeSeconds);
    if (!Number.isFinite(qt) || qt < 1 || qt > MAX_DELAY_SECONDS) {
      return { error: `questionTimeSeconds must be between 1 and ${MAX_DELAY_SECONDS}` };
    }
    fields.questionTimeSeconds = Math.round(qt);
  }

  if (input.betweenQuestionsSeconds !== undefined && input.betweenQuestionsSeconds !== null) {
    const bq = Number(input.betweenQuestionsSeconds);
    if (!Number.isFinite(bq) || bq < 0 || bq > MAX_DELAY_SECONDS) {
      return { error: `betweenQuestionsSeconds must be between 0 and ${MAX_DELAY_SECONDS}` };
    }
    fields.betweenQuestionsSeconds = Math.round(bq);
  }

  if (input.advanceMode !== undefined && input.advanceMode !== null) {
    if (!ADVANCE_MODES.includes(input.advanceMode)) {
      return { error: "advanceMode must be one of: auto, manual" };
    }
    fields.advanceMode = input.advanceMode;
  }

  if (input.groupToDmDelaySeconds !== undefined && input.groupToDmDelaySeconds !== null) {
    const gd = Number(input.groupToDmDelaySeconds);
    if (!Number.isFinite(gd) || gd < 0 || gd > MAX_DELAY_SECONDS) {
      return { error: `groupToDmDelaySeconds must be between 0 and ${MAX_DELAY_SECONDS}` };
    }
    fields.groupToDmDelaySeconds = Math.round(gd);
  }

  if (input.dmQuestionVisibility !== undefined && input.dmQuestionVisibility !== null) {
    if (!DM_QUESTION_VISIBILITY.includes(input.dmQuestionVisibility)) {
      return { error: "dmQuestionVisibility must be one of: shown, hidden" };
    }
    fields.dmQuestionVisibility = input.dmQuestionVisibility;
  }

  return { fields };
}

/**
 * Validates just the timing/flow fields of a game update (used by
 * `PATCH /api/games/:id` while a game is lobby/running). An explicit
 * `questionTimeSeconds: null` clears the override; the other fields fall back
 * to their defaults when omitted.
 *
 * @returns {{ patch?: object, error?: string }}
 */
export function validateTimingInput(input = {}) {
  const { fields, error } = parseTimingFields(input);
  if (error) return { error };
  const patch = { ...fields };
  if ("questionTimeSeconds" in input && input.questionTimeSeconds == null) {
    patch.questionTimeSeconds = null; // explicitly clear the per-sheet override
  }
  return { patch };
}

/**
 * Validates a schedule request. Returns `{ game }` (normalized, ready to
 * insert) or `{ error }` for a field problem, or `{ error, rowErrors }` when one
 * or more spreadsheet rows are invalid.
 */
export function validateScheduleInput(input = {}) {
  const game = { ...DEFAULT_GAME, questions: [] };

  if (typeof input.title !== "string" || !input.title.trim()) {
    return { error: "title is required" };
  }
  const title = input.title.trim();
  if (title.length > MAX_TITLE_LENGTH) {
    return { error: `title must be at most ${MAX_TITLE_LENGTH} characters` };
  }
  game.title = title;

  if (typeof input.groupJid !== "string" || !input.groupJid.trim()) {
    return { error: "groupJid is required" };
  }
  game.groupJid = input.groupJid.trim();

  if (typeof input.password !== "string" || !input.password) {
    return { error: "password is required" };
  }
  if (input.password.length > MAX_PASSWORD_LENGTH) {
    return { error: `password must be at most ${MAX_PASSWORD_LENGTH} characters` };
  }
  game.password = input.password;

  const startAt = input.startAt ? new Date(input.startAt) : null;
  if (!startAt || Number.isNaN(startAt.getTime())) {
    return { error: "startAt must be a valid date/time" };
  }
  game.startAt = startAt.toISOString();

  const min = Number(input.minDelaySeconds ?? DEFAULT_MIN_DELAY);
  const max = Number(input.maxDelaySeconds ?? DEFAULT_MAX_DELAY);
  if (!Number.isFinite(min) || min < 0 || min > MAX_DELAY_SECONDS) {
    return { error: `minDelaySeconds must be between 0 and ${MAX_DELAY_SECONDS}` };
  }
  if (!Number.isFinite(max) || max < 0 || max > MAX_DELAY_SECONDS) {
    return { error: `maxDelaySeconds must be between 0 and ${MAX_DELAY_SECONDS}` };
  }
  if (min > max) {
    return { error: "minDelaySeconds must be less than or equal to maxDelaySeconds" };
  }
  game.minDelaySeconds = Math.round(min);
  game.maxDelaySeconds = Math.round(max);

  const batch = Number(input.batchSize ?? DEFAULT_BATCH_SIZE);
  if (!Number.isFinite(batch) || batch < 1 || batch > 50) {
    return { error: "batchSize must be between 1 and 50" };
  }
  game.batchSize = Math.round(batch);

  const timing = parseTimingFields(input);
  if (timing.error) return { error: timing.error };
  Object.assign(game, timing.fields);

  const { questions, errors } = normalizeQuestions(input.questions);
  if (errors.length) {
    return { error: "some questions are invalid", rowErrors: errors };
  }
  if (!questions.length) return { error: "at least one valid question is required" };
  if (questions.length > MAX_QUESTIONS) {
    return { error: `at most ${MAX_QUESTIONS} questions are allowed` };
  }
  game.questions = questions;

  return { game };
}

/** Truncates a poll question line to WhatsApp's practical limit. */
export function pollName(text) {
  const s = String(text ?? "");
  return s.length > MAX_POLL_NAME ? `${s.slice(0, MAX_POLL_NAME - 1)}…` : s;
}

/**
 * Public view of a game. NEVER includes `password`; `hasPassword` lets the UI
 * show a masked field. `questions` is reduced to a count for list views (pass
 * `{ withQuestions: true }` for the detail view).
 */
export function gameToView(row, { playerCount = null, withQuestions = false } = {}) {
  if (!row) return null;
  const questions = Array.isArray(row.questions) ? row.questions : [];
  const view = {
    id: row.id,
    title: row.title ?? "",
    groupJid: row.group_jid ?? row.groupJid ?? "",
    status: GAME_STATUSES.includes(row.status) ? row.status : "scheduled",
    startAt: row.start_at ?? row.startAt ?? null,
    minDelaySeconds: row.min_delay_seconds ?? row.minDelaySeconds ?? DEFAULT_MIN_DELAY,
    maxDelaySeconds: row.max_delay_seconds ?? row.maxDelaySeconds ?? DEFAULT_MAX_DELAY,
    batchSize: row.batch_size ?? row.batchSize ?? DEFAULT_BATCH_SIZE,
    questionTimeSeconds:
      row.question_time_seconds ?? row.questionTimeSeconds ?? null,
    betweenQuestionsSeconds:
      row.between_questions_seconds ??
      row.betweenQuestionsSeconds ??
      DEFAULT_BETWEEN_QUESTIONS_SECONDS,
    advanceMode: ADVANCE_MODES.includes(row.advance_mode ?? row.advanceMode)
      ? (row.advance_mode ?? row.advanceMode)
      : "auto",
    groupToDmDelaySeconds:
      row.group_to_dm_delay_seconds ??
      row.groupToDmDelaySeconds ??
      DEFAULT_GROUP_TO_DM_DELAY_SECONDS,
    dmQuestionVisibility: DM_QUESTION_VISIBILITY.includes(
      row.dm_question_visibility ?? row.dmQuestionVisibility
    )
      ? (row.dm_question_visibility ?? row.dmQuestionVisibility)
      : "shown",
    questionCount: questions.length,
    questionIndex: row.question_index ?? row.questionIndex ?? 0,
    hostJid: row.host_jid ?? row.hostJid ?? null,
    hasPassword: Boolean(row.password),
    createdAt: toIso(row.created_at ?? row.createdAt),
    updatedAt: toIso(row.updated_at ?? row.updatedAt),
  };
  if (playerCount !== null) view.playerCount = playerCount;
  if (withQuestions) {
    view.questions = questions.map((q) => ({
      index: q.index,
      number: q.number,
      question: q.question,
      options: q.options,
      timeLimit: q.timeLimit,
      multi: Boolean(q.multi),
      // The correct answer is included for the host's review; it is never sent
      // to players before the reveal.
      correct: q.correct,
    }));
  }
  return view;
}

/** Public view of a registered player + their running score. */
export function gamePlayerToView(row) {
  if (!row) return null;
  return {
    jid: row.jid,
    name: row.name ?? null,
    joinedAt: toIso(row.joined_at ?? row.joinedAt),
    points: Number(row.total_points ?? row.points ?? 0),
    correctCount: Number(row.correct_count ?? row.correctCount ?? 0),
    totalTimeMs: Number(row.total_time_ms ?? row.totalTimeMs ?? 0),
  };
}

function toIso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** New game id (uuid). Exposed so both stores mint ids identically. */
export function newGameId() {
  return randomUUID();
}

/**
 * Map of camelCase patch keys -> database column names, shared by both stores.
 * `updateGame` only writes keys present in the patch.
 */
export const GAME_COLUMNS = {
  title: "title",
  groupJid: "group_jid",
  password: "password",
  status: "status",
  startAt: "start_at",
  minDelaySeconds: "min_delay_seconds",
  maxDelaySeconds: "max_delay_seconds",
  batchSize: "batch_size",
  questionTimeSeconds: "question_time_seconds",
  betweenQuestionsSeconds: "between_questions_seconds",
  advanceMode: "advance_mode",
  groupToDmDelaySeconds: "group_to_dm_delay_seconds",
  dmQuestionVisibility: "dm_question_visibility",
  questions: "questions",
  questionIndex: "question_index",
  joinMessageId: "join_message_id",
  joinMessageSecret: "join_message_secret",
  hostJid: "host_jid",
};

/** Public view of a stored answer row. */
export function answerToView(row) {
  if (!row) return null;
  const selected = typeof row.selected === "string" ? safeJson(row.selected) : row.selected;
  return {
    gameId: row.game_id ?? row.gameId,
    questionIndex: Number(row.question_index ?? row.questionIndex),
    playerJid: row.player_jid ?? row.playerJid,
    selected: Array.isArray(selected) ? selected.map(Number) : [],
    votedAt: numberOrNull(row.voted_at ?? row.votedAt),
    points: Number(row.points) || 0,
    correct: Boolean(row.correct),
    seconds: numberOrNull(row.seconds),
  };
}

function numberOrNull(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}