import { test } from "node:test";
import assert from "node:assert/strict";

const {
  bareJid,
  canonicalId,
  classify,
  clusterIdentities,
  contactIdentity,
  identityPair,
  isGroupJid,
  isLidJid,
  isPnJid,
  pairFromRaw,
} = await import("../src/whatsapp/identity.js");

const LID = "225159969521788@lid";
const PN = "2348052928072@s.whatsapp.net";

test("classify/type guards recognize lid, pn, group and other", () => {
  assert.equal(classify(LID), "lid");
  assert.equal(classify(PN), "pn");
  assert.equal(classify("123-456@g.us"), "group");
  assert.equal(classify("status@broadcast"), "other");
  assert.equal(classify(null), "other");

  assert.equal(isLidJid(LID), true);
  assert.equal(isPnJid(PN), true);
  assert.equal(isGroupJid("123-456@g.us"), true);
  assert.equal(isLidJid(PN), false);
});

test("bareJid strips the device suffix but keeps the server", () => {
  assert.equal(bareJid("2348052928072:11@s.whatsapp.net"), PN);
  assert.equal(bareJid("2348052928072@s.whatsapp.net"), PN);
  assert.equal(bareJid("no-at-sign"), "no-at-sign");
});

test("identityPair accepts either order and both halves", () => {
  assert.deepEqual(identityPair(LID, PN), { lid: LID, pn: PN });
  assert.deepEqual(identityPair(PN, LID), { lid: LID, pn: PN });
  assert.deepEqual(identityPair(PN), { lid: null, pn: PN });
  assert.deepEqual(identityPair(LID), { lid: LID, pn: null });
  assert.deepEqual(identityPair("123-456@g.us"), { lid: null, pn: null });
});

test("canonicalId prefers the LID, then the PN, then the raw jid", () => {
  assert.equal(canonicalId(LID, PN), LID);
  assert.equal(canonicalId(PN, LID), LID);
  assert.equal(canonicalId(PN), PN);
  assert.equal(canonicalId("123-456@g.us"), "123-456@g.us");
});

test("contactIdentity reads the lid/phoneNumber fields and bare numbers", () => {
  assert.deepEqual(
    contactIdentity({ id: PN, lid: LID, phoneNumber: "2348052928072" }),
    { lid: LID, pn: PN }
  );
  assert.deepEqual(
    contactIdentity({ id: PN, phoneNumber: "2348052928072" }),
    { lid: null, pn: PN }
  );
  assert.deepEqual(contactIdentity({ id: LID }), { lid: LID, pn: null });
});

test("clusterIdentities unions pairs and picks the LID as canonical", () => {
  const map = clusterIdentities([
    { lid: LID, pn: PN },
    { lid: null, pn: "2348000000001@s.whatsapp.net" },
  ]);
  assert.equal(map.get(LID), LID);
  assert.equal(map.get(PN), LID);
  assert.equal(
    map.get("2348000000001@s.whatsapp.net"),
    "2348000000001@s.whatsapp.net"
  );
});

test("clusterIdentities merges a chain of pairs into one person", () => {
  const map = clusterIdentities([
    { lid: LID, pn: PN },
    { lid: LID, pn: "2348000000009@s.whatsapp.net" },
  ]);
  assert.equal(map.get(PN), LID);
  assert.equal(map.get("2348000000009@s.whatsapp.net"), LID);
});

test("pairFromRaw extracts 1:1 pairs and ignores groups", () => {
  assert.deepEqual(
    pairFromRaw({ key: { remoteJid: LID, remoteJidAlt: PN } }),
    { lid: LID, pn: PN }
  );
  assert.deepEqual(
    pairFromRaw({ key: { remoteJid: PN, fromMe: true } }),
    { lid: null, pn: PN }
  );
  assert.equal(pairFromRaw({ key: { remoteJid: "123-456@g.us", participant: PN } }), null);
  assert.equal(pairFromRaw(null), null);
});
