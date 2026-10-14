import { test } from "node:test";
import assert from "node:assert/strict";

const {
  applyGroupPatch,
  applyParticipantDelta,
  groupInfoFromSnapshot,
  toGroupSnapshot,
} = await import("../src/whatsapp/group-snapshot.js");

const LID = "225159969521788@lid";
const PN = "2348052928072@s.whatsapp.net";
const GROUP = "120363412224156592@g.us";

function liveMeta(over = {}) {
  return {
    id: GROUP,
    subject: "Family",
    desc: "house stuff",
    owner: PN,
    ownerPn: PN,
    creation: 1700000000,
    size: 2,
    announce: true,
    restrict: true,
    isCommunity: false,
    ephemeralDuration: 86400,
    participants: [
      { id: LID, phoneNumber: PN, username: "josh", admin: "admin" },
      { id: "5599887766@s.whatsapp.net", username: "bob" },
    ],
    ...over,
  };
}

test("toGroupSnapshot maps live metadata onto the stored shape", () => {
  const snap = toGroupSnapshot(liveMeta());
  assert.deepEqual(snap, {
    jid: GROUP,
    name: "Family",
    description: "house stuff",
    owner: PN,
    ownerPn: PN,
    createdAt: new Date(1700000000 * 1000).toISOString(),
    size: 2,
    announce: true,
    restrict: true,
    isCommunity: false,
    ephemeralDuration: 86400,
    participants: [
      { id: LID, username: "josh", phone: "2348052928072", admin: "admin" },
      { id: "5599887766@s.whatsapp.net", username: "bob", phone: "5599887766", admin: null },
    ],
  });
});

test("toGroupSnapshot tolerates missing/blank fields and no participants", () => {
  const snap = toGroupSnapshot({ id: GROUP, subject: "   ", participants: undefined });
  assert.equal(snap.name, null);
  assert.equal(snap.description, null);
  assert.equal(snap.owner, null);
  assert.equal(snap.createdAt, null);
  assert.equal(snap.size, 0);
  assert.deepEqual(snap.participants, []);
  assert.equal(toGroupSnapshot(null), null);
});

test("applyParticipantDelta adds, removes, promotes and demotes", () => {
  const base = toGroupSnapshot(liveMeta());

  const added = applyParticipantDelta(base, "add", [
    { id: "555@s.whatsapp.net", notify: "Bob" },
  ]);
  assert.equal(added.participants.length, 3);
  assert.equal(added.size, 3);
  assert.equal(added.participants.at(-1).id, "555@s.whatsapp.net");

  // Removing by the LID form drops the LID member.
  const removedLid = applyParticipantDelta(base, "remove", [{ id: LID }]);
  assert.equal(removedLid.participants.length, 1);
  assert.equal(removedLid.participants[0].id, "5599887766@s.whatsapp.net");

  // Removing by the phone-number form still matches the LID participant.
  const removedPn = applyParticipantDelta(base, "remove", [{ id: PN }]);
  assert.equal(removedPn.participants.length, 1);
  assert.equal(removedPn.participants[0].id, "5599887766@s.whatsapp.net");

  const promoted = applyParticipantDelta(base, "promote", [{ id: PN }]);
  assert.equal(promoted.participants.find((p) => p.id === LID).admin, "admin");

  const demoted = applyParticipantDelta(base, "demote", [{ id: LID }]);
  assert.equal(demoted.participants.find((p) => p.id === LID).admin, null);
});

test("applyParticipantDelta never seeds a roster from a single event", () => {
  assert.equal(applyParticipantDelta(null, "add", [{ id: PN }]), null);
  const base = toGroupSnapshot(liveMeta());
  // An empty member list leaves the snapshot untouched.
  assert.deepEqual(applyParticipantDelta(base, "add", []), base);
});

test("applyGroupPatch only touches the fields present", () => {
  const base = toGroupSnapshot(liveMeta());
  const patched = applyGroupPatch(base, { id: GROUP, subject: "Renamed", announce: false });
  assert.equal(patched.name, "Renamed");
  assert.equal(patched.announce, false);
  assert.equal(patched.description, "house stuff", "absent fields keep their value");
  assert.equal(patched.participants.length, 2);
  assert.equal(applyGroupPatch(null, { subject: "x" }), null);
});

test("groupInfoFromSnapshot resolves participant names from the store", async () => {
  const snap = toGroupSnapshot(liveMeta());
  const store = { resolveChatName: async (jid) => (jid === LID ? "Joshua Ayeni" : null) };

  const group = await groupInfoFromSnapshot(snap, store);
  assert.deepEqual(group.participants[0], {
    id: LID,
    name: "Joshua Ayeni",
    username: "josh",
    phone: "2348052928072",
    admin: "admin",
  });
  assert.equal(group.participants[1].name, null);
  assert.equal(group.name, "Family");
  assert.equal(group.size, 2);
  assert.equal(group.owner, PN);
});

test("groupInfoFromSnapshot survives a throwing name lookup", async () => {
  const snap = toGroupSnapshot(liveMeta());
  const store = {
    resolveChatName: async () => {
      throw new Error("db down");
    },
  };
  const group = await groupInfoFromSnapshot(snap, store);
  assert.equal(group.participants[0].name, null);
});
