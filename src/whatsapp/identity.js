/**
 * Pure JID classification + canonicalization, shared by the WhatsApp connection
 * and both stores. It deliberately has NO Baileys dependency (the module is
 * unit-tested and the connection's test loader swaps Baileys for a stub), so
 * the suffix checks below stand in for isLidUser/isPnUser.
 *
 * Why this exists: WhatsApp increasingly addresses people by LID
 * ("<digits>@lid") instead of their phone-number JID ("<digits>@s.whatsapp.net",
 * "PN"), and is moving toward usernames. A single contact can therefore arrive
 * as two different remoteJids, which used to split them into two chats. Here we
 * pick one *canonical* id per person — the LID when we know it, otherwise the
 * PN — and keep the other form as an alias so incoming and outgoing traffic
 * converge on a single conversation.
 */

const LID_SUFFIX = "@lid";
const PN_SUFFIX = "@s.whatsapp.net";
const GROUP_SUFFIX = "@g.us";

/** "12345@lid" -> true (the stable identity behind usernames). */
export function isLidJid(jid) {
  return typeof jid === "string" && jid.endsWith(LID_SUFFIX);
}

/** "2348...@s.whatsapp.net" -> true (the phone-number JID, "PN"). */
export function isPnJid(jid) {
  return typeof jid === "string" && jid.endsWith(PN_SUFFIX);
}

/** "12345-678@g.us" -> true. Groups are never LID/PN aliased. */
export function isGroupJid(jid) {
  return typeof jid === "string" && jid.endsWith(GROUP_SUFFIX);
}

/**
 * Drops a device suffix from a JID: "2348...:11@s.whatsapp.net" ->
 * "2348...@s.whatsapp.net". Non-JIDs (no "@") are returned unchanged.
 */
export function bareJid(jid) {
  if (typeof jid !== "string") return jid;
  const at = jid.indexOf("@");
  if (at === -1) return jid;
  const user = jid.slice(0, at).split(":")[0];
  return `${user}${jid.slice(at)}`;
}

/** "lid" | "pn" | "group" | "other". */
export function classify(jid) {
  const b = bareJid(jid);
  if (isGroupJid(b)) return "group";
  if (isLidJid(b)) return "lid";
  if (isPnJid(b)) return "pn";
  return "other";
}

/**
 * Extracts the { lid, pn } pair a 1:1 message may expose. Either half can be
 * null (a PN-only contact has no LID yet; a LID-only user hides their number).
 * Groups and unknown JIDs yield { lid: null, pn: null }.
 */
export function identityPair(remoteJid, altJid = null) {
  let lid = null;
  let pn = null;
  for (const jid of [remoteJid, altJid]) {
    const b = bareJid(jid);
    if (isLidJid(b)) lid ??= b;
    else if (isPnJid(b)) pn ??= b;
  }
  return { lid, pn };
}

/** Canonical chat id for a pair: LID first, then PN, then the raw jid. */
export function canonicalId(remoteJid, altJid = null) {
  const { lid, pn } = identityPair(remoteJid, altJid);
  return lid ?? pn ?? bareJid(remoteJid);
}

/**
 * Normalizes a `contacts.upsert` / `contacts.update` entry into a { lid, pn }
 * pair. `id` may itself be either form; `lid` is the explicit LID when present;
 * `phoneNumber` may be a bare number or a JID.
 */
export function contactIdentity({ id, lid, phoneNumber } = {}) {
  const pair = identityPair(id, lid);
  if (!pair.pn && phoneNumber) {
    const digits = String(phoneNumber).replace(/\D/g, "");
    if (digits.length >= 7) pair.pn = `${digits}${PN_SUFFIX}`;
  }
  return pair;
}

/**
 * Clusters observed { lid, pn } pairs into people and returns a Map of every
 * jid seen -> its canonical id (the LID member of the cluster when present,
 * otherwise the first member). Used to backfill identities from stored raw
 * payloads so already-split chats can be merged.
 */
export function clusterIdentities(pairs = []) {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    // path compression
    while (parent.get(x) !== root) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const { lid, pn } of pairs ?? []) {
    if (lid && pn) union(lid, pn);
    else if (lid) find(lid);
    else if (pn) find(pn);
  }

  const sets = new Map();
  for (const node of parent.keys()) {
    const root = find(node);
    if (!sets.has(root)) sets.set(root, []);
    sets.get(root).push(node);
  }

  const canonicalOf = new Map();
  for (const members of sets.values()) {
    const canonical = members.find(isLidJid) ?? members[0];
    for (const member of members) canonicalOf.set(member, canonical);
  }
  return canonicalOf;
}

/**
 * Pulls the { lid, pn } pair out of a stored raw Baileys payload. Returns null
 * for groups, non-1:1 messages and payloads without a usable jid.
 */
export function pairFromRaw(raw) {
  const key = raw?.key;
  const remoteJid = key?.remoteJid;
  if (!remoteJid || isGroupJid(remoteJid)) return null;
  const pair = identityPair(remoteJid, key?.remoteJidAlt);
  if (!pair.lid && !pair.pn) return null;
  return pair;
}
