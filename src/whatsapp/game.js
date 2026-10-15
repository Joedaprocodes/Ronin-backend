/**
 * RoninClash engine — a WhatsApp group trivia game driven entirely by polls.
 *
 * Lifecycle (mirrored in the `games.status` column):
 *
 *   scheduled -> lobby -> running -> finished
 *
 *  scheduled  The game is created from the web UI. A timer fires at `startAt`.
 *  lobby      A join poll ("I'm in" / "Not this time") is posted to the group.
 *             Players who pick "I'm in" are registered; removing the vote drops
 *             them again. Registration stays open until the host starts.
 *  running    The host sends `.start <password>` in the group. Every registered
 *             player then gets each question as a *private DM poll* in batches
 *             of 10 with a random min/max delay between batches.
 *  finished   After the last question the podium is posted and winners tagged.
 *
 * Timing is per player, never per question: a player's clock starts at the
 * delivery receipt (capped at sent + 10s), and scoring is
 * round(1000 * (1 - (seconds / limit) / 2)) for a correct answer — see
 * scoring.mjs.
 *
 * Everything is persisted (games / game_players / question_sends / answers)
 * through the shared dual store, so a restart re-arms scheduled games, keeps the
 * lobby open and resumes a running question without double-sending.
 */

import { calcScore, elapsedSeconds, isCorrect, questionStartMs } from "./scoring.mjs";
import { bareJid, identityPair } from "./identity.js";
import {
  creatorCandidates,
  decryptVoteWithCandidates,
  voterCandidates,
  voteIndexes,
} from "./poll-crypto.js";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_DELAY,
  DEFAULT_MIN_DELAY,
  pollName,
} from "../db/game.js";

/** `.start <password>` (optionally `.start@1234 password`). */
const START_COMMAND = /^\.start(?:@\S+)?(?:\s+(.+))?$/i;
/** WhatsApp status code for a delivery receipt. */
const DELIVERY_ACK = 3;
/** Extra window (ms) a player has after their personal limit before 0 points. */
const QUESTION_GRACE_MS = 3000;
/** Max random gap (ms) between two DMs inside one batch. */
const INTRA_BATCH_JITTER_MS = 500;
/** Pause after a question's results before the next one. */
const BETWEEN_QUESTIONS_MS = 6000;
/** Delay after `.start` before the first question goes out. */
const START_DELAY_MS = 1500;
/** Join poll options. */
const JOIN_YES = "I'm in";
const JOIN_OPTIONS = [JOIN_YES, "Not this time"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Random integer in [min, max] (inclusive), tolerant of swapped bounds. */
function randomBetween(min, max) {
  const lo = Math.max(0, Math.floor(Math.min(min, max)));
  const hi = Math.max(0, Math.floor(Math.max(min, max)));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** The linked account's own bare jid. */
function ownAccountJid(connection) {
  const id = connection?.user?.id ?? connection?.sock?.user?.id;
  return typeof id === "string" ? bareJid(id) : null;
}

/** The linked account's own LID (raw, may carry a device suffix). */
function ownAccountLid(connection) {
  const lid =
    connection?.user?.lid ??
    connection?.sock?.user?.lid ??
    connection?.authState?.creds?.me?.lid ??
    null;
  return typeof lid === "string" ? lid : null;
}

/** A timestamp value (Date | ISO string | ms) as milliseconds, or null. */
function toMs(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.getTime();
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The digits of a jid before "@" (used to render @mentions). */
function jidUser(jid) {
  return String(jid ?? "").split("@")[0].split(":")[0];
}

/** A display name: the push name, else the phone digits. */
function displayName(name, jid) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return trimmed || jidUser(jid) || "Player";
}

/**
 * Builds the RoninClash engine. Returns
 * `{ stop, schedule, cancel, resume, handleMessage, handlePollVote, handleReceipt }`
 * or null when unwired.
 */
export function createGameEngine({
  connection,
  store,
  questionGraceMs = QUESTION_GRACE_MS,
  betweenQuestionsMs = BETWEEN_QUESTIONS_MS,
  startDelayMs = START_DELAY_MS,
  intraBatchJitterMs = INTRA_BATCH_JITTER_MS,
} = {}) {
  if (!connection || !store) return null;

  /** gameId -> { chain, watch, timers:Set, closed:Set } */
  const runtimes = new Map();

  function runtime(gameId) {
    let rt = runtimes.get(gameId);
    if (!rt) {
      rt = { chain: Promise.resolve(), watch: null, timers: new Set(), closed: new Set() };
      runtimes.set(gameId, rt);
    }
    return rt;
  }

  /** Serializes work per game so votes and timers never interleave. */
  function enqueue(gameId, fn) {
    const rt = runtime(gameId);
    rt.chain = rt.chain
      .catch(() => {})
      .then(fn)
      .catch((err) => connection.emit?.("failure", err));
    return rt.chain;
  }

  /** setTimeout tracked on the game runtime so stop() can clear it. */
  function later(gameId, fn, ms) {
    const rt = runtime(gameId);
    const timer = setTimeout(() => {
      rt.timers.delete(timer);
      Promise.resolve()
        .then(fn)
        .catch((err) => connection.emit?.("failure", err));
    }, Math.max(0, ms));
    rt.timers.add(timer);
    return timer;
  }

  function emitGame(gameId, action, extra = {}) {
    connection.emit?.("game", { gameId, action, at: Date.now(), ...extra });
  }

  /* ------------------------------- sending ------------------------------- */

  /** Sends a group message (`{ text, mentions }`), swallowing send errors. */
  async function sendGroup(game, content) {
    try {
      return await connection.sendMessage(game.group_jid, content);
    } catch (err) {
      connection.emit?.("failure", err);
      return null;
    }
  }

  /**
   * Sends a DM to a player, retrying with the alternate jid form (LID vs phone
   * number) when the first address fails. Polls go through sendPoll; plain text
   * uses sendMessage.
   */
  async function sendDm(game, playerJid, content, { poll = false } = {}) {
    const targets = [playerJid];
    const pair = identityPair(playerJid, null);
    if (pair.lid) {
      try {
        const meta = await connection.groupMetadata?.(game.group_jid);
        const participant = (meta?.participants ?? []).find((p) => {
          const pp = identityPair(p.id, p.lid);
          return pp.lid === pair.lid || pp.pn === playerJid;
        });
        if (participant?.phoneNumber) {
          const digits = String(participant.phoneNumber).replace(/\D/g, "");
          if (digits) targets.push(`${digits}@s.whatsapp.net`);
        }
      } catch {
        // metadata is best-effort; fall through with the original target
      }
    }
    let lastError = null;
    for (const target of [...new Set(targets)]) {
      try {
        if (poll) return await connection.sendPoll(target, content);
        return await connection.sendMessage(target, content);
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) connection.emit?.("failure", lastError);
    return null;
  }

  /** Sends one question poll to a player and records its secret. */
  async function sendQuestionPoll(game, question, index, player) {
    const options = (question.options ?? []).map((o) => String(o));
    const selectableCount = question.multi ? options.length : 1;
    const result = await sendDm(
      game,
      player.jid,
      { question: pollName(question.question), options, selectableCount },
      { poll: true }
    );
    const pollId = result?.key?.id;
    if (!pollId) return null;
    await store.createQuestionSend({
      gameId: game.id,
      questionIndex: index,
      playerJid: player.jid,
      pollMessageId: pollId,
      pollSecret: result.messageSecret.toString("base64"),
      sentAt: new Date().toISOString(),
    });
    return pollId;
  }

  /* ------------------------------ scheduling ----------------------------- */

  /**
   * Persists a validated game, announces it to the group and arms the start
   * timer. `valid` is the output of validateScheduleInput.
   */
  async function schedule(valid) {
    const game = await store.createGame({
      title: valid.title,
      groupJid: valid.groupJid,
      password: valid.password,
      startAt: valid.startAt,
      minDelaySeconds: valid.minDelaySeconds ?? DEFAULT_MIN_DELAY,
      maxDelaySeconds: valid.maxDelaySeconds ?? DEFAULT_MAX_DELAY,
      batchSize: valid.batchSize ?? DEFAULT_BATCH_SIZE,
      questions: valid.questions,
      hostJid: valid.hostJid ?? ownAccountJid(connection),
      status: "scheduled",
    });

    const when = valid.startAt ? new Date(valid.startAt) : null;
    const whenText =
      when && !Number.isNaN(when.getTime())
        ? when.toLocaleString("en-GB", { timeZone: "UTC", hour12: false })
        : "soon";
    await sendGroup(
      { group_jid: valid.groupJid },
      {
        text:
          `🎮 *RoninClash* — "${game.title}" is scheduled for ${whenText} UTC.\n` +
          `A join poll will be posted here at that time. Answer "${JOIN_YES}" to play.`,
      }
    );

    arm(game.id);
    emitGame(game.id, "scheduled", { game });
    return game;
  }

  /** Deletes a game and clears its runtime. */
  async function cancel(gameId) {
    const rt = runtimes.get(gameId);
    if (rt) {
      if (rt.watch) clearInterval(rt.watch);
      for (const timer of rt.timers) clearTimeout(timer);
      runtimes.delete(gameId);
    }
    const removed = await store.deleteGame(gameId);
    if (removed) emitGame(gameId, "cancelled");
    return removed;
  }

  /* -------------------------------- lobby -------------------------------- */

  /** Opens the lobby: posts the join poll and flips the game to "lobby". */
  async function startLobby(gameId) {
    const game = await store.getGameRow(gameId);
    if (!game || game.status !== "scheduled") return;
    const result = await sendDm(
      { group_jid: game.group_jid },
      game.group_jid,
      {
        question: `🎮 RoninClash: "${game.title}" — are you in?`,
        options: JOIN_OPTIONS,
        selectableCount: 1,
      },
      { poll: true }
    );
    const joinId = result?.key?.id ?? null;
    const joinSecret = result?.messageSecret ? result.messageSecret.toString("base64") : null;
    await store.updateGame(gameId, {
      status: "lobby",
      joinMessageId: joinId,
      joinMessageSecret: joinSecret,
    });
    await sendGroup(
      { group_jid: game.group_jid },
      {
        text:
          `🎮 *RoninClash* is open! Vote *${JOIN_YES}* on the poll to register.\n` +
          `The host starts the game with \`.start <password>\`.`,
      }
    );
    emitGame(gameId, "lobby", { joinMessageId: joinId });
  }

  /* --------------------------- registration votes ------------------------ */

  /** The device-stripped voter jid for storage/DMs: prefer a PN form. */
  function preferredPlayerJid(voters) {
    const unique = [...new Set((voters ?? []).filter(Boolean).map((jid) => bareJid(jid)))];
    for (const jid of unique) {
      if (identityPair(jid, null).pn) return jid;
    }
    return unique[0] ?? null;
  }

  /** Decryption candidates for one vote: key fields (raw+bare) + extras. */
  function voteCandidates(event) {
    return voterCandidates(event.rawKey, [
      event.voterJid,
      event.voterJidAlt,
      ...(event.voterCandidates ?? []),
    ]);
  }

  /** Handles a vote on a game's join poll. */
  async function handleJoinVote(game, event) {
    const ownJid = ownAccountJid(connection);
    const ownRaw = connection?.user?.id ?? connection?.sock?.user?.id ?? null;
    const ownLid = ownAccountLid(connection);
    const pollEncKey = game.join_message_secret
      ? Buffer.from(game.join_message_secret, "base64")
      : null;
    if (!pollEncKey || !ownJid) {
      console.warn(
        `[game] join vote dropped for game ${game.id}: ` +
          (pollEncKey ? "own account jid unknown" : "missing join_message_secret")
      );
      return;
    }
    const voters = voteCandidates(event);
    const creators = creatorCandidates(
      event.pollUpdateMessage?.pollCreationMessageKey,
      ownJid,
      ownRaw,
      ownLid ? bareJid(ownLid) : null,
      ownLid
    );
    const vote = decryptVoteWithCandidates(event.pollUpdateMessage?.vote, {
      pollMsgId: event.pollMessageId,
      pollEncKey,
      creators,
      voters,
    });
    if (!vote) {
      console.warn(
        `[game] join vote decrypt FAILED poll=${event.pollMessageId} game=${game.id} ` +
          `creators=[${creators.join(", ")}] voters=[${voters.join(", ")}]`
      );
      return;
    }
    const joined = voteIndexes({ options: JOIN_OPTIONS }, vote).includes(0); // "I'm in"
    const playerJid = preferredPlayerJid(voters);
    if (!playerJid) {
      console.warn(`[game] join vote has no voter jid poll=${event.pollMessageId}`);
      return;
    }
    if (joined) {
      await store.addGamePlayer(game.id, playerJid, event.voterName ?? null);
      const count = await store.countGamePlayers(game.id);
      console.log(
        `[game] ${event.voterName ?? playerJid} joined "${game.title}" ` +
          `(${count} player${count === 1 ? "" : "s"})`
      );
      emitGame(game.id, "joined", { playerJid, playerCount: count });
    } else {
      await store.removeGamePlayer(game.id, playerJid);
      const count = await store.countGamePlayers(game.id);
      console.log(`[game] ${playerJid} left "${game.title}" (${count} players)`);
      emitGame(game.id, "left", { playerJid, playerCount: count });
    }
  }

  /* ------------------------------ questions ------------------------------ */

  /** Records a player's answer for the current question (idempotent). */
  async function handleAnswerVote(send, event) {
    const game = await store.getGameRow(send.game_id);
    if (!game || game.status !== "running") return;
    const question = (game.questions ?? [])[send.question_index];
    if (!question) return;
    const ownJid = ownAccountJid(connection);
    const ownRaw = connection?.user?.id ?? connection?.sock?.user?.id ?? null;
    const ownLid = ownAccountLid(connection);
    const pollEncKey = send.poll_secret ? Buffer.from(send.poll_secret, "base64") : null;
    if (!pollEncKey || !ownJid) {
      console.warn(
        `[game] answer vote dropped poll=${send.poll_message_id}: ` +
          (pollEncKey ? "own account jid unknown" : "missing question_send secret")
      );
      return;
    }
    const voters = voteCandidates(event);
    const creators = creatorCandidates(
      event.pollUpdateMessage?.pollCreationMessageKey,
      ownJid,
      ownRaw,
      ownLid ? bareJid(ownLid) : null,
      ownLid
    );
    const vote = decryptVoteWithCandidates(event.pollUpdateMessage?.vote, {
      pollMsgId: send.poll_message_id,
      pollEncKey,
      creators,
      voters,
    });
    if (!vote) {
      console.warn(
        `[game] answer decrypt FAILED poll=${send.poll_message_id} game=${send.game_id} ` +
          `creators=[${creators.join(", ")}] voters=[${voters.join(", ")}]`
      );
      return;
    }
    const selected = voteIndexes(question, vote);
    const playerJid = send.player_jid;

    const existing = await store.getAnswer(game.id, send.question_index, playerJid);
    // `seconds !== null` marks an already-finalized answer (the question
    // closed). A straggler vote must never reopen or zero it.
    if (existing && existing.seconds !== null) return;
    // Single-answer: the first selection locks; later changes are ignored.
    if (existing && existing.selected.length && !question.multi) return;

    // Multi-answer: the latest selection *before* the player's personal
    // deadline wins (with the time of that last change). A change arriving
    // after it is dropped, keeping the last pre-deadline selection intact.
    const now = Date.now();
    const limitMs = Math.max(1, Number(question.timeLimit) || 20) * 1000;
    const startedAt = questionStartMs(toMs(send.sent_at), toMs(send.delivered_at));
    const deadline = (startedAt ?? now) + limitMs + questionGraceMs;
    if (question.multi && existing && existing.selected.length && now > deadline) return;

    await store.upsertAnswer({
      gameId: game.id,
      questionIndex: send.question_index,
      playerJid,
      selected,
      votedAt: now,
      points: 0,
      correct: false,
      seconds: null,
    });
    emitGame(game.id, "answer", {
      questionIndex: send.question_index,
      playerJid,
      selected,
    });
  }

  /** Sends every player the current question (batched) and starts the watch. */
  async function openQuestion(gameId, index) {
    const game = await store.getGameRow(gameId);
    if (!game || game.status !== "running") return;
    const questions = game.questions ?? [];
    if (index >= questions.length) return finishGame(gameId);
    const question = questions[index];
    await store.updateGame(gameId, { questionIndex: index });

    const players = await store.listGamePlayers(gameId);
    const alreadySent = new Set(
      (await store.listQuestionSends(gameId, index)).map((s) => s.player_jid)
    );
    const pending = players.filter((p) => !alreadySent.has(p.jid));
    const batchSize = Math.max(1, Number(game.batch_size) || DEFAULT_BATCH_SIZE);
    const minDelay = Number(game.min_delay_seconds) || DEFAULT_MIN_DELAY;
    const maxDelay = Number(game.max_delay_seconds) || DEFAULT_MAX_DELAY;

    // Spec: right after registration locks, the group is told "First question
    // sent" — posted before the DM batches go out.
    if (index === 0) {
      await sendGroup(
        { group_jid: game.group_jid },
        { text: "✅ *First question sent* — check your DM!" }
      );
    }

    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      for (let j = 0; j < batch.length; j += 1) {
        try {
          await sendQuestionPoll(game, question, index, batch[j]);
        } catch (err) {
          connection.emit?.("failure", err);
        }
        if (j < batch.length - 1) await sleep(randomBetween(0, intraBatchJitterMs));
      }
      if (i + batchSize < pending.length) {
        await sleep(randomBetween(minDelay, maxDelay) * 1000);
      }
    }

    await sendGroup(
      { group_jid: game.group_jid },
      {
        text: `❓ *Question ${index + 1}/${questions.length}* — sent to ${players.length} player(s). Check your DM!`,
      }
    );
    emitGame(gameId, "question", { questionIndex: index, count: players.length });
    watchQuestion(gameId, index, question);
  }

  /** Polls the question's deadlines and closes it when due (or all answered). */
  function watchQuestion(gameId, index, question) {
    const rt = runtime(gameId);
    if (rt.watch) clearInterval(rt.watch);
    const tick = () => {
      if (rt.closed.has(index)) return;
      maybeCloseQuestion(gameId, index, question)
        .then((done) => {
          if (!done) return;
          if (rt.watch) {
            clearInterval(rt.watch);
            rt.watch = null;
          }
          return enqueue(gameId, () => closeQuestion(gameId, index, question));
        })
        .catch((err) => connection.emit?.("failure", err));
    };
    rt.watch = setInterval(tick, 1000);
    tick();
  }

  /** True once the question should close (deadline passed, or all answered). */
  async function maybeCloseQuestion(gameId, index, question) {
    const players = await store.listGamePlayers(gameId);
    if (!players.length) return true;
    const sends = await store.listQuestionSends(gameId, index);
    if (!sends.length) return true;
    const byJid = new Map(sends.map((s) => [s.player_jid, s]));
    const answers = await store.listAnswers(gameId, index);
    const answered = new Set(answers.filter((a) => a.selected.length).map((a) => a.playerJid));
    const limitMs = Math.max(1, Number(question.timeLimit) || 20) * 1000;

    const now = Date.now();
    let maxDeadline = 0;
    let allAnswered = true;
    for (const player of players) {
      const send = byJid.get(player.jid);
      if (!send) continue; // never delivered; don't block the close
      const startedAt = questionStartMs(toMs(send.sent_at), toMs(send.delivered_at));
      const deadline = (startedAt ?? now) + limitMs + questionGraceMs;
      if (deadline > maxDeadline) maxDeadline = deadline;
      if (!answered.has(player.jid)) allAnswered = false;
    }
    if (maxDeadline && now >= maxDeadline) return true;
    if (!question.multi && allAnswered) return true;
    return false;
  }

  /** Finalizes a question: scores answers, DMs results, posts the leaderboard. */
  async function closeQuestion(gameId, index, question) {
    const rt = runtime(gameId);
    if (rt.closed.has(index)) return;
    rt.closed.add(index);
    if (rt.watch) {
      clearInterval(rt.watch);
      rt.watch = null;
    }

    const game = await store.getGameRow(gameId);
    if (!game) return;
    const players = await store.listGamePlayers(gameId);
    const sends = await store.listQuestionSends(gameId, index);
    const byJid = new Map(sends.map((s) => [s.player_jid, s]));
    const answers = await store.listAnswers(gameId, index);
    const answersByJid = new Map(answers.map((a) => [a.playerJid, a]));
    const limit = Math.max(1, Number(question.timeLimit) || 20);
    const correctText = (question.correct ?? []).map((i) => question.options[i]).join(", ");

    for (const player of players) {
      const send = byJid.get(player.jid);
      const answer = answersByJid.get(player.jid);
      // `seconds !== null` marks an already-finalized answer (restart safe).
      if (answer && answer.seconds !== null) continue;

      let correct = false;
      let points = 0;
      let seconds = 0;
      let late = false;
      if (answer && answer.selected.length && send) {
        const startedAt = questionStartMs(toMs(send.sent_at), toMs(send.delivered_at));
        const votedAt = answer.votedAt ?? Date.now();
        seconds = Math.max(0, elapsedSeconds(startedAt ?? votedAt, votedAt));
        // The personal deadline: startedAt + time limit + grace. WhatsApp
        // polls have no native timer, so a vote after it scores 0 however
        // correct the selection is ("wrong or late is 0").
        const deadline = (startedAt ?? votedAt) + limit * 1000 + questionGraceMs;
        late = votedAt > deadline;
        correct = !late && isCorrect(answer.selected, question.correct);
        if (correct) points = calcScore(seconds, limit);
      }

      await store.upsertAnswer({
        gameId,
        questionIndex: index,
        playerJid: player.jid,
        selected: answer?.selected ?? [],
        votedAt: answer?.votedAt ?? null,
        points,
        correct,
        seconds,
      });
      if (points > 0) {
        await store.addPlayerScore(gameId, player.jid, {
          points,
          correct,
          timeMs: Math.round(seconds * 1000),
        });
      }

      let resultLine;
      if (!answer || !answer.selected.length) {
        resultLine = `⏰ Time's up — you didn't answer. The answer was *${correctText}*.`;
      } else if (late) {
        resultLine = `⏱ Too late — 0 points. The answer was *${correctText}*.`;
      } else if (correct) {
        resultLine = `✅ Correct! *+${points} points* (${seconds.toFixed(1)}s)`;
      } else {
        resultLine = `❌ Not quite. The answer was *${correctText}*.`;
      }
      await sendDm(game, player.jid, { text: `Q${index + 1}: ${resultLine}` });
    }

    await store.closeQuestionSends(gameId, index);
    await postLeaderboard(game, index);
    later(gameId, () => advance(gameId, index), betweenQuestionsMs);
  }

  /** Posts the top-5 leaderboard to the group. */
  async function postLeaderboard(game, index) {
    const players = await store.listGamePlayers(game.id);
    if (!players.length) return;
    const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];
    const lines = players.slice(0, 5).map((p, i) => {
      const rank = medals[i] ?? `${i + 1}.`;
      return `${rank} ${displayName(p.name, p.jid)} — ${p.points} pts`;
    });
    const total = (game.questions ?? []).length;
    await sendGroup(
      { group_jid: game.group_jid },
      { text: `🏆 *Leaderboard* (after Q${index + 1}/${total})\n${lines.join("\n")}` }
    );
    emitGame(game.id, "leaderboard", { questionIndex: index });
  }

  /** Moves to the next question, or finishes the game. */
  async function advance(gameId, index) {
    const game = await store.getGameRow(gameId);
    if (!game || game.status !== "running") return;
    if (index + 1 >= (game.questions ?? []).length) return finishGame(gameId);
    await openQuestion(gameId, index + 1);
  }

  /** Posts the final podium and marks the game finished. */
  async function finishGame(gameId) {
    const game = await store.getGameRow(gameId);
    if (!game || game.status === "finished") return;
    const players = await store.listGamePlayers(gameId);
    await store.updateGame(gameId, { status: "finished" });
    if (!players.length) {
      await sendGroup(
        { group_jid: game.group_jid },
        { text: `🏁 *RoninClash* "${game.title}" finished — no players answered.` }
      );
      emitGame(gameId, "finished");
      return;
    }
    const podium = players.slice(0, 3);
    const medals = ["🥇", "🥈", "🥉"];
    const lines = podium.map((p, i) => `${medals[i]} ${displayName(p.name, p.jid)} — ${p.points} pts`);
    const winners = podium.map((p) => p.jid);
    const mentions = winners.map((jid) => `@${jidUser(jid)}`).join(" ");
    await sendGroup(
      { group_jid: game.group_jid },
      {
        text:
          `🎉 *RoninClash* "${game.title}" has finished!\n\n` +
          `*Final podium*\n${lines.join("\n")}\n\n` +
          `Congratulations ${mentions}!`,
        mentions: winners,
      }
    );
    emitGame(gameId, "finished", { winners });
  }

  /* -------------------------------- resume ------------------------------- */

  /** Re-arms a game after a restart based on its persisted status. */
  async function arm(gameId) {
    const game = await store.getGameRow(gameId);
    if (!game) return;
    if (game.status === "scheduled") {
      const at = toMs(game.start_at);
      later(gameId, () => startLobby(gameId), at ? at - Date.now() : 0);
    } else if (game.status === "lobby") {
      if (!game.join_message_id) later(gameId, () => startLobby(gameId), 0);
    } else if (game.status === "running") {
      const index = Number(game.question_index) || 0;
      later(gameId, () => openQuestion(gameId, index), 3000);
    }
  }

  /** Re-arms every active game (call once, after the socket opens). */
  async function resume() {
    let games = [];
    try {
      games = await store.listActiveGames();
    } catch (err) {
      connection.emit?.("failure", err);
      return;
    }
    for (const game of games) arm(game.id);
  }

  /* ------------------------------ host start ----------------------------- */

  /** Handles a `.start <password>` group message. */
  async function handleMessage(message) {
    if (!message?.isGroup || message.fromMe) return;
    if (!message.chat) return;
    const text = typeof message.text === "string" ? message.text.trim() : "";
    const match = START_COMMAND.exec(text);
    if (!match) return;
    const password = (match[1] ?? "").trim();
    await enqueue(message.chat, () => startFromCommand(message, password));
  }

  /**
   * Validates a start command and, when allowed, begins the game. Returns a
   * `{ ok, reason }` result (exposed for tests).
   */
  async function startFromCommand(message, password) {
    let candidates = [];
    try {
      candidates = (await store.listActiveGames()).filter(
        (g) => (g.status === "scheduled" || g.status === "lobby") && g.group_jid === message.chat
      );
    } catch (err) {
      connection.emit?.("failure", err);
      return { ok: false, reason: "storage" };
    }
    const lobby = candidates.find((g) => g.status === "lobby") ?? candidates[0];
    if (!lobby) return { ok: false, reason: "no-game" };

    const sender = bareJid(message.sender ?? "");
    if (!password || password !== lobby.password) {
      await sendGroup({ group_jid: lobby.group_jid }, { text: "❌ Wrong start password." });
      return { ok: false, reason: "password" };
    }

    const playerCount = await store.countGamePlayers(lobby.id);
    if (playerCount < 1) {
      await sendGroup(
        { group_jid: lobby.group_jid },
        { text: "❌ No players have joined yet — vote \"I'm in\" on the join poll first." }
      );
      return { ok: false, reason: "no-players" };
    }

    // Only the host (the account that scheduled it) or a group admin may start.
    const isHost = Boolean(lobby.host_jid && sender && bareJid(lobby.host_jid) === sender);
    let isAdmin = false;
    try {
      isAdmin = connection.participantIsAdmin
        ? await connection.participantIsAdmin(lobby.group_jid, sender)
        : false;
    } catch {
      isAdmin = false;
    }
    if (!isHost && !isAdmin) {
      await sendGroup(
        { group_jid: lobby.group_jid },
        { text: "❌ Only the host or a group admin can start the game." }
      );
      return { ok: false, reason: "not-allowed" };
    }

    // Lock registration (status no longer "lobby") and announce the players.
    await store.updateGame(lobby.id, { status: "running", questionIndex: 0 });
    const players = await store.listGamePlayers(lobby.id);
    const mentions = players.map((p) => p.jid);
    const tags = players.map((p) => `@${jidUser(p.jid)}`).join(" ");
    // Spec: the lock message carries the game title and tags every player.
    // The "First question sent" announcement follows separately, when
    // question 1 actually goes out (see openQuestion).
    await sendGroup(
      { group_jid: lobby.group_jid },
      {
        text:
          `🔒 *Registration closed* — "${lobby.title}"\n` +
          `*${players.length}* player(s) in:\n${tags}`,
        mentions,
      }
    );
    emitGame(lobby.id, "started", { playerCount: players.length });
    later(lobby.id, () => openQuestion(lobby.id, 0), startDelayMs);
    return { ok: true, gameId: lobby.id };
  }

  /* ------------------------------- events -------------------------------- */

  /** A poll vote: a join vote or a question answer. */
  async function handlePollVote(event) {
    if (!event?.pollMessageId) return;
    let joinGame = null;
    let active = [];
    try {
      active = await store.listActiveGames();
      for (const game of active) {
        if (game.status !== "lobby" && game.status !== "scheduled") continue;
        if (game.join_message_id && game.join_message_id === event.pollMessageId) {
          joinGame = game;
          break;
        }
      }
    } catch (err) {
      connection.emit?.("failure", err);
      return;
    }
    if (joinGame) {
      await enqueue(joinGame.id, () => handleJoinVote(joinGame, event));
      return;
    }
    const send = await store.getQuestionSendByPollId(event.pollMessageId);
    if (send) {
      await enqueue(send.game_id, () => handleAnswerVote(send, event));
      return;
    }
    // Not one of ours — only worth a line while games are running, otherwise
    // every unrelated poll in the bot's groups would spam the console.
    if (active.length) {
      console.warn(
        `[game] vote for poll ${event.pollMessageId} matched none of ` +
          `${active.length} active game(s)`
      );
    }
  }

  /** A delivery receipt: starts a player's personal question clock. */
  async function handleReceipt(event) {
    if (!event?.id || !(Number(event.status) >= DELIVERY_ACK)) return;
    let send = null;
    try {
      send = await store.getQuestionSendByPollId(event.id);
    } catch (err) {
      connection.emit?.("failure", err);
      return;
    }
    if (!send || send.delivered_at) return;
    try {
      await store.markQuestionSendDelivered(event.id, new Date().toISOString());
    } catch (err) {
      connection.emit?.("failure", err);
    }
  }

  /* ------------------------------- wiring -------------------------------- */

  const onMessage = (message) => {
    handleMessage(message).catch((err) => connection.emit?.("failure", err));
  };
  const onPollVote = (event) => {
    handlePollVote(event).catch((err) => connection.emit?.("failure", err));
  };
  const onReceipt = (event) => {
    handleReceipt(event).catch((err) => connection.emit?.("failure", err));
  };
  const onReady = () => {
    resume().catch((err) => connection.emit?.("failure", err));
  };

  connection.on?.("message", onMessage);
  connection.on?.("pollVote", onPollVote);
  connection.on?.("receipt", onReceipt);
  connection.on?.("ready", onReady);
  // If the engine is created after the socket is already open, re-arm now.
  if (connection.getStatus?.().state === "open") onReady();

  function stop() {
    connection.off?.("message", onMessage);
    connection.off?.("pollVote", onPollVote);
    connection.off?.("receipt", onReceipt);
    connection.off?.("ready", onReady);
    for (const rt of runtimes.values()) {
      if (rt.watch) clearInterval(rt.watch);
      for (const timer of rt.timers) clearTimeout(timer);
    }
    runtimes.clear();
  }

  return {
    stop,
    schedule,
    cancel,
    resume,
    handleMessage,
    handlePollVote,
    handleReceipt,
    startFromCommand,
  };
}
