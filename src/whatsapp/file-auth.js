import fs from "node:fs";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";

/**
 * Default auth store: session files in a local folder.
 * An auth store is any object with:
 *   load()  -> Promise<{ state, saveCreds }>   (same shape as useMultiFileAuthState)
 *   clear() -> Promise<void>                   (wipe the session, used on logout)
 */
export function createFileAuth(dir = "./auth") {
  return {
    load: () => useMultiFileAuthState(dir),
    clear: async () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}