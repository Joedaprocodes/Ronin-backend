// Real-Baileys poll crypto round trip.
//
// IMPORTANT: this file deliberately does NOT import helpers/loader.mjs — it
// must see the REAL @whiskeysockets/baileys (decryptPollVote, sha256), not the
// stub the engine tests swap in. A vote is encrypted exactly the way WhatsApp
// does it (the inverse of Baileys' decryptPollVote, process-message.js:146)
// and then decrypted + option-mapped through our helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";

const { sha256 } = await import("@whiskeysockets/baileys");
const {
  voterCandidates,
  creatorCandidates,
  decryptVoteWithCandidates,
  voteIndexes,
} = await import("../src/whatsapp/poll-crypto.js");

const POLL_ID = "3BCA1F0E9D8C7B6A5E4D3C2B1A090807";
const ENC_KEY = randomBytes(32);
const CREATOR = "1001@s.whatsapp.net";

/** sha256 digest of an option text, as WhatsApp puts it in a vote. */
const digest = (text) => sha256(Buffer.from(text));

/**
 * PollVoteMessage = repeated bytes selectedOptions (WAProto encode:
 * `w.uint32(10).bytes(digest)` -> tag 0x0A, length, bytes).
 */
function encodePollVote(digests) {
  return Buffer.concat(
    digests.map((d) => Buffer.concat([Buffer.from([0x0a, d.length]), d]))
  );
}

/** The exact inverse of Baileys' decryptPollVote. */
function encryptPollVote({ pollMsgId, pollCreatorJid, voterJid, pollEncKey }, digests) {
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(pollCreatorJid),
    Buffer.from(voterJid),
    Buffer.from("Poll Vote"),
    new Uint8Array([1]),
  ]);
  const key0 = createHmac("sha256", Buffer.alloc(32)).update(pollEncKey).digest();
  const decKey = createHmac("sha256", key0).update(sign).digest();
  const iv = randomBytes(12);
  const aad = Buffer.from(`${pollMsgId}\u0000${voterJid}`);
  const cipher = createCipheriv("aes-256-gcm", decKey, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(encodePollVote(digests)), cipher.final()]);
  return { encPayload: Buffer.concat([body, cipher.getAuthTag()]), encIv: iv };
}

const tryDecrypt = (enc, creators, voters, pollEncKey = ENC_KEY) =>
  decryptVoteWithCandidates(enc, { pollMsgId: POLL_ID, pollEncKey, creators, voters });

test("round-trips a single-answer join vote through the real decryptPollVote", () => {
  const enc = encryptPollVote(
    { pollMsgId: POLL_ID, pollCreatorJid: CREATOR, voterJid: "2002@lid", pollEncKey: ENC_KEY },
    [digest("I'm in")]
  );
  const vote = tryDecrypt(
    enc,
    creatorCandidates({ fromMe: true }, CREATOR),
    voterCandidates({ participant: "2002@lid" })
  );
  assert.ok(vote, "vote decrypts with getKeyAuthor-derived candidates");
  assert.deepEqual(
    voteIndexes({ options: ["I'm in", "Not this time"] }, vote),
    [0],
    "raw digest bytes map back to option 0"
  );
});

test("matches votes signed with device-suffixed or bare spellings", () => {
  const enc = encryptPollVote(
    {
      pollMsgId: POLL_ID,
      pollCreatorJid: CREATOR,
      voterJid: "2002:17@lid", // signed with the RAW participant
      pollEncKey: ENC_KEY,
    },
    [digest("Paris"), digest("Rome")]
  );
  const voters = voterCandidates({ participant: "2002:17@lid" });
  assert.deepEqual(voters.slice(0, 2), ["2002:17@lid", "2002@lid"], "raw first, bare next");

  const vote = tryDecrypt(enc, [CREATOR], voters);
  assert.ok(vote, "raw spelling matches");
  assert.deepEqual(voteIndexes({ options: ["Paris", "Rome", "Berlin"] }, vote), [0, 1]);

  // Opposite direction: signed BARE while the key carries a device suffix.
  const encBare = encryptPollVote(
    { pollMsgId: POLL_ID, pollCreatorJid: CREATOR, voterJid: "2002@lid", pollEncKey: ENC_KEY },
    [digest("Rome")]
  );
  const voteBare = tryDecrypt(encBare, [CREATOR], voters);
  assert.ok(voteBare, "bare spelling matches via the second candidate");
  assert.deepEqual(voteIndexes({ options: ["Paris", "Rome", "Berlin"] }, voteBare), [1]);
});

test("creator candidates cover fromMe and device-suffixed own jids", () => {
  const enc = encryptPollVote(
    { pollMsgId: POLL_ID, pollCreatorJid: CREATOR, voterJid: "2002@lid", pollEncKey: ENC_KEY },
    [digest("I'm in")]
  );
  // Own jid known only in raw (device) form -> bare form still derived.
  const creators = creatorCandidates({ fromMe: true }, null, "1001:3@s.whatsapp.net");
  assert.deepEqual(creators, ["1001:3@s.whatsapp.net", "1001@s.whatsapp.net"]);
  assert.ok(tryDecrypt(enc, creators, ["2002@lid"]), "bare creator derived from raw");

  // fromMe false: the creation key's own fields are preferred first.
  const fromKey = creatorCandidates({ fromMe: false, participant: CREATOR }, "9999@s.whatsapp.net");
  assert.equal(fromKey[0], CREATOR, "creation-key participant ranks before own jid");
  assert.ok(tryDecrypt(enc, fromKey, ["2002@lid"]));
});

test("decrypts DM votes signed with the bot LID (not the PN)", () => {
  const BOT_LID = "50153088094314@lid";
  const BOT_PN = "2348146858279@s.whatsapp.net";
  // A DM poll is LID-addressed, so WhatsApp signs the vote with the bot's
  // LID as pollCreatorJid — the exact failure seen live:
  // creators=[...PN..., playerLID] with no bot LID -> decrypt FAILED.
  const enc = encryptPollVote(
    { pollMsgId: POLL_ID, pollCreatorJid: BOT_LID, voterJid: "225159969521788@lid", pollEncKey: ENC_KEY },
    [digest("Paris")]
  );
  const pnOnly = creatorCandidates({ fromMe: true }, BOT_PN, "2348146858279:12@s.whatsapp.net");
  assert.ok(!pnOnly.includes(BOT_LID), "PN-only candidates miss the LID");
  assert.equal(tryDecrypt(enc, pnOnly, ["225159969521788@lid"]), null, "PN-only fails like live");

  const withLid = creatorCandidates(
    { fromMe: true },
    BOT_PN,
    "2348146858279:12@s.whatsapp.net",
    BOT_LID,
    "50153088094314:12@lid"
  );
  assert.ok(withLid.includes(BOT_LID), "LID is tried");
  const vote = tryDecrypt(enc, withLid, ["225159969521788@lid"]);
  assert.ok(vote, "LID-signed DM vote decrypts once the bot LID is a candidate");
  assert.deepEqual(voteIndexes({ options: ["Paris", "Rome", "Berlin"] }, vote), [0]);
});

test("returns null (never throws) when no candidate matches", () => {
  const enc = encryptPollVote(
    { pollMsgId: POLL_ID, pollCreatorJid: CREATOR, voterJid: "7777@lid", pollEncKey: ENC_KEY },
    [digest("I'm in")]
  );
  const vote = tryDecrypt(enc, ["5@s.whatsapp.net"], ["6@s.whatsapp.net"]);
  assert.equal(vote, null);
  assert.equal(tryDecrypt(enc, [], ["6@s.whatsapp.net"]), null, "no candidates -> null");
  assert.equal(
    decryptVoteWithCandidates({ encPayload: null, encIv: null }, {
      pollMsgId: POLL_ID,
      pollEncKey: ENC_KEY,
      creators: [CREATOR],
      voters: ["2002@lid"],
    }),
    null,
    "missing payload -> null"
  );
});
