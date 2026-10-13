// Guards feature tests: validation/render helpers, the link + language
// classifiers, the wordlist normalizer, and the enforcement engine wired up to
// a real SQLite store + the Baileys stub connection.
import "./helpers/loader.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

const { WhatsAppConnection } = await import("../src/whatsapp/connection.js");
const { createSqliteMessageStore } = await import("../src/db/sqlite.js");
const {
  DEFAULT_GUARD_SETTINGS,
  DEFAULT_WARN_TEMPLATE,
  MAX_WARN_TEMPLATE,
  renderWarnTemplate,
  validateGuardSettings,
} = await import("../src/db/guards.js");
const { createGuardsEngine, classifyLink, extractHosts } = await import("../src/whatsapp/guards.js");
const {
  SENSITIVITY_TIERS,
  collapseSpacedLetters,
  matchesToxicity,
  normalizeText,
} = await import("../src/whatsapp/wordlists.js");
const { __reset, __sockets, __setGroupMetas } = await import("./helpers/baileys-stub.mjs");

const GUARD_JID = "120363412224156592@g.us";
const OWN_JID = "1234@s.whatsapp.net";
const SENDER = "15550000001@s.whatsapp.net";

const tick = () => new Promise((r) => setTimeout(r, 5));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond, timeout = 2000, step = 5) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeout) throw new Error("waitFor timed out");
    await sleep(step);
  }
}

function makeAuth() {
  return {
    state: { cleared: 0 },
    load: async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} }),
    clear: async () => {},
  };
}

function openConnection(wa) {
  return new Promise((resolve) => {
    wa.once("ready", () => resolve());
    const sock = __sockets().at(-1);
    sock.ev.emit("connection.update", { connection: "open" });
  });
}

/** Set up a store + real connection + engine over the stub socket. */
async function engineSetup({ metas = {} } = {}) {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const wa = new WhatsAppConnection({ auth: makeAuth(), messageStore: store });
  const engine = createGuardsEngine({ connection: wa, store });
  const frames = [];
  wa.on("guard", (f) => frames.push(f));
  __setGroupMetas(metas);
  try {
    await wa.start();
    await openConnection(wa);
  } catch (err) {
    store.close();
    throw err;
  }
  return { store, wa, engine, frames, sock: __sockets().at(-1) };
}

/** Emits one incoming group text message through the stub socket. */
function emitText(sock, { id, chat = GUARD_JID, participant = SENDER, text }) {
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { id, remoteJid: chat, participant, fromMe: false },
        message: { conversation: text },
      },
    ],
  });
}

const adminMetas = {
  [GUARD_JID]: {
    id: GUARD_JID,
    subject: "Guarded",
    owner: OWN_JID,
    size: 3,
    participants: [
      { id: OWN_JID, admin: "admin" },
      { id: SENDER },
    ],
  },
};

/* --------------------------- guard settings ---------------------------- */

test("validateGuardSettings merges partials over the defaults", () => {
  assert.deepEqual(validateGuardSettings({}).settings, DEFAULT_GUARD_SETTINGS);

  const { settings } = validateGuardSettings({ linkGuard: true, sensitivity: "strict", warnAt: 4, kickAt: 6 });
  assert.equal(settings.linkGuard, true);
  assert.equal(settings.sensitivity, "strict");
  assert.equal(settings.warnAt, 4);
  assert.equal(settings.kickAt, 6);
  assert.equal(settings.blockExternal, true, "unmentioned fields keep the defaults");

  const whitelist = validateGuardSettings({ linkWhitelist: ["Example.com", "example.com", "www.other.org"] }).settings;
  assert.deepEqual(
    whitelist.linkWhitelist,
    ["example.com", "other.org"],
    "lowercased, deduped and www-stripped"
  );
});

test("validateGuardSettings rejects bad values", () => {
  for (const key of ["linkGuard", "toxicityGuard", "blockExternal", "blockInvites"]) {
    assert.ok(validateGuardSettings({ [key]: "yes" }).error, `${key} must be a boolean`);
  }
  assert.match(validateGuardSettings({ sensitivity: "extreme" }).error, /sensitivity/);
  assert.match(validateGuardSettings({ warnAt: 1.5 }).error, /warnAt/);
  assert.match(validateGuardSettings({ kickAt: 0 }).error, /kickAt/);
  assert.match(validateGuardSettings({ warnAt: 5, kickAt: 3 }).error, /kickAt must be greater/);
  assert.match(validateGuardSettings({ warnTemplate: "hi {bogus}" }).error, /unknown template token: \{bogus\}/);
  assert.ok(
    validateGuardSettings({ warnTemplate: `x${"y".repeat(MAX_WARN_TEMPLATE)}` }).error,
    "templates over the text limit are rejected"
  );
  assert.ok(validateGuardSettings({ linkWhitelist: "example.com" }).error, "whitelist must be an array");
  assert.ok(
    validateGuardSettings({ linkWhitelist: ["https://example.com/path"] }).error,
    "schemes/paths are not bare hosts"
  );
  assert.ok(validateGuardSettings({ linkWhitelist: ["exa mple.com"] }).error, "spaces are invalid");
  assert.ok(
    validateGuardSettings({ linkWhitelist: Array.from({ length: 51 }, (_, i) => `${i}.com`) }).error,
    "more than 50 hosts is rejected"
  );
  // Valid tokens pass unchanged.
  const ok = validateGuardSettings({ warnTemplate: "Hi {name}, {mention} -> {strikes}/{kickAt} for {reason}" });
  assert.equal(ok.error, undefined);
});

test("renderWarnTemplate substitutes tokens and falls back to the default", () => {
  const ctx = { name: "John", mention: "@2288", strikes: 3, kickAt: 5, reason: "link" };
  const rendered = renderWarnTemplate("", ctx);
  assert.equal(rendered, DEFAULT_WARN_TEMPLATE.replace(/\{name\}/, "John").replace(/\{reason\}/, "link").replace(/\{strikes\}/, "3").replace(/\{kickAt\}/, "5"));

  assert.equal(renderWarnTemplate("Strike {strikes}/{kickAt} for {reason} ({mention}).", ctx), "Strike 3/5 for link (@2288).");
  assert.equal(renderWarnTemplate("Unknown {nope} stays", ctx), "Unknown {nope} stays");
});

/* --------------------------- link pipeline ----------------------------- */

test("extractHosts reduces urls and bare domains to bare hosts", () => {
  assert.deepEqual(extractHosts("visit https://example.com/path?q=1 now"), ["example.com"]);
  assert.deepEqual(extractHosts("www.Example.com and example.com plus google.com"), ["example.com", "google.com"]);
  assert.deepEqual(extractHosts("buy at https://shop.example.co.uk/deals"), ["shop.example.co.uk"]);
  assert.deepEqual(extractHosts("no url: typo dot com"), []);
  assert.deepEqual(extractHosts(""), []);
});

test("classifyLink applies whitelist, invite and external rules", () => {
  assert.equal(classifyLink("chat.whatsapp.com", { blockInvites: true, blockExternal: true }), "invite link");
  assert.equal(classifyLink("wa.me", { blockInvites: true, blockExternal: true }), "invite link");
  assert.equal(classifyLink("example.com", { blockExternal: true }), "link");
  assert.equal(classifyLink("example.com", { blockExternal: false }), null);

  // The whitelist wins, including over invite domains and subdomains.
  const whitelisted = { blockInvites: true, blockExternal: true, linkWhitelist: ["example.com", "chat.whatsapp.com"] };
  assert.equal(classifyLink("example.com", whitelisted), null);
  assert.equal(classifyLink("sub.example.com", whitelisted), null);
  assert.equal(classifyLink("chat.whatsapp.com", whitelisted), null);
  assert.equal(classifyLink("evil.example.net", whitelisted), "link");
  // A "www."-prefixed whitelist entry still allows the bare host (incoming
  // hosts are always reduced with "www." stripped).
  assert.equal(
    classifyLink("other.org", { blockExternal: true, linkWhitelist: ["www.other.org"] }),
    null
  );
});

/* --------------------------- language pipeline ------------------------- */

test("normalizeText strips punctuation, leaks, spacing and accents", () => {
  assert.equal(normalizeText("F u c k! 😡"), "fuck");
  assert.equal(normalizeText("Sh1t happens"), "shit happens");
  assert.equal(normalizeText("HÉLLO  WÖRLD"), "hello world");
  assert.equal(normalizeText("y u r e x"), collapseSpacedLetters("y u r e x"));
  assert.equal(normalizeText("just normal words 123"), "just normal words 123");
});

test("matchesToxicity keys against the tiered wordlists", () => {
  assert.equal(matchesToxicity("this is shit", SENSITIVITY_TIERS.medium), "shit");
  assert.equal(matchesToxic("fucking hell", SENSITIVITY_TIERS.medium), "fuck", "inflected tokens match the base word");
  assert.equal(matchesToxicity("a cockroach crawled by", SENSITIVITY_TIERS.medium), null, "no false positive via a plain prefix");
  assert.equal(matchesToxicity("green grass", SENSITIVITY_TIERS.medium), null, "no substring false positive");
  assert.equal(matchesToxicity("you whore", SENSITIVITY_TIERS.low), "whore");
  assert.equal(matchesToxicity("you idiot", SENSITIVITY_TIERS.low), null, "mild words need strict");
  assert.equal(matchesToxicity("you idiot", SENSITIVITY_TIERS.strict), "idiot");
});

/** Helper so we don't need a fiber: matchesToxic === matchesToxicity. */
function matchesToxic(text, words) {
  return matchesToxicity(text, words);
}

/* ----------------------------- the engine ------------------------------ */

test("guards engine: deletes first offense, warns at warnAt, kicks at kickAt", async () => {
  const { store, wa, engine, frames, sock } = await engineSetup({ metas: adminMetas });
  store.saveGuardSettings(GUARD_JID, { linkGuard: true, warnAt: 2, kickAt: 5 });
  try {
    // listModeration returns newest-first; flip it so the assertions below read
    // chronologically (oldest -> newest).
    const log = () => [...store.listModeration(GUARD_JID)].reverse();

    // 1st: deleted, strike 1.
    emitText(sock, { id: "m-1", text: "here: https://example.com" });
    await waitFor(() => log().length === 1);
    let entry = log().at(-1);
    assert.equal(entry.action, "Deleted");
    assert.equal(entry.reason, "link");
    assert.equal(entry.detail, "example.com");
    assert.equal(entry.actorJid, OWN_JID);
    assert.equal(store.getStrikes(GUARD_JID, SENDER).count, 1);
    assert.equal(frames.at(-1).action, "Deleted");
    // The emitted frame is the stored log view verbatim (id + display fields),
    // so SSE consumers can prepend it without reshaping.
    assert.equal(frames.at(-1).id, entry.id);
    assert.equal(frames.at(-1).user, entry.user);
    assert.equal(frames.at(-1).actorJid, entry.actorJid);
    assert.ok(
      sock.sent.some((s) => s.content?.delete?.id === "m-1"),
      "the offending message is revoked via a Baileys delete"
    );

    // 2nd: warnAt reached -> Warned with the rendered template.
    emitText(sock, { id: "m-2", text: "again https://example.com" });
    await waitFor(() => log().length === 2);
    entry = log().at(-1);
    assert.equal(entry.action, "Warned");
    assert.equal(frames.at(-1).action, "Warned");
    const warn = sock.sent.find((s) => typeof s.content?.text === "string");
    assert.ok(warn, "a warning message is sent");
    assert.ok(warn.content.text.includes("Strike 2/5"), warn.content.text);
    assert.ok(warn.content.text.includes(SENDER.replace("@s.whatsapp.net", "")));
    assert.deepEqual(warn.content.mentions, [SENDER]);

    // 3rd and 4th: still below kickAt, so they warn again.
    emitText(sock, { id: "m-3", text: "https://example.com third" });
    await waitFor(() => log().length === 3);
    emitText(sock, { id: "m-4", text: "https://example.com fourth" });
    await waitFor(() => log().length === 4);
    assert.equal(log().at(-1).action, "Warned");

    // 5th: kickAt reached -> Kicked, strikes reset.
    emitText(sock, { id: "m-5", text: "https://example.com fifth" });
    await waitFor(() => log().length === 5);
    entry = log().at(-1);
    assert.equal(entry.action, "Kicked");
    assert.equal(frames.at(-1).action, "Kicked");
    const removal = sock.participantUpdates.find((u) => u.action === "remove");
    assert.ok(removal, "the offender is removed");
    assert.deepEqual(removal.participants, [SENDER]);
    assert.deepEqual(store.getStrikes(GUARD_JID, SENDER), { count: 0, updatedAt: null }, "strikes reset after the kick");

    assert.deepEqual(log().map((e) => e.action), ["Deleted", "Warned", "Warned", "Warned", "Kicked"]);
  } finally {
    engine.stop();
    store.close();
  }
});

test("guards engine: bad language offenses follow the same stream", async () => {
  const { store, wa, engine, frames, sock } = await engineSetup({ metas: adminMetas });
  store.saveGuardSettings(GUARD_JID, { toxicityGuard: true, sensitivity: "low", warnAt: 2, kickAt: 5 });
  try {
    emitText(sock, { id: "w-1", text: "you are a whore" });
    await waitFor(() => store.listModeration(GUARD_JID).length === 1);
    const entry = store.listModeration(GUARD_JID).at(-1);
    assert.equal(entry.action, "Deleted");
    assert.equal(entry.reason, "bad language");
    assert.equal(entry.detail, "whore");
    assert.equal(frames.at(-1).detail, "whore");
  } finally {
    engine.stop();
    store.close();
  }
});

test("guards engine: link and toxicity switches are independent", async () => {
  const { store, engine, sock } = await engineSetup({ metas: adminMetas });
  try {
    // Link guard only: bad language is ignored.
    store.saveGuardSettings(GUARD_JID, { linkGuard: true, sensitivity: "low", warnAt: 2, kickAt: 5 });
    emitText(sock, { id: "ind-1", text: "you are a whore" });
    await sleep(60);
    assert.equal(store.listModeration(GUARD_JID).length, 0, "toxicity off: no offense");

    // Toxicity guard only: links are ignored.
    store.saveGuardSettings(GUARD_JID, { toxicityGuard: true, sensitivity: "low", warnAt: 2, kickAt: 5 });
    emitText(sock, { id: "ind-2", text: "visit https://example.com" });
    await sleep(60);
    assert.equal(store.listModeration(GUARD_JID).length, 0, "link guard off: no offense");

    // Toxicity alone still catches bad language.
    emitText(sock, { id: "ind-3", text: "you are a whore" });
    await waitFor(() => store.listModeration(GUARD_JID).length === 1);
    assert.equal(store.listModeration(GUARD_JID).at(0).reason, "bad language");

    // Both on: a message with a link AND a bad word reports the link (precedence).
    store.saveGuardSettings(GUARD_JID, { linkGuard: true, toxicityGuard: true, sensitivity: "low", warnAt: 2, kickAt: 5 });
    emitText(sock, { id: "ind-4", text: "whore https://example.com" });
    await waitFor(() => store.listModeration(GUARD_JID).length === 2);
    assert.equal(store.listModeration(GUARD_JID).at(0).reason, "link");
  } finally {
    engine.stop();
    store.close();
  }
});

test("guards engine: no action when the guard is off, the host is whitelisted, or the sender is an admin", async () => {
  const { store, engine, sock } = await engineSetup({ metas: adminMetas });
  const ticks = () => sleep(40);
  try {
    // Guard off by default -> nothing happens.
    emitText(sock, { id: "off-1", text: "https://example.com" });
    await ticks();
    assert.equal(store.listModeration(GUARD_JID).length, 0);

    // Guard on, host whitelisted -> allowed.
    store.saveGuardSettings(GUARD_JID, { linkGuard: true, linkWhitelist: ["example.com"] });
    emitText(sock, { id: "off-2", text: "https://example.com allowed" });
    await ticks();
    assert.equal(store.listModeration(GUARD_JID).length, 0);

    // Admin senders are exempt.
    store.saveGuardSettings(GUARD_JID, { linkGuard: true, linkWhitelist: [] });
    emitText(sock, { id: "off-3", participant: OWN_JID, text: "https://example.com from admin" });
    await ticks();
    assert.equal(store.listModeration(GUARD_JID).length, 0);

    // Non-text messages don't hit the engines.
    sock.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{ key: { id: "off-4", remoteJid: GUARD_JID, participant: SENDER, fromMe: false }, message: { imageMessage: { caption: "" } } }],
    });
    await ticks();
    assert.equal(store.listModeration(GUARD_JID).length, 0);
  } finally {
    engine.stop();
    store.close();
  }
});

test("guards engine: groups where the account is not an admin are skipped", async () => {
  const { store, engine, sock } = await engineSetup({
    metas: {
      [GUARD_JID]: {
        id: GUARD_JID,
        owner: SENDER, // someone else is the owner -> we're not an admin
        participants: [
          { id: OWN_JID },
          { id: SENDER, admin: "superadmin" },
        ],
      },
    },
  });
  store.saveGuardSettings(GUARD_JID, { linkGuard: true });
  try {
    emitText(sock, { id: "na-1", text: "https://example.com" });
    await sleep(60);
    assert.equal(store.listModeration(GUARD_JID).length, 0);
  } finally {
    engine.stop();
    store.close();
  }
});

test("guards engine: a failed revoke skips the offense entirely", async () => {
  const { store, engine, sock } = await engineSetup({ metas: adminMetas });
  store.saveGuardSettings(GUARD_JID, { linkGuard: true });
  const original = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content) => {
    if (content?.delete) throw new Error("revoke failed");
    return original(jid, content);
  };
  try {
    emitText(sock, { id: "rf-1", text: "https://example.com" });
    await sleep(60);
    assert.equal(store.listModeration(GUARD_JID).length, 0, "no log entry");
    assert.equal(store.getStrikes(GUARD_JID, SENDER).count, 0, "no strike");
  } finally {
    engine.stop();
    store.close();
  }
});