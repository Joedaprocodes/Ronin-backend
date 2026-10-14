import "dotenv/config";
import qrcode from "qrcode-terminal";
import { WhatsAppConnection } from "./whatsapp/connection.js";
import { createGuardsEngine } from "./whatsapp/guards.js";
import { createAutomationEngine } from "./whatsapp/automation.js";
import { loadConfig } from "./config.js";
import { createApiServer } from "./api/server.js";

// Session + message storage (Supabase Postgres if DATABASE_URL is set) + media
// bytes (mediaStore: on disk locally, a Supabase bucket in production; served
// as a Supabase public URL or, for disk refs, via /api/media/:id)
const { pool, auth, messageStore, mediaStore } = loadConfig();

// Link with a phone number: set PHONE_NUMBER (country code, digits only, e.g. 15551234567).
// Leave it unset to link with a QR code instead.
const wa = new WhatsAppConnection({
  auth,
  authDir: "./auth",
  phoneNumber: process.env.PHONE_NUMBER,
  logLevel: process.env.LOG_LEVEL ?? "silent", // set LOG_LEVEL=info to see Baileys logs
  messageStore,
  mediaStore,
});

wa.on("state", (state) => console.log(`[wa] state: ${state}`));

// QR mode
wa.on("qr", (qr) => {
  console.log("\nScan this QR code: WhatsApp > Linked devices > Link a device\n");
  qrcode.generate(qr, { small: true });
});

// Phone-number mode
wa.on("pairing_code", (code) => {
  console.log(`\nPairing code: ${code}\n`);
  console.log("On your phone: WhatsApp > Linked devices > Link a device");
  console.log('> "Link with phone number instead", then type the code above.\n');
});

// Optional smoke test: set TEST_NUMBER to a number with country code.
// Runs once, on the first successful connect (not on every reconnect).
let smokeTested = false;
wa.on("ready", async (user) => {
  console.log(`[wa] connected as ${user.name ?? "unknown"} (${user.id})`);

  const testNumber = process.env.TEST_NUMBER;
  if (!testNumber || smokeTested) return;
  smokeTested = true;
  try {
    await wa.sendText(testNumber, "Hello from my WhatsApp server 👋");
    console.log(`[wa] test message sent to ${testNumber}`);
  } catch (err) {
    smokeTested = false; // let a later reconnect retry
    console.error(`[wa] test message failed: ${err.message}`);
  }
});

wa.on("message", (m) => {
  if (m.fromMe) return;
  const where = m.isGroup ? `group ${m.chat}` : "DM";
  console.log(`[wa] ${where} from ${m.name ?? m.sender}: ${m.text ?? "(non-text message)"}`);
});

wa.on("disconnected", ({ code }) => console.log(`[wa] disconnected (code: ${code ?? "n/a"})`));
wa.on("logged_out", () => console.log("[wa] logged out from the phone. Linking starts again."));
wa.on("failure", (err) => console.error(`[wa] failure: ${err.message}`));

// Inbox API (separate from the WhatsApp wiring). Prefers PORT when the host
// provides one (Render, Railway, Fly, Heroku all inject it), then API_PORT from
// .env, then 3001. A null messageStore still boots the server, but /api/inbox
// returns 503 until one is configured.
const apiPort = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
const api = createApiServer({
  messageStore,
  templateStore: messageStore, // templates live in the same dual store
  contactStore: messageStore, // contacts + lists live in the same dual store
  broadcastStore: messageStore, // broadcasts + recipients live in the same dual store
  guardStore: messageStore, // guards settings + moderation log live here too
  automationStore: messageStore, // auto-replies + away mode live here too
  connection: wa,
  mediaStore,
  // Set API_TOKEN in .env to require the x-api-token header on /api/inbox/:jid/send
  // (and the ?token= query param on /api/events).
  apiToken: process.env.API_TOKEN,
});

// Per-group auto-moderation. Subscribes to wa's "message" events and acts on
// groups that have saved guard settings; re-emits each action as a "guard"
// event so the API streams it over SSE.
const guards = createGuardsEngine({ connection: wa, store: messageStore });

// Auto-replies + away mode. Answers incoming messages with broadcast
// templates; templates and media come from the same stores as broadcasts.
const automation = createAutomationEngine({
  connection: wa,
  store: messageStore,
  templateStore: messageStore,
  mediaStore,
});

// Bind the API *before* connecting to WhatsApp. If the port is already taken,
// another instance is running against this same auth session, so exit instead of
// opening a second Baileys socket: two sockets on one session replace each other
// ("connectionReplaced" -> state "replaced") and then every send returns 409.
await new Promise((resolve, reject) => {
  api.once("error", reject);
  api.listen(apiPort, () => {
    api.removeListener("error", reject);
    console.log(`[api] inbox API listening on http://localhost:${apiPort}`);
    resolve();
  });
}).catch((err) => {
  console.error(`[api] cannot listen on http://localhost:${apiPort}: ${err.message}`);
  console.error("[api] another instance is already running - exiting to avoid a WhatsApp session conflict.");
  process.exit(1);
});
api.on("error", (err) => console.error(`[api] error: ${err.message}`));

// start() reports setup failures via the "failure" event and schedules its own retry
await wa.start().catch(() => {});

// Graceful shutdown: close the socket but keep the session linked
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[wa] shutting down (${signal})...`);
  try {
    guards.stop();
    automation?.stop();
    if (api.listening) await new Promise((resolve) => api.close(resolve));
    await wa.stop(); // waits for the socket to finish closing
    await pool?.end(); // only then release the database pool
  } catch (err) {
    console.error(`[wa] shutdown error: ${err.message}`);
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));