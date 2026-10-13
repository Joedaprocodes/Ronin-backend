/**
 * Shared broadcast row -> view helpers used by both the SQLite and Postgres
 * stores (and by the API). Keeping the mapping in one place guarantees the two
 * stores expose byte-for-byte identical shapes, mirroring src/db/contacts.js.
 *
 * A broadcast row carries `list_ids` as a JSON string (both stores store it as
 * text) and ISO-8601 text timestamps. `total` is the deduped recipient count;
 * `sent`/`failed` are the running worker counters.
 */

/** Parses list_ids stored as JSON text (or passes an already-parsed array). */
function parseListIds(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string" && value) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return []; // corrupt value: treat as no lists
    }
  }
  return [];
}

function toIso(value) {
  return value ? new Date(value).toISOString() : null;
}

/** Broadcast view: the shape returned by the API. */
export function broadcastToView(row) {
  return {
    id: row.id,
    templateId: row.template_id ?? null,
    templateTitle: row.template_title ?? "",
    listIds: parseListIds(row.list_ids),
    senderEmail: row.sender_email ?? null,
    minDelay: Number(row.min_delay ?? 0),
    maxDelay: Number(row.max_delay ?? 0),
    sendAt: toIso(row.send_at),
    status: row.status ?? null,
    total: Number(row.total ?? 0),
    sent: Number(row.sent ?? 0),
    failed: Number(row.failed ?? 0),
    createdAt: toIso(row.created_at),
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
    error: row.error ?? null,
  };
}

/** Per-recipient view used by GET /api/broadcasts/:id. */
export function recipientToView(row) {
  return {
    phone: row.phone,
    name: row.name ?? "",
    status: row.status ?? null,
    error: row.error ?? null,
    sentAt: toIso(row.sent_at),
  };
}
