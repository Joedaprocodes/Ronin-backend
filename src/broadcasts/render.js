/**
 * Per-recipient personalization for broadcast templates.
 *
 * A template body may reference two placeholders (matching is case-insensitive
 * and tolerates inner whitespace, e.g. `{{ FULL_NAME }}`):
 *
 *   {{full_name}} -> the recipient's full name
 *   {{name}}      -> the first whitespace-delimited word of the name
 *
 * Resolution chain when a contact has no name:
 *   contact name -> template fallbackName -> the canonical phone (+234...)
 *
 * Any other `{{token}}` is left untouched so unknown placeholders never
 * silently disappear from the message.
 */

/** First whitespace-delimited word of a name ("" when the name is empty). */
export function firstName(name) {
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean) return "";
  return clean.split(/\s+/)[0];
}

/**
 * Expands the supported placeholders in `text`. Never returns null/undefined
 * for a string input; a non-string input is returned unchanged.
 */
export function renderTemplate(text, { name = "", fallbackName = "", phone = "" } = {}) {
  if (typeof text !== "string" || !text) return text;
  const full = (typeof name === "string" ? name.trim() : "") || fallbackName || phone || "";
  const first = firstName(name) || fallbackName || phone || "";
  return text.replace(/\{\{\s*(full_name|name)\s*\}\}/gi, (_, token) =>
    token.toLowerCase() === "full_name" ? full : first
  );
}
