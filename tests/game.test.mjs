// RoninClash tests: schedule validation, the game engine wired to a real
// SQLite store + the Baileys stub connection, and the poll/receipt plumbing on
// the connection.
import "./helpers/loader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { WhatsAppConnection } = await import("../src/whatsapp/connection.js");
const { createSqliteMessageStore } = await import("../src/db/sqlite.js");
const { createGameEngine } = await import("../src/whatsapp/game.js");
const { validateScheduleInput } = await import("../src/db/game.js");
const { parseCorrectIndexes } = await import("../src/whatsapp/scoring.mjs");
const { sha256 } = await import("./helpers/baileys-stub.mjs");
const {
  __reset,
  __sockets,
  __setGroupMetas,
  __setPollVote,
} = await import("./helpers/baileys-stub.mjs");

const GROUP = "120363412224156592@g.us";
const OWN = "1234@s.whatsapp.net";
const ADMIN = "15550000002@s.whatsapp.net";
const PLAYER = "15550000001@s.whatsapp.net";
const PLAYER2 = "15550000003@s.whatsapp.net";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 5000, step = 5) {
  const start = Date.now();
  // eslint-disable-next-line no-await-in-loop
  while (!(await cond())) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    // eslint-disable-next-line no-await-in-loop
    await sleep(step);
  }
}

/**
 * A decrypted vote selecting the given option texts. Mirrors the REAL proto
 * shape: `PollVoteMessage.selectedOptions` is `repeated bytes` — raw
 * sha256(optionText) digests, not `{ name }` objects.
 */
const vote = (...options) => ({
  selectedOptions: options.map((o) => sha256(Buffer.from(o))),
});

function makeAuth() {
  return {
    state: { cleared: 0 },
    load: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    clear: async () => {},
  };
}

function openConnection(wa) {
  return new Promise((resolve) => {
    wa.once("ready", () => resolve());
    const sock = __sockets().at(-1);
    sock.ev.emit("connection.update", { connection: "open" });
  });
}

/** A store + real connection + engine over the stub socket. */
async function setup(engineOpts = {}) {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  const engine = createGameEngine({ connection: wa, store, ...engineOpts });
  const frames = [];
  wa.on("game", (f) => frames.push(f));
  __setGroupMetas({
    [GROUP]: {
      id: GROUP,
      subject: "Trivia",
      participants: [
        { id: OWN, admin: "admin" },
        { id: ADMIN, admin: "admin" },
        { id: PLAYER },
        { id: PLAYER2 },
      ],
    },
  });
  try {
    await wa.start();
    await openConnection(wa);
  } catch (err) {
    store.close();
    throw err;
  }
  return { store, wa, engine, frames, sock: __sockets().at(-1) };
}

/** Schedules a game that opens its lobby immediately. */
async function scheduleLobby(ctx, questions) {
  const { engine, store } = ctx;
  const game = await engine.schedule({
    title: "Trivia",
    groupJid: GROUP,
    password: "pw",
    startAt: new Date(Date.now() + 15).toISOString(),
    minDelaySeconds: 0,
    maxDelaySeconds: 0,
    // Keep the question flow instant in tests (production defaults: 5s / 6s).
    groupToDmDelaySeconds: 0,
    betweenQuestionsSeconds: 0,
    questions,
  });
  await waitFor(async () => (await store.getGame(game.id))?.status === "lobby");
  const raw = await store.getGameRow(game.id);
  return { game, raw };
}

/** Registers a player by emitting their join vote. */
async function join(ctx, raw, jid, name, option = "I'm in") {
  __setPollVote(raw.join_message_id, vote(option));
  ctx.wa.emit("pollVote", {
    pollMessageId: raw.join_message_id,
    pollUpdateMessage: {
      pollCreationMessageKey: { id: raw.join_message_id, remoteJid: GROUP, fromMe: true },
      vote: { encPayload: Buffer.alloc(48), encIv: Buffer.alloc(12) },
    },
    chat: GROUP,
    isGroup: true,
    voterJid: jid,
    voterJidAlt: null,
    voterName: name,
    receivedAt: Date.now(),
  });
  await waitFor(async () =>
    option === "I'm in"
      ? (await ctx.store.getGamePlayer(raw.id, jid)) !== null
      : (await ctx.store.getGamePlayer(raw.id, jid)) === null
  );
}

/** Emits a poll vote on a player's question poll (rest = multiple options). */
function answer(ctx, send, ...options) {
  __setPollVote(send.poll_message_id, vote(...options));
  ctx.wa.emit("pollVote", {
    pollMessageId: send.poll_message_id,
    pollUpdateMessage: {
      pollCreationMessageKey: { id: send.poll_message_id, fromMe: true },
      vote: { encPayload: Buffer.alloc(48), encIv: Buffer.alloc(12) },
    },
    chat: send.player_jid,
    isGroup: false,
    voterJid: send.player_jid,
    voterJidAlt: null,
    receivedAt: Date.now(),
  });
}

/** ms to sleep until `target` (epoch ms); 0 when the time already passed. */
const until = (target) => Math.max(0, target - Date.now());

/**
 * Schedules a game, opens the lobby, registers both players, then starts it
 * with `.start <password>` from the group admin. `minDelaySeconds` doubles as
 * the gap between the two single-player DM batches (batchSize 1).
 */
async function startTwoPlayerGame(
  ctx,
  { questions, minDelaySeconds = 0, batchSize = null, ...extra } = {}
) {
  const { engine, store } = ctx;
  const game = await engine.schedule({
    title: "Trivia",
    groupJid: GROUP,
    password: "pw",
    startAt: new Date(Date.now() + 15).toISOString(),
    minDelaySeconds,
    maxDelaySeconds: minDelaySeconds,
    ...(batchSize ? { batchSize } : {}),
    // Keep the question flow instant in tests unless a test overrides them.
    groupToDmDelaySeconds: 0,
    betweenQuestionsSeconds: 0,
    ...extra,
    questions,
  });
  await waitFor(async () => (await store.getGame(game.id))?.status === "lobby");
  const raw = await store.getGameRow(game.id);
  await join(ctx, raw, PLAYER, "Ada");
  await join(ctx, raw, PLAYER2, "Bo");
  const res = await engine.startFromCommand(
    { chat: GROUP, sender: ADMIN, isGroup: true },
    "pw"
  );
  assert.deepEqual(res, { ok: true, gameId: game.id });
  return { game, raw };
}

const QUESTION = {
  question: "Capital of France?",
  options: ["Paris", "Rome", "Berlin"],
  correct: [0],
  timeLimit: 1,
  multi: false,
};

test("validateScheduleInput rejects bad rows and normalizes good ones", () => {
  const bad = validateScheduleInput({
    title: "Q",
    groupJid: GROUP,
    password: "pw",
    startAt: new Date().toISOString(),
    questions: [{ Question: "", "Answer 1": "a", "Answer 2": "b", "Correct answer(s)": "A" }],
  });
  assert.equal(bad.error, "some questions are invalid");
  assert.equal(bad.rowErrors.length, 1);

  const ok = validateScheduleInput({
    title: "Q",
    groupJid: GROUP,
    password: "pw",
    startAt: new Date().toISOString(),
    questions: [{ Question: "2+2?", "Answer 1": "3", "Answer 2": "4", "Correct answer(s)": "B" }],
  });
  assert.equal(ok.game.questions.length, 1);
  assert.deepEqual(ok.game.questions[0].correct, [1]);
  assert.equal(ok.game.questions[0].question, "2+2?");
});

test("schedule announces, opens the join poll and registers/unregisters voters", async () => {
  __reset();
  const ctx = await setup({ startDelayMs: 10, betweenQuestionsMs: 20 });
  const { store, sock } = ctx;
  const { game, raw } = await scheduleLobby(ctx, [QUESTION]);

  // The scheduler was told about the game, and the join poll is in the group.
  assert.ok(sock.sent.some((s) => s.jid === GROUP && /scheduled/i.test(s.content?.text ?? "")));
  const joinPoll = sock.sent.find((s) => s.content?.poll && s.jid === GROUP);
  assert.ok(joinPoll, "join poll sent to the group");
  assert.deepEqual(joinPoll.content.poll.values, ["I'm in", "Not this time"]);
  assert.equal(joinPoll.content.poll.selectableCount, 1);
  assert.equal(raw.join_message_id, joinPoll.key.id);
  assert.ok(raw.join_message_secret);

  // "I'm in" registers, switching to "Not this time" drops them again.
  await join(ctx, raw, PLAYER, "Ada");
  assert.equal((await store.getGamePlayer(game.id, PLAYER)).name, "Ada");
  await join(ctx, raw, PLAYER2, "Bo");
  assert.equal(await store.countGamePlayers(game.id), 2);
  await join(ctx, raw, PLAYER2, "Bo", "Not this time");
  assert.equal(await store.countGamePlayers(game.id), 1);
});

test("start is gated on password + admin, then scores a full game", async () => {
  __reset();
  const ctx = await setup({ startDelayMs: 10, betweenQuestionsMs: 20, intraBatchJitterMs: 0 });
  const { store, wa, engine, sock } = ctx;
  const questions = [
    QUESTION,
    { question: "2+2?", options: ["3", "4", "5"], correct: [1], timeLimit: 1, multi: false },
  ];
  const { game, raw } = await scheduleLobby(ctx, questions);
  await join(ctx, raw, PLAYER, "Ada");

  // Wrong password.
  let res = await engine.startFromCommand({ chat: GROUP, sender: ADMIN, isGroup: true }, "nope");
  assert.deepEqual(res, { ok: false, reason: "password" });

  // Right password, but the sender is not an admin/host.
  res = await engine.startFromCommand({ chat: GROUP, sender: PLAYER, isGroup: true }, "pw");
  assert.equal(res.reason, "not-allowed");

  // An admin starts it.
  res = await engine.startFromCommand({ chat: GROUP, sender: ADMIN, isGroup: true }, "pw");
  assert.deepEqual(res, { ok: true, gameId: game.id });
  assert.equal((await store.getGame(game.id)).status, "running");
  assert.ok(
    sock.sent.some((s) => s.jid === GROUP && /Registration closed/.test(s.content?.text ?? ""))
  );
  assert.ok(
    sock.sent.some((s) => s.jid === GROUP && (s.content?.mentions ?? []).includes(PLAYER)),
    "players are tagged"
  );
  assert.ok(
    sock.sent.some(
      (s) =>
        s.jid === GROUP &&
        /Registration closed/.test(s.content?.text ?? "") &&
        (s.content?.text ?? "").includes("Trivia"),
    ),
    "the lock message carries the game title"
  );

  // Question 1 is DM'd as a poll.
  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length === 1);
  const send1 = (await store.listQuestionSends(game.id, 0))[0];
  assert.equal(send1.player_jid, PLAYER);
  const poll1 = sock.sent.find((s) => s.content?.poll && s.jid === PLAYER);
  // DM polls are numbered: "shown" visibility prefixes the question text.
  assert.equal(poll1.content.poll.name, "Q1: Capital of France?");
  assert.equal(poll1.content.poll.selectableCount, 1);
  assert.ok(send1.poll_secret);
  assert.ok(
    sock.sent.some((s) => s.jid === GROUP && /First question sent/.test(s.content?.text ?? "")),
    "the group is told the first question went out"
  );

  // Correct answer -> scored, result DM'd, leaderboard posted.
  answer(ctx, send1, "Paris");
  await waitFor(async () => {
    const a = await store.getAnswer(game.id, 0, PLAYER);
    return a && a.seconds !== null;
  });
  const scored = await store.getAnswer(game.id, 0, PLAYER);
  assert.equal(scored.correct, true);
  assert.ok(scored.points > 0 && scored.points <= 1000);
  assert.ok(sock.sent.some((s) => s.jid === PLAYER && /Correct/.test(s.content?.text ?? "")));
  assert.ok(sock.sent.some((s) => s.jid === GROUP && /Leaderboard/.test(s.content?.text ?? "")));

  // Question 2 opens after the pause; a wrong answer scores 0.
  await waitFor(async () => (await store.listQuestionSends(game.id, 1)).length === 1);
  const send2 = (await store.listQuestionSends(game.id, 1))[0];
  answer(ctx, send2, "5");
  await waitFor(async () => {
    const a = await store.getAnswer(game.id, 1, PLAYER);
    return a && a.seconds !== null;
  });
  assert.equal((await store.getAnswer(game.id, 1, PLAYER)).correct, false);

  // The last question finishing ends the game with a podium.
  await waitFor(async () => (await store.getGame(game.id))?.status === "finished");
  assert.ok(
    sock.sent.some((s) => s.jid === GROUP && /Final podium/.test(s.content?.text ?? ""))
  );
  const player = await store.getGamePlayer(game.id, PLAYER);
  assert.equal(player.correctCount, 1);
  assert.ok(wa.listenerCount?.("game") >= 0);
});

test("a delivery receipt stamps the question send", async () => {
  __reset();
  const { store, engine } = await setup();
  const game = await store.createGame({
    title: "T",
    groupJid: GROUP,
    password: "p",
    startAt: new Date().toISOString(),
    questions: [],
  });
  await store.createQuestionSend({
    gameId: game.id,
    questionIndex: 0,
    playerJid: PLAYER,
    pollMessageId: "poll-1",
    pollSecret: "secret",
    sentAt: new Date().toISOString(),
  });

  assert.equal((await store.getQuestionSendByPollId("poll-1")).delivered_at, null);
  // A "sent" ack (status 2) is not a delivery.
  await engine.handleReceipt({ id: "poll-1", status: 2 });
  assert.equal((await store.getQuestionSendByPollId("poll-1")).delivered_at, null);
  // A DELIVERY_ACK (3) stamps it.
  await engine.handleReceipt({ id: "poll-1", status: 3 });
  assert.ok((await store.getQuestionSendByPollId("poll-1")).delivered_at);
});

test("the connection surfaces poll-update messages as pollVote events", async () => {
  __reset();
  const { wa, sock } = await setup();
  const events = [];
  wa.on("pollVote", (e) => events.push(e));

  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "vote-1", remoteJid: PLAYER, fromMe: false },
        pushName: "Ada",
        message: {
          messageContextInfo: {},
          pollUpdateMessage: {
            pollCreationMessageKey: { id: "poll-9" },
            vote: { encPayload: "aGk=", encIv: "aXY=" },
          },
        },
      },
    ],
  });

  await waitFor(() => events.length === 1);
  assert.equal(events[0].pollMessageId, "poll-9");
  assert.equal(events[0].voterJid, PLAYER);
  assert.equal(events[0].voterName, "Ada");
  assert.equal(events[0].isGroup, false);
});

test("sendPoll returns a 32-byte secret and the poll key", async () => {
  __reset();
  const { wa, sock } = await setup();
  const { key, messageSecret } = await wa.sendPoll(PLAYER, {
    question: "Pick one",
    options: ["A", "B"],
    selectableCount: 1,
  });
  assert.ok(key?.id);
  assert.equal(messageSecret.length, 32);
  const sent = sock.sent.find((s) => s.jid === PLAYER);
  assert.equal(sent.content.poll.name, "Pick one");
  assert.deepEqual(sent.content.poll.values, ["A", "B"]);
  assert.equal(sent.content.poll.selectableCount, 1);
  assert.ok(Buffer.isBuffer(sent.content.poll.messageSecret));
});

test("parseCorrectIndexes matches option text with spaces and every separator", () => {
  const opts = ["New York", "Los Angeles", "Chicago", "Houston"];
  assert.deepEqual(parseCorrectIndexes("New York", opts), [0]);
  assert.deepEqual(parseCorrectIndexes("new york, Houston", opts), [0, 3]);
  assert.deepEqual(parseCorrectIndexes("Los Angeles and Chicago", opts), [1, 2]);
  assert.deepEqual(parseCorrectIndexes("A D", opts), [0, 3]);
  assert.deepEqual(parseCorrectIndexes("B,3", opts), [1, 2]);
  assert.deepEqual(parseCorrectIndexes("Nowhere", opts), []);
  assert.deepEqual(parseCorrectIndexes("", opts), []);
  // Option indexes past the row's option count are dropped.
  assert.deepEqual(parseCorrectIndexes("D", ["x", "y"]), []);
});

test("a correct vote after the player's personal deadline scores 0", async () => {
  __reset();
  const ctx = await setup({
    startDelayMs: 10,
    betweenQuestionsMs: 20,
    intraBatchJitterMs: 0,
    questionGraceMs: 0,
  });
  const { store, sock } = ctx;
  const q = {
    question: "Capital of France?",
    options: ["Paris", "Rome", "Berlin"],
    correct: [0],
    timeLimit: 2,
    multi: false,
  };
  // Two players sent in separate batches 2s apart => staggered deadlines:
  // PLAYER's personal deadline is t0+2000, PLAYER2's is ~t0+4000.
  const { game } = await startTwoPlayerGame(ctx, {
    questions: [q],
    minDelaySeconds: 2,
    batchSize: 1,
  });

  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length >= 1);
  const send1 = (await store.listQuestionSends(game.id, 0))[0];
  assert.equal(send1.player_jid, PLAYER);
  const t0 = Date.parse(send1.sent_at);

  // PLAYER2's poll lands ~2s later; vote it on time.
  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length === 2);
  const send2 = (await store.listQuestionSends(game.id, 0)).find(
    (s) => s.player_jid === PLAYER2
  );
  answer(ctx, send2, "Paris");

  // PLAYER answers correctly — but after their own deadline (t0+2000).
  await sleep(until(t0 + 2600));
  answer(ctx, send1, "Paris");

  await waitFor(async () => {
    const a = await store.getAnswer(game.id, 0, PLAYER);
    const b = await store.getAnswer(game.id, 0, PLAYER2);
    return a && b && a.seconds !== null && b.seconds !== null;
  });

  const lateVote = await store.getAnswer(game.id, 0, PLAYER);
  assert.equal(lateVote.correct, false, "a late vote is not scored as correct");
  assert.equal(lateVote.points, 0, "a late vote scores 0");
  assert.ok(
    sock.sent.some((s) => s.jid === PLAYER && /Too late/.test(s.content?.text ?? "")),
    "the player is told they were too late"
  );

  const onTime = await store.getAnswer(game.id, 0, PLAYER2);
  assert.equal(onTime.correct, true);
  assert.ok(onTime.points > 0 && onTime.points <= 1000);
});

test("multi-answer keeps the last pre-deadline selection and never reopens a finalized answer", async () => {
  __reset();
  const ctx = await setup({
    startDelayMs: 10,
    betweenQuestionsMs: 20,
    intraBatchJitterMs: 0,
    questionGraceMs: 0,
  });
  const { store } = ctx;
  const q = {
    question: "Pick both cities",
    options: ["Paris", "Rome", "Berlin"],
    correct: [0, 1],
    timeLimit: 2,
    multi: true,
  };
  // PLAYER's deadline is t0+2000; the question closes at ~t0+4000
  // (PLAYER2's deadline), leaving a post-deadline/pre-close window.
  const { game } = await startTwoPlayerGame(ctx, {
    questions: [q],
    minDelaySeconds: 2,
    batchSize: 1,
  });

  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length >= 1);
  const send1 = (await store.listQuestionSends(game.id, 0))[0];
  const t0 = Date.parse(send1.sent_at);

  // On-time exact match for PLAYER.
  answer(ctx, send1, "Paris", "Rome");
  await waitFor(async () => {
    const a = await store.getAnswer(game.id, 0, PLAYER);
    return a && a.selected.length === 2;
  });
  const firstVote = await store.getAnswer(game.id, 0, PLAYER);
  assert.deepEqual(firstVote.selected, [0, 1]);
  assert.ok(firstVote.votedAt <= t0 + 2000);

  // PLAYER2 plays too (their later deadline is what keeps the question open).
  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length === 2);
  const send2 = (await store.listQuestionSends(game.id, 0)).find(
    (s) => s.player_jid === PLAYER2
  );
  answer(ctx, send2, "Paris", "Rome");

  // After PLAYER's deadline but before the question closes: the change must
  // be dropped so the last pre-deadline selection (and its time) is kept.
  await sleep(until(t0 + 2600));
  answer(ctx, send1, "Paris");
  await sleep(120);
  const mid = await store.getAnswer(game.id, 0, PLAYER);
  assert.deepEqual(mid.selected, [0, 1], "post-deadline change is ignored");
  assert.equal(mid.votedAt, firstVote.votedAt, "the original vote time is kept");

  // The question closes at PLAYER2's deadline and scores PLAYER from the
  // pre-deadline selection; a straggler vote must not reopen the answer.
  await waitFor(
    async () => {
      const a = await store.getAnswer(game.id, 0, PLAYER);
      return a && a.seconds !== null;
    },
    8000
  );
  const closed = await store.getAnswer(game.id, 0, PLAYER);
  assert.equal(closed.correct, true);
  assert.ok(closed.points > 0, "the pre-deadline exact match scored");

  answer(ctx, send1, "Berlin");
  await sleep(150);
  const after = await store.getAnswer(game.id, 0, PLAYER);
  assert.deepEqual(after.selected, [0, 1], "the finalized answer is unchanged");
  assert.equal(after.points, closed.points);
  assert.equal(after.seconds, closed.seconds);
});

test("a join vote arriving through messages.upsert registers the player", async () => {
  __reset();
  const ctx = await setup({ startDelayMs: 10, betweenQuestionsMs: 20 });
  const { store, sock } = ctx;
  const { raw } = await scheduleLobby(ctx, [QUESTION]);
  __setPollVote(raw.join_message_id, vote("I'm in"));

  // Real-shaped group vote: the creation key points at the join poll, the
  // voter is the message participant, payload fields are proto byte buffers.
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id: "vote-join-1", remoteJid: GROUP, participant: PLAYER, fromMe: false },
        pushName: "Ada",
        message: {
          messageContextInfo: {},
          pollUpdateMessage: {
            pollCreationMessageKey: {
              id: raw.join_message_id,
              remoteJid: GROUP,
              fromMe: true,
            },
            vote: {
              encPayload: Buffer.alloc(48),
              encIv: Buffer.alloc(12),
              senderTimestampMs: Date.now(),
            },
          },
        },
      },
    ],
  });

  await waitFor(async () => (await store.getGamePlayer(raw.id, PLAYER)) !== null);
  const player = await store.getGamePlayer(raw.id, PLAYER);
  assert.equal(player.name, "Ada");
});

test("group-first flow: the question text lands in the group before the delayed DM polls", async () => {
  __reset();
  const ctx = await setup({ startDelayMs: 10, betweenQuestionsMs: 20, intraBatchJitterMs: 0 });
  const { store, sock } = ctx;
  const { game } = await startTwoPlayerGame(ctx, {
    questions: [QUESTION],
    groupToDmDelaySeconds: 1, // one second of shared reading time
  });

  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length === 2);

  const groupIdx = sock.sent.findIndex(
    (s) => s.jid === GROUP && (s.content?.text ?? "").includes("Q1/1")
  );
  assert.ok(groupIdx !== -1, "the full question text was posted to the group");
  const groupEntry = sock.sent[groupIdx];
  assert.ok(groupEntry.content.text.includes("Capital of France?"));
  assert.ok(groupEntry.content.text.includes("A Paris"), "lettered options included");

  const firstDmIdx = sock.sent.findIndex((s) => s.content?.poll && s.jid === PLAYER);
  const secondDmIdx = sock.sent.findIndex((s) => s.content?.poll && s.jid === PLAYER2);
  assert.ok(firstDmIdx > groupIdx, "no DM poll lands before the group text");
  assert.ok(secondDmIdx > groupIdx, "no DM poll lands before the group text");
  assert.ok(
    sock.sent[firstDmIdx].at - groupEntry.at >= 900,
    "the group-to-DM reading pause is honored"
  );

  // The "sent to N players" follow-up comes after the DMs, as before.
  const sentLineIdx = sock.sent.findIndex(
    (s) => s.jid === GROUP && /sent to 2 player/.test(s.content?.text ?? "")
  );
  assert.ok(sentLineIdx > firstDmIdx, "the sent-count line follows the DM polls");
});

test("dm question visibility: hidden polls carry only the number, shown polls the wording", async () => {
  __reset();
  const ctx = await setup({ startDelayMs: 10, betweenQuestionsMs: 20, intraBatchJitterMs: 0 });
  const { store, sock } = ctx;
  const { game } = await startTwoPlayerGame(ctx, {
    questions: [QUESTION],
    dmQuestionVisibility: "hidden",
  });

  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length === 2);
  const polls = sock.sent.filter(
    (s) => s.content?.poll && (s.jid === PLAYER || s.jid === PLAYER2)
  );
  assert.ok(polls.length >= 2, "both players got an answer poll");
  for (const p of polls) assert.equal(p.content.poll.name, "Q1");
});

test("the game's question time override beats the sheet's time limit", async () => {
  __reset();
  const ctx = await setup({
    startDelayMs: 10,
    betweenQuestionsMs: 20,
    intraBatchJitterMs: 0,
    questionGraceMs: 0,
  });
  const { store } = ctx;
  const { game } = await startTwoPlayerGame(ctx, {
    // The sheet says a minute...
    questions: [{ ...QUESTION, timeLimit: 60 }],
    // ...but the game overrides every question to a one-second question.
    questionTimeSeconds: 1,
  });

  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length === 2);
  // Without the override this would only finalize ~60s after the sends.
  await waitFor(
    async () => {
      const a = await store.getAnswer(game.id, 0, PLAYER);
      const b = await store.getAnswer(game.id, 0, PLAYER2);
      return a && b && a.seconds !== null && b.seconds !== null;
    },
    4000
  );
  assert.equal((await store.getGame(game.id)).questionTimeSeconds, 1);
});

test("manual advance holds after the leaderboard and .next gates host/admin", async () => {
  __reset();
  const ctx = await setup({ startDelayMs: 10, betweenQuestionsMs: 20, intraBatchJitterMs: 0 });
  const { store, engine, sock } = ctx;
  const questions = [
    QUESTION,
    { question: "2+2?", options: ["3", "4", "5"], correct: [1], timeLimit: 1, multi: false },
  ];
  const { game } = await startTwoPlayerGame(ctx, { questions, advanceMode: "manual" });

  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length === 2);
  // While the question is open nothing is held yet.
  assert.deepEqual(await engine.advanceManual(game.id), { ok: false, reason: "not-held" });

  const sends1 = await store.listQuestionSends(game.id, 0);
  answer(ctx, sends1.find((s) => s.player_jid === PLAYER), "Paris");
  answer(ctx, sends1.find((s) => s.player_jid === PLAYER2), "Paris");

  // The close posts the leaderboard + hold prompt INSTEAD of advancing.
  const prompt = "The host or a group admin sends `.next` to continue.";
  await waitFor(async () =>
    sock.sent.some((s) => s.jid === GROUP && (s.content?.text ?? "").includes(prompt))
  );
  assert.ok(
    sock.sent.some((s) => s.jid === GROUP && /after Q1\/2/.test(s.content?.text ?? ""))
  );
  await sleep(300);
  assert.equal(
    (await store.listQuestionSends(game.id, 1)).length,
    0,
    "no next question while held"
  );

  // A plain player can't advance.
  let res = await engine.nextFromCommand({ chat: GROUP, sender: PLAYER, isGroup: true });
  assert.deepEqual(res, { ok: false, reason: "not-allowed" });
  assert.ok(
    sock.sent.some(
      (s) => s.jid === GROUP && /Only the host or a group admin can advance/.test(s.content?.text ?? "")
    )
  );
  await sleep(200);
  assert.equal((await store.listQuestionSends(game.id, 1)).length, 0, "still held");

  // The admin's `.next` (through the real message path) advances the game.
  await engine.handleMessage({
    chat: GROUP,
    sender: ADMIN,
    isGroup: true,
    fromMe: false,
    text: ".next",
  });
  await waitFor(async () => (await store.listQuestionSends(game.id, 1)).length === 2);
  assert.ok(
    sock.sent.some((s) => s.jid === GROUP && (s.content?.text ?? "").includes("Q2/2"))
  );

  // Closing the last question holds again; the host's `.next` finishes the game.
  const sends2 = await store.listQuestionSends(game.id, 1);
  answer(ctx, sends2.find((s) => s.player_jid === PLAYER), "4");
  answer(ctx, sends2.find((s) => s.player_jid === PLAYER2), "4");
  await waitFor(
    async () =>
      sock.sent.filter((s) => s.jid === GROUP && (s.content?.text ?? "").includes(prompt))
        .length >= 2,
    6000
  );
  res = await engine.nextFromCommand({ chat: GROUP, sender: ADMIN, isGroup: true });
  assert.deepEqual(res, { ok: true, gameId: game.id });
  await waitFor(async () => (await store.getGame(game.id))?.status === "finished");
  assert.ok(
    sock.sent.some((s) => s.jid === GROUP && /Final podium/.test(s.content?.text ?? ""))
  );
});

test("auto mode waits the game's between-questions pause before the next question", async () => {
  __reset();
  const ctx = await setup({
    startDelayMs: 10,
    betweenQuestionsMs: 20,
    intraBatchJitterMs: 0,
    questionGraceMs: 0,
  });
  const { store, sock } = ctx;
  const questions = [
    QUESTION,
    { question: "2+2?", options: ["3", "4", "5"], correct: [1], timeLimit: 1, multi: false },
  ];
  const { game } = await startTwoPlayerGame(ctx, {
    questions,
    betweenQuestionsSeconds: 1,
  });

  await waitFor(async () => (await store.listQuestionSends(game.id, 0)).length === 2);
  const sends1 = await store.listQuestionSends(game.id, 0);
  answer(ctx, sends1.find((s) => s.player_jid === PLAYER), "Paris");
  answer(ctx, sends1.find((s) => s.player_jid === PLAYER2), "Paris");

  await waitFor(async () =>
    sock.sent.some((s) => s.jid === GROUP && /after Q1\/2/.test(s.content?.text ?? ""))
  );
  const leaderboard = sock.sent.find(
    (s) => s.jid === GROUP && /after Q1\/2/.test(s.content?.text ?? "")
  );

  await waitFor(async () =>
    sock.sent.some((s) => s.jid === GROUP && (s.content?.text ?? "").includes("Q2/2"))
  );
  const q2Text = sock.sent.find(
    (s) => s.jid === GROUP && (s.content?.text ?? "").includes("Q2/2")
  );
  assert.ok(
    q2Text.at - leaderboard.at >= 900,
    "the configured pause elapses between the leaderboard and the next question"
  );
  assert.equal((await store.getGameRow(game.id)).advance_mode, "auto");
});
