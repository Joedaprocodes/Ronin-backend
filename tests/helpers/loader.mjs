import { registerHooks } from "node:module";

// Redirects the project's @whiskeysockets/baileys imports to the in-memory stub.
// Import this module (for its side effect) before importing src code.
const STUB = new URL("./baileys-stub.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@whiskeysockets/baileys") {
      return { url: STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});