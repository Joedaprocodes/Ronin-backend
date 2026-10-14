import { canonicalId } from "./identity.js";

/**
 * Group metadata races WhatsApp: a live query costs a network round trip, and
 * asking for every group on every open risks rate limits. A *snapshot* is the
 * stable, WhatsApp-independent part of a group — subject, description, owner,
 * settings and the participant roster — so it can be persisted (Postgres in
 * production, SQLite locally) and kept current from socket broadcasts instead
 * of re-fetching.
 *
 * Participant display names are deliberately NOT stored: they are resolved
 * from the store at serve time (groupInfoFromSnapshot), so a contact rename
 * propagates without touching the snapshot.
 *
 * This module is pure (no Baileys, no store) so both the connection and the
 * API route share one mapping and it is directly unit-testable.
 */

/** Normalizes one Baileys participant onto the stored shape (no display name). */
function toParticipant(p) {
  const id = canonicalId(p.id, p.lid);
  // p.phoneNumber is already a JID; for PN participants the id itself is one.
  const phoneSrc = p.phoneNumber ?? (id.endsWith("@s.whatsapp.net") ? id : null);
  return {
    id,
    username: typeof p.username === "string" && p.username ? p.username : null,
    phone: phoneSrc ? String(phoneSrc).replace(/\D/g, "") || null : null,
    admin: typeof p.admin === "string" && p.admin ? p.admin : null,
  };
}

/**
 * Maps live Baileys group metadata onto a snapshot. Mirrors the public
 * group-info shape (the API's groupInfoFromSnapshot turns this back into a
 * response) minus the resolved participant names.
 */
export function toGroupSnapshot(meta) {
  if (!meta || !meta.id) return null;
  return {
    jid: meta.id,
    name: typeof meta.subject === "string" && meta.subject.trim() ? meta.subject : null,
    description: typeof meta.desc === "string" && meta.desc.trim() ? meta.desc : null,
    owner: meta.owner ? canonicalId(meta.owner, meta.ownerPn) : null,
    ownerPn: meta.ownerPn ? canonicalId(meta.ownerPn) : null,
    createdAt: Number.isInteger(meta.creation)
      ? new Date(meta.creation * 1000).toISOString()
      : null,
    size: Number.isInteger(meta.size) ? meta.size : (meta.participants?.length ?? 0),
    announce: Boolean(meta.announce),
    restrict: Boolean(meta.restrict),
    isCommunity: Boolean(meta.isCommunity),
    ephemeralDuration: Number.isInteger(meta.ephemeralDuration) ? meta.ephemeralDuration : null,
    participants: (meta.participants ?? []).map(toParticipant),
  };
}

/** Whether two participant records are the same person (id or phone match). */
function sameParticipant(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  return Boolean(a.phone && b.phone && a.phone === b.phone);
}

/**
 * Applies a membership delta (add/remove/promote/demote) to a snapshot and
 * returns a new snapshot. Deltas arrive as socket broadcasts, so this keeps
 * the cached roster current without asking WhatsApp.
 *
 * Returns null when handed no snapshot — a partial roster is never seeded from
 * a single membership event (that would serve a group as if it had one member).
 * The connect-time warm or the next live fetch creates the real snapshot.
 */
export function applyParticipantDelta(snapshot, action, participants) {
  if (!snapshot) return null;
  const members = (participants ?? []).map(toParticipant).filter((p) => p.id);
  if (!members.length) return snapshot;
  const existing = Array.isArray(snapshot.participants) ? snapshot.participants : [];
  let next;

  if (action === "add") {
    next = existing.map((p) => ({ ...p }));
    for (const m of members) {
      const i = next.findIndex((p) => sameParticipant(p, m));
      if (i === -1) next.push(m);
      else next[i] = { ...next[i], ...m, admin: m.admin ?? next[i].admin };
    }
  } else if (action === "remove") {
    next = existing.filter((p) => !members.some((m) => sameParticipant(p, m)));
  } else if (action === "promote" || action === "demote") {
    const admin = action === "promote" ? "admin" : null;
    next = existing.map((p) =>
      members.some((m) => sameParticipant(p, m)) ? { ...p, admin } : { ...p }
    );
  } else {
    return snapshot;
  }

  return { ...snapshot, participants: next, size: next.length };
}

/**
 * Patches the scalar fields an existing snapshot when a groups.update event
 * (a rename, description/announce/restrict change...) carries them. Only the
 * fields actually present are touched; absent fields keep their value.
 *
 * `snapshot === null` returns null: a partial event never seeds a snapshot.
 * Full metadata (groups.upsert) goes through toGroupSnapshot instead.
 */
export function applyGroupPatch(snapshot, item) {
  if (!snapshot || !item) return null;
  const next = { ...snapshot };
  if (typeof item.subject === "string" && item.subject.trim()) next.name = item.subject.trim();
  if (typeof item.desc === "string" && item.desc.trim()) next.description = item.desc.trim();
  if (item.owner) next.owner = canonicalId(item.owner, item.ownerPn);
  if (item.ownerPn) next.ownerPn = canonicalId(item.ownerPn);
  if (Number.isInteger(item.creation)) {
    next.createdAt = new Date(item.creation * 1000).toISOString();
  }
  if (Number.isInteger(item.size)) next.size = item.size;
  if (typeof item.announce === "boolean") next.announce = item.announce;
  if (typeof item.restrict === "boolean") next.restrict = item.restrict;
  if (typeof item.isCommunity === "boolean") next.isCommunity = item.isCommunity;
  if (Number.isInteger(item.ephemeralDuration)) next.ephemeralDuration = item.ephemeralDuration;
  return next;
}

/**
 * Turns a stored snapshot into the public GET /api/groups/:jid response,
 * resolving each participant's display name from the store (chat name first,
 * then @username, then phone digits — the UI applies the same fallback).
 */
export async function groupInfoFromSnapshot(snapshot, store) {
  if (!snapshot) return null;
  const participants = [];
  for (const p of snapshot.participants ?? []) {
    let name = null;
    if (store && typeof store.resolveChatName === "function") {
      try {
        name = await store.resolveChatName(p.id);
      } catch {
        name = null;
      }
    }
    participants.push({
      id: p.id,
      name,
      username: p.username ?? null,
      phone: p.phone ?? null,
      admin: p.admin ?? null,
    });
  }
  return {
    jid: snapshot.jid ?? null,
    name: snapshot.name ?? null,
    description: snapshot.description ?? null,
    owner: snapshot.owner ?? null,
    ownerPn: snapshot.ownerPn ?? null,
    createdAt: snapshot.createdAt ?? null,
    size: snapshot.size ?? participants.length,
    announce: Boolean(snapshot.announce),
    restrict: Boolean(snapshot.restrict),
    isCommunity: Boolean(snapshot.isCommunity),
    ephemeralDuration: snapshot.ephemeralDuration ?? null,
    participants,
  };
}
