/**
 * Poll-vote helpers for RoninClash.
 *
 * Three concerns live here because they share one hard-won understanding of
 * WhatsApp's poll wire format:
 *
 * 1. `voterCandidates` / `creatorCandidates` — `decryptPollVote` HMACs the
 *    EXACT strings WhatsApp signed with (`pollCreatorJid`/`voterJid` as
 *    Baileys' `getKeyAuthor` spells them: participantAlt → remoteJidAlt →
 *    participant → remoteJid, raw or device-stripped; jid-normalised meId for
 *    our own polls). The payload doesn't say which spelling was used, so we
 *    build a small ordered candidate list and try them all — each attempt is
 *    one HMAC + GCM (microseconds).
 * 2. `decryptVoteWithCandidates` — the attempt loop; returns the decoded vote
 *    or null (the caller logs the candidates it tried).
 * 3. `optionKey` / `voteIndexes` — `PollVoteMessage.selectedOptions` is
 *    `repeated bytes`: raw sha256(optionText) digests, NOT `{ name }` objects.
 *    Both sides are normalised to hex (lossless), so a selection matches
 *    exactly when its digest equals ours.
 */

import { decryptPollVote, sha256 } from "@whiskeysockets/baileys";
import { bareJid } from "./identity.js";

/** Baileys' getKeyAuthor: first truthy field, in this exact order. */
const KEY_AUTHOR_ORDER = ["participantAlt", "remoteJidAlt", "participant", "remoteJid"];

/** Raw then device-stripped spellings, field priority preserved, deduped. */
function jidForms(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value) continue;
    const bare = bareJid(value);
    for (const form of [value, bare]) {
      if (!form || seen.has(form)) continue;
      seen.add(form);
      out.push(form);
    }
  }
  return out;
}

/**
 * Ordered voter-jid candidates from the VOTE message key (plus any extras the
 * connection already collected), each in raw and device-stripped form.
 */
export function voterCandidates(rawKey, extras = []) {
  const ordered = [
    ...KEY_AUTHOR_ORDER.map((field) => rawKey?.[field]),
    ...(Array.isArray(extras) ? extras : []),
  ];
  return jidForms(ordered);
}

/**
 * Ordered creator-jid candidates from the poll CREATION message key plus the
 * linked account's own jids (`ownJid` bare, `ownJidRaw` with any device
 * suffix, `ownLid`/`ownLidRaw` likewise). `getKeyAuthor` uses meId when the
 * creation key is fromMe (our polls), otherwise its participant/remote
 * fields — every spelling is tried, cheapest-first.
 *
 * DM polls are LID-addressed, so WhatsApp signs them with the bot's LID
 * (e.g. `50153088094314@lid`) while group polls use the PN
 * (`2348...@s.whatsapp.net`). Both must be tried or DM votes never decrypt.
 */
export function creatorCandidates(
  creationKey,
  ownJid,
  ownJidRaw = null,
  ownLid = null,
  ownLidRaw = null
) {
  const ownForms = jidForms([ownJid, ownJidRaw, ownLid, ownLidRaw].filter(Boolean));
  const fromKey = KEY_AUTHOR_ORDER.map((field) => creationKey?.[field]).filter(Boolean);
  return jidForms(creationKey?.fromMe ? [...ownForms, ...fromKey] : [...fromKey, ...ownForms]);
}

/**
 * Tries every (creator × voter) pair against `decryptPollVote`.
 * Returns the decoded vote, or null when no combination verifies.
 */
export function decryptVoteWithCandidates(vote, { pollMsgId, pollEncKey, creators, voters }) {
  // Missing payload fields are rejected by decryptPollVote itself inside the
  // per-pair try/catch, so stub/partial payloads behave identically everywhere.
  if (!vote || !pollEncKey) return null;
  for (const pollCreatorJid of creators) {
    for (const voterJid of voters) {
      if (!pollCreatorJid || !voterJid) continue;
      try {
        const decoded = decryptPollVote(
          { encPayload: vote.encPayload, encIv: vote.encIv },
          { pollCreatorJid, pollMsgId, pollEncKey, voterJid }
        );
        if (decoded) return decoded;
      } catch {
        // wrong spelling for this pair — keep trying
      }
    }
  }
  return null;
}

/**
 * One selected option -> a hex key comparable against `optionKey` of the
 * question's option texts.
 *
 * Real votes carry raw digest bytes (`repeated bytes`); a `{ name }` object or
 * an already-hex string is tolerated for stubs/legacy shapes.
 */
export function optionKey(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("hex");
  }
  if (typeof value === "string") return value; // assumed to already be hex
  if (typeof value === "object" && "name" in value) return optionKey(value.name);
  return null;
}

/** sha256(optionText) as a hex key — the same transform for votes and keys. */
export function optionKeyForText(text) {
  return sha256(Buffer.from(String(text))).toString("hex");
}

/**
 * Maps a decrypted vote onto the question's option indexes. Returns [] when
 * nothing matched — callers treat that as "no selection".
 */
export function voteIndexes(question, vote) {
  const wanted = new Set(
    (vote?.selectedOptions ?? []).map(optionKey).filter(Boolean)
  );
  const out = [];
  (question?.options ?? []).forEach((option, index) => {
    if (wanted.has(optionKeyForText(option))) out.push(index);
  });
  return out;
}
