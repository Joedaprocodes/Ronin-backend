/**
 * Shared template -> Baileys content helpers.
 *
 * Broadcasts and the automation engine (auto-replies, away mode) must send
 * templates byte-for-byte identically, so both build their content here:
 *
 *  - `loadTemplateMedia` reads a template's attachment bytes from the media
 *    store (the stored key is the last segment of the media view's `url`).
 *  - `buildTemplateContent` personalizes the body ({{name}} / {{full_name}})
 *    and folds the attachment in, mirroring the inbox send rules: image/video
 *    use the body as a caption, document/audio send just the attachment.
 */

import { renderTemplate } from "./render.js";

/**
 * Reads a template's attachment bytes. Returns `{ media }` (null when the
 * template has no media) or `{ error }` when the stored bytes are gone.
 */
export async function loadTemplateMedia(template, mediaStore) {
  if (!template?.media) return { media: null };
  const url = template.media.url;
  const key = typeof url === "string" ? url.split("/").pop() : null;
  const found = key && mediaStore ? await mediaStore.read(key) : null;
  if (!found) return { error: "template media could not be read" };
  return {
    media: {
      type: template.media.type,
      mimeType: template.media.mimeType ?? found.mimeType,
      fileName: template.media.fileName ?? found.fileName,
      buffer: found.buffer,
    },
  };
}

/**
 * Builds the Baileys content for one recipient. `recipient` is
 * `{ name, phone }`; the template supplies `fallbackName`.
 */
export function buildTemplateContent(template, media, recipient = {}) {
  const body = renderTemplate(template.body ?? "", {
    name: recipient.name,
    fallbackName: template.fallbackName,
    phone: recipient.phone,
  });
  if (!media) return { text: body };
  const type = media.type;
  const content = {};
  content[type] = media.buffer;
  if (media.mimeType) content.mimetype = media.mimeType;
  if (type === "document" && media.fileName) content.fileName = media.fileName;
  if ((type === "image" || type === "video") && body.trim()) content.caption = body;
  return content;
}
