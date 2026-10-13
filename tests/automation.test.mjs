// Automation feature tests: validation + away-window helpers, the SQLite store
// (rules, away settings, away-reply bookkeeping), the reply engine, and the
// /api/automation routes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createSqliteMessageStore } from "../src/db/sqlite.js";
import { createApiServer } from "../src/api/server.js";
import { createAutomationEngine } from "../src/whatsapp/automation.js";
import {
  DEFAULT_AWAY_SETTINGS,
  evaluateAwayWindow,
  validateAutoReply,
  validateAwaySettings,
} from "../src/db/automation.js";

const GROUP_A = "1111@g.us";
const GROUP_B = "2222@g.us";
const DM = "15550000001@s.whatsapp.net";

const startOfDay = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
const fmtMinutes = (m) => {
  const v = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};

/** A UTC window (+/- 30 min) that is guaranteed to contain "now". */
function windowContainingNow() {
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return { start: fmtMinutes(mins - 30), end: fmtMinutes(mins + 30) };
}

/** A UTC window that is guaranteed NOT to contain "now". */
function windowExcludingNow() {
  const now = new Date();
  const mins = now.getUTCHours() * 60 + now.getUTCMinutes();
  return { start: fmtMinutes(mins + 60), end: fmtMinutes(mins + 120) };
}

function fakeConnection() {
  const conn = new EventEmitter();
  conn.sent = [];
  conn.sendMessage = async (jid, content, email = null, options) => {
    conn.sent.push({ jid, content, email, options });
    return { key: { id: `sent-${conn.sent.length}`, remoteJid: jid, fromMe: true } };
  };
  return conn;
}

function dm(text, { chat = DM, name = "Bob" } = {}) {
  return { chat, isGroup: false, fromMe: false, sender: chat, name, text };
}

function groupMsg(text, { chat = GROUP_A, sender = "1555999@s.whatsapp.net" } = {}) {
  return { chat, isGroup: true, fromMe: false, sender, name: "Alice", text };
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                */
/* -------------------------------------------------------------------------- */

test("validateAutoReply fills defaults and normalizes groups", () => {
  const { error, rule } = validateAutoReply({
    keyword: "  PRICE  ",
    templateId: "t1",
    groups: [GROUP_A, GROUP_A, "  ", GROUP_B],
  });
  assert.equal(error, undefined);
  assert.equal(rule.keyword, "PRICE");
  assert.equal(rule.match, "contains");
  assert.equal(rule.templateId, "t1");
  assert.equal(rule.enabled, true);
  assert.equal(rule.dm, true);
  assert.deepEqual(rule.groups, [GROUP_A, GROUP_B], "trimmed + deduped");
});

test("validateAutoReply rejects bad rules", () => {
  assert.match(validateAutoReply({}).error, /keyword is required/);
  assert.match(validateAutoReply({ keyword: "hi" }).error, /templateId is required/);
  assert.match(validateAutoReply({ keyword: "hi", templateId: "t", match: "fuzzy" }).error, /match/);
  assert.match(validateAutoReply({ keyword: "hi", templateId: "t", enabled: "yes" }).error, /enabled.*boolean/);
  assert.match(validateAutoReply({ keyword: "hi", templateId: "t", groups: "x" }).error, /groups/);
  assert.match(validateAutoReply({ keyword: "hi", templateId: "t", quote: "yes" }).error, /quote.*boolean/);
});

test("validateAutoReply defaults quote to true and accepts false", () => {
  assert.equal(validateAutoReply({ keyword: "hi", templateId: "t" }).rule.quote, true);
  assert.equal(validateAutoReply({ keyword: "hi", templateId: "t", quote: false }).rule.quote, false);
});

test("validateAwaySettings validates the window and template", () => {
  const { settings } = validateAwaySettings({});
  assert.deepEqual(settings, DEFAULT_AWAY_SETTINGS);

  assert.match(validateAwaySettings({ start: "25:00" }).error, /start/);
  assert.match(validateAwaySettings({ start: "09:00", end: "09:00" }).error, /can't be the same/);
  assert.match(validateAwaySettings({ enabled: true }).error, /choose a template/);
  assert.match(validateAwaySettings({ timeZone: "Not/AZone" }).error, /unknown time zone/);

  const ok = validateAwaySettings({
    enabled: true,
    start: "22:00",
    end: "07:00",
    templateId: "t1",
    timeZone: "Africa/Lagos",
  });
  assert.equal(ok.error, undefined);
  assert.equal(ok.settings.oncePerContact, true);

  assert.equal(ok.settings.quote, true, "quote defaults to true");
  assert.equal(validateAwaySettings({ quote: false }).settings.quote, false);
  assert.match(validateAwaySettings({ quote: "no" }).error, /quote.*boolean/);
});

test("evaluateAwayWindow handles same-day and overnight windows", () => {
  // Same-day window.
  assert.deepEqual(
    evaluateAwayWindow({ start: "09:00", end: "17:00", timeZone: "UTC", now: new Date("2026-03-10T10:00:00Z") }),
    { active: true, key: "2026-03-10" }
  );
  assert.equal(
    evaluateAwayWindow({ start: "09:00", end: "17:00", timeZone: "UTC", now: new Date("2026-03-10T20:00:00Z") }).active,
    false
  );

  // Overnight window: before midnight belongs to today...
  assert.deepEqual(
    evaluateAwayWindow({ start: "22:00", end: "07:00", timeZone: "UTC", now: new Date("2026-03-10T23:30:00Z") }),
    { active: true, key: "2026-03-10" }
  );
  // ...and after midnight to the previous day's window.
  assert.deepEqual(
    evaluateAwayWindow({ start: "22:00", end: "07:00", timeZone: "UTC", now: new Date("2026-03-11T03:00:00Z") }),
    { active: true, key: "2026-03-10" }
  );
  assert.equal(
    evaluateAwayWindow({ start: "22:00", end: "07:00", timeZone: "UTC", now: new Date("2026-03-11T12:00:00Z") }).active,
    false
  );

  // A malformed window is never active.
  assert.deepEqual(evaluateAwayWindow({ start: "x", end: "y" }), { active: false, key: null });
});

/* -------------------------------------------------------------------------- */
/*  SQLite store                                                              */
/* -------------------------------------------------------------------------- */

test("auto-reply rules: create/get/list/update/delete with group scope", () => {
  const store = createSqliteMessageStore({ file: ":memory:" });

  const created = store.createAutoReply({
    keyword: "PRICE",
    match: "contains",
    templateId: "t1",
    groups: [GROUP_A, GROUP_B],
  });
  assert.equal(created.keyword, "PRICE");
  assert.deepEqual(created.groups, [GROUP_A, GROUP_B]);
  assert.equal(created.quote, true, "quote defaults to true");
  assert.ok(created.createdAt, "createdAt is an ISO timestamp");

  assert.equal(store.listAutoReplies().length, 1);
  assert.deepEqual(store.getAutoReply(created.id).groups, [GROUP_A, GROUP_B]);

  // Partial update: toggling enabled keeps the keyword/groups; groups replace.
  const toggled = store.updateAutoReply(created.id, { enabled: false });
  assert.equal(toggled.enabled, false);
  assert.equal(toggled.keyword, "PRICE");
  assert.deepEqual(toggled.groups, [GROUP_A, GROUP_B]);

  // quote can be turned off and survives a partial update.
  const standalone = store.updateAutoReply(created.id, { quote: false });
  assert.equal(standalone.quote, false);
  assert.equal(store.updateAutoReply(created.id, { enabled: true }).quote, false, "kept");

  const rescoped = store.updateAutoReply(created.id, { groups: [GROUP_B] });
  assert.deepEqual(rescoped.groups, [GROUP_B]);

  assert.equal(store.updateAutoReply("missing", { enabled: true }), null);
  assert.equal(store.deleteAutoReply(created.id), true);
  assert.equal(store.deleteAutoReply(created.id), false);
  assert.equal(store.listAutoReplies().length, 0);
  assert.deepEqual(store.getAutoReply(created.id), null);

  store.close();
});

test("away settings round-trip and away-reply bookkeeping", () => {
  const store = createSqliteMessageStore({ file: ":memory:" });

  assert.deepEqual(store.getAwaySettings().enabled, false);
  const saved = store.saveAwaySettings({ enabled: true, start: "22:00", end: "07:00", templateId: "t9", timeZone: "Africa/Lagos" });
  assert.equal(saved.enabled, true);
  assert.equal(saved.templateId, "t9");
  assert.equal(saved.timeZone, "Africa/Lagos");
  assert.equal(saved.oncePerContact, true);
  assert.equal(saved.quote, true, "quote defaults to true");

  // A partial save keeps the rest.
  const partial = store.saveAwaySettings({ oncePerContact: false });
  assert.equal(partial.oncePerContact, false);
  assert.equal(partial.templateId, "t9");
  assert.equal(store.saveAwaySettings({ quote: false }).quote, false);

  assert.equal(store.hasAwayReply(DM, "2026-03-10"), false);
  store.markAwayReply(DM, "2026-03-10");
  assert.equal(store.hasAwayReply(DM, "2026-03-10"), true);
  assert.equal(store.hasAwayReply(DM, "2026-03-11"), false, "a different window is unaffected");

  store.close();
});

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

test("a DM rule replies with its template", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const template = store.saveTemplate({ title: "Price list", body: "Prices for {{name}}!" });
  store.createAutoReply({ keyword: "price", templateId: template.id, dm: true, groups: [] });

  const connection = fakeConnection();
  const engine = createAutomationEngine({ connection, store, templateStore: store, mediaStore: null });

  await engine.handle(dm("Can I get the PRICE?", { name: "Bob" }));
  assert.equal(connection.sent.length, 1);
  assert.equal(connection.sent[0].jid, DM);
  assert.deepEqual(connection.sent[0].content, { text: "Prices for Bob!" });

  store.close();
});

test("auto-replies respect their scope (group selection + DM flag)", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const template = store.saveTemplate({ title: "Hi", body: "hello" });
  store.createAutoReply({ keyword: "hi", templateId: template.id, dm: false, groups: [GROUP_A] });

  const connection = fakeConnection();
  const engine = createAutomationEngine({ connection, store, templateStore: store, mediaStore: null });

  await engine.handle(groupMsg("hi there", { chat: GROUP_A }));
  assert.equal(connection.sent.length, 1, "fires in the selected group");

  await engine.handle(groupMsg("hi there", { chat: GROUP_B }));
  await engine.handle(dm("hi there"));
  assert.equal(connection.sent.length, 1, "ignores other groups and DMs");

  store.close();
});

test("only the first matching rule replies", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const first = store.saveTemplate({ title: "First", body: "first" });
  const second = store.saveTemplate({ title: "Second", body: "second" });
  store.createAutoReply({ keyword: "help", templateId: first.id, dm: true, groups: [] });
  store.createAutoReply({ keyword: "helps", templateId: second.id, dm: true, groups: [] });

  const connection = fakeConnection();
  const engine = createAutomationEngine({ connection, store, templateStore: store, mediaStore: null });

  await engine.handle(dm("please help me"));
  assert.equal(connection.sent.length, 1);
  assert.deepEqual(connection.sent[0].content, { text: "first" });

  store.close();
});

test("auto-replies quote the trigger by default and can send standalone", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const template = store.saveTemplate({ title: "Hi", body: "hello" });
  const rule = store.createAutoReply({ keyword: "hi", templateId: template.id, dm: true, groups: [] });
  assert.equal(rule.quote, true, "rules quote by default");

  const connection = fakeConnection();
  const engine = createAutomationEngine({ connection, store, templateStore: store, mediaStore: null });

  const quoted = { key: { id: "orig", remoteJid: DM, fromMe: false }, message: { conversation: "hi" } };

  // Default: the reply quotes the triggering message.
  await engine.handle({ ...dm("hi"), quoted });
  assert.equal(connection.sent.length, 1);
  assert.deepEqual(connection.sent[0].options, { quoted });

  // quote off -> a standalone send (no quoted option).
  store.updateAutoReply(rule.id, { quote: false });
  await engine.handle({ ...dm("hi"), quoted });
  assert.equal(connection.sent[1].options, undefined);

  // quote on but the trigger carries nothing to quote -> standalone send.
  store.updateAutoReply(rule.id, { quote: true });
  await engine.handle(dm("hi"));
  assert.equal(connection.sent[2].options, undefined);

  store.close();
});

test("away replies quote the trigger when enabled", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const awayTemplate = store.saveTemplate({ title: "Away", body: "We are away" });
  const { start, end } = windowContainingNow();
  store.saveAwaySettings({ enabled: true, start, end, templateId: awayTemplate.id, oncePerContact: false, quote: true, timeZone: "UTC" });

  const connection = fakeConnection();
  const engine = createAutomationEngine({ connection, store, templateStore: store, mediaStore: null });

  const quoted = { key: { id: "orig", remoteJid: DM, fromMe: false }, message: { conversation: "you there?" } };
  await engine.handle({ ...dm("you there?"), quoted });
  assert.equal(connection.sent.length, 1);
  assert.deepEqual(connection.sent[0].options, { quoted });

  store.close();
});

test("away mode wins over auto-replies and replies once per contact", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const awayTemplate = store.saveTemplate({ title: "Away", body: "We are away" });
  const ruleTemplate = store.saveTemplate({ title: "Rule", body: "keyword reply" });
  store.createAutoReply({ keyword: "price", templateId: ruleTemplate.id, dm: true, groups: [] });

  const { start, end } = windowContainingNow();
  store.saveAwaySettings({ enabled: true, start, end, templateId: awayTemplate.id, oncePerContact: true, timeZone: "UTC" });

  const connection = fakeConnection();
  const engine = createAutomationEngine({ connection, store, templateStore: store, mediaStore: null });

  await engine.handle(dm("what is the price?"));
  await engine.handle(dm("still there?"));
  assert.equal(connection.sent.length, 1, "one away reply, no keyword reply, no repeat");
  assert.deepEqual(connection.sent[0].content, { text: "We are away" });

  store.close();
});

test("away mode is inactive outside its window", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const awayTemplate = store.saveTemplate({ title: "Away", body: "We are away" });
  const { start, end } = windowExcludingNow();
  store.saveAwaySettings({ enabled: true, start, end, templateId: awayTemplate.id, timeZone: "UTC" });

  const connection = fakeConnection();
  const engine = createAutomationEngine({ connection, store, templateStore: store, mediaStore: null });

  await engine.handle(dm("hello"));
  assert.equal(connection.sent.length, 0);

  store.close();
});

test("a rule pointing at a deleted template is skipped silently", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const template = store.saveTemplate({ title: "Gone", body: "bye" });
  store.createAutoReply({ keyword: "hi", templateId: template.id, dm: true, groups: [] });
  store.deleteTemplate(template.id);

  const connection = fakeConnection();
  const engine = createAutomationEngine({ connection, store, templateStore: store, mediaStore: null });

  await engine.handle(dm("hi"));
  assert.equal(connection.sent.length, 0);

  store.close();
});

/* -------------------------------------------------------------------------- */
/*  API                                                                       */
/* -------------------------------------------------------------------------- */

function listen(api) {
  return new Promise((resolve) => api.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${api.address().port}`)));
}
const closeApi = (api) => new Promise((resolve) => api.close(resolve));

test("automation routes: rule CRUD, validation and token gating", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const template = store.saveTemplate({ title: "T", body: "reply" });
  const api = createApiServer({ messageStore: store, apiToken: "s3cret", startScheduler: false });
  const base = await listen(api);
  const post = (p, body, headers = {}) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-token": "s3cret", ...headers },
      body: JSON.stringify(body),
    });

  try {
    // Reads are open.
    assert.deepEqual(await (await fetch(`${base}/api/automation/replies`)).json(), { rules: [] });

    // Writes need the token.
    assert.equal((await post("/api/automation/replies", { keyword: "hi", templateId: template.id }, { "x-api-token": "nope" })).status, 401);

    // Unknown template is rejected.
    assert.equal((await post("/api/automation/replies", { keyword: "hi", templateId: "nope" })).status, 400);

    // Create.
    const created = await post("/api/automation/replies", { keyword: "hi", templateId: template.id, groups: [GROUP_A] });
    assert.equal(created.status, 201);
    const { rule } = await created.json();
    assert.equal(rule.keyword, "hi");
    assert.deepEqual(rule.groups, [GROUP_A]);

    // Update (toggle) keeps the rest.
    const put = await fetch(`${base}/api/automation/replies/${rule.id}`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-api-token": "s3cret" },
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(put.status, 200);
    const updated = (await put.json()).rule;
    assert.equal(updated.enabled, false);
    assert.deepEqual(updated.groups, [GROUP_A]);

    // DELETE then 404.
    assert.equal((await fetch(`${base}/api/automation/replies/${rule.id}`, { method: "DELETE", headers: { "x-api-token": "s3cret" } })).status, 200);
    assert.equal((await fetch(`${base}/api/automation/replies/${rule.id}`, { method: "PUT", headers: { "content-type": "application/json", "x-api-token": "s3cret" }, body: "{}" })).status, 404);
  } finally {
    await closeApi(api);
    store.close();
  }
});

test("automation routes: away settings and group list", async () => {
  const store = createSqliteMessageStore({ file: ":memory:" });
  const template = store.saveTemplate({ title: "Away", body: "brb" });
  const connection = {
    getStatus: () => ({ state: "open" }),
    listGroups: async () => [{ id: GROUP_A, subject: "Team", size: 4 }, { id: GROUP_B, size: 2 }],
  };
  const api = createApiServer({ messageStore: store, connection, startScheduler: false });
  const base = await listen(api);
  const put = (p, body) =>
    fetch(`${base}${p}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  try {
    assert.equal((await (await fetch(`${base}/api/automation/away`)).json()).away.enabled, false);

    const bad = await put("/api/automation/away", { enabled: true });
    assert.equal(bad.status, 400, "away needs a template");

    const saved = await put("/api/automation/away", { enabled: true, start: "22:00", end: "07:00", templateId: template.id, timeZone: "Africa/Lagos" });
    assert.equal(saved.status, 200);
    const { away } = await saved.json();
    assert.equal(away.enabled, true);
    assert.equal(away.templateId, template.id);

    const groups = await (await fetch(`${base}/api/automation/groups`)).json();
    assert.deepEqual(groups.groups, [
      { jid: GROUP_A, name: "Team", memberCount: 4 },
      { jid: GROUP_B, name: null, memberCount: 2 },
    ]);
  } finally {
    await closeApi(api);
    store.close();
  }
});
