/**
 * Shared contacts / broadcast-list helpers used by both the SQLite and Postgres
 * stores and by the API's request validation. Keeping phone normalization and
 * the row -> view mapping in one place guarantees the two stores stay
 * behaviourally identical.
 *
 * Phone numbers are canonicalized to E.164-ish `+<digits>` so the same number
 * can never be stored twice (there is a unique index on the canonical form).
 */

export const MIN_PHONE_DIGITS = 7;
export const MAX_PHONE_DIGITS = 15; // E.164 max
export const MAX_LIST_NAME = 200;
export const MAX_LIST_DESCRIPTION = 1000;

/**
 * Canonicalizes a phone number: strips everything except digits and prefixes
 * "+". Returns null when the digit count is outside [7, 15].
 *
 *   "234 814 685 8279"   -> "+2348146858279"
 *   "+234-814-685-8279"  -> "+2348146858279"
 *   "2348146858279"      -> "+2348146858279"
 *   "bad"                -> null
 */
export function normalizePhone(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

/** Contact view: { id, name, phone, createdAt }. */
export function contactToView(row) {
  return {
    id: row.id,
    name: row.name ?? "",
    phone: row.phone,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

/** List view: { id, name, description, memberCount, createdAt }. */
export function listToView(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    memberCount: Number(row.member_count ?? 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}
