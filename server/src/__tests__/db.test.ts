import { test } from "node:test";
import assert from "node:assert/strict";
import { proActive } from "../db/store.js";
import { parseFeedbackOutput } from "../llm/parse.js";
import { loadScenariosFromDisk } from "../scenarios/load.js";
import { freshStore, goodFeedback } from "./helpers.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("db: migrate is idempotent and seeding never duplicates or overwrites", async () => {
  const store = await freshStore();
  await store.migrate();
  const seed = loadScenariosFromDisk();
  assert.equal(await store.seedScenarios(seed), 0);
  const list = await store.listScenarios();
  assert.deepEqual(list.map((s) => s.id), seed.map((s) => s.id));
  assert.ok(list.every((s) => s.enabled));

  const edited = { ...seed[0]!, summaryEs: "Texto editado." };
  await store.saveScenario(edited, true);
  await store.seedScenarios(seed);
  assert.equal((await store.listScenarios())[0]!.summaryEs, "Texto editado.");
});

test("db: scenarios round-trip, new ones go last, and can be disabled", async () => {
  const store = await freshStore();
  const base = loadScenariosFromDisk()[1]!;
  await store.saveScenario({ ...base, id: "new-one", hiddenFacts: ["a", "b"] }, false);
  const list = await store.listScenarios();
  const last = list[list.length - 1]!;
  assert.equal(last.id, "new-one");
  assert.equal(last.enabled, false);
  assert.deepEqual(last.hiddenFacts, ["a", "b"]);
  assert.deepEqual(last.persona, base.persona);
  assert.equal(await store.setScenarioEnabled("new-one", true), true);
  assert.equal(await store.setScenarioEnabled("missing", true), false);
});

test("db: profiles are created on first sign-in and keep goal/level", async () => {
  const store = await freshStore();
  assert.equal(await store.getProfile(U1), null);
  await store.touchProfile(U1, "ana@example.com");
  await store.updateGoalLevel(U1, "job", "B1");
  await store.touchProfile(U1, "ana.new@example.com");
  const p = (await store.getProfile(U1))!;
  assert.equal(p.email, "ana.new@example.com");
  assert.equal(p.goal, "job");
  assert.equal(p.level, "B1");
  assert.equal(p.isPro, false);
});

test("db: only calls the AI answered count toward the daily limit", async () => {
  const store = await freshStore();
  await store.touchProfile(U1, "ana@example.com");
  const since = new Date(Date.now() - 60_000);
  await store.createCall({ id: C1, userId: U1, scenarioId: "billing-dispute" });
  await store.createCall({ id: C2, userId: U1, scenarioId: "order-status" });
  assert.equal(await store.countCallsSince(U1, since), 0);
  await store.recordUsage(C1, 120, false); // failed attempt: tokens, no turn
  await store.recordUsage(C1, 150, true);
  const c = (await store.getCall(C1))!;
  assert.equal(c.turns, 1);
  assert.equal(c.tokens, 270);
  assert.equal(c.userId, U1);
  assert.equal(await store.countCallsSince(U1, since), 1);
  assert.equal(await store.countCallsSince(U1, new Date(Date.now() + 60_000)), 0);
});

test("db: feedback is stored once and read back exactly", async () => {
  const store = await freshStore();
  await store.touchProfile(U1, "ana@example.com");
  await store.createCall({ id: C1, userId: U1, scenarioId: "billing-dispute" });
  const f = parseFeedbackOutput(goodFeedback);
  assert.equal(await store.saveFeedback(C1, 185, f), true);
  assert.equal(await store.saveFeedback(C1, 185, f), false);

  const d = (await store.getCallDetail(U1, C1))!;
  assert.deepEqual(d.feedback, f);
  assert.equal(d.durationSec, 185);
  assert.equal(d.avg, 6);
  assert.equal(d.titleEs, "Disputa de facturación");
  assert.equal(await store.getCallDetail(U2, C1), null, "other users cannot read it");

  const list = await store.listCalls(U1, 10);
  assert.deepEqual(list.map((c) => c.id), [C1]);
  assert.equal((await store.getCall(C1))!.finishedAt instanceof Date, true);
});

test("db: admin user list, search, Pro and usage", async () => {
  const store = await freshStore();
  await store.touchProfile(U1, "ana_lopez@example.com");
  await store.touchProfile(U2, "beto@example.com");
  await store.createCall({ id: C1, userId: U1, scenarioId: "billing-dispute" });
  await store.recordUsage(C1, 500, true);
  await store.saveFeedback(C1, 60, parseFeedbackOutput(goodFeedback));

  const all = await store.listUsers({ query: "", limit: 50, offset: 0 });
  assert.equal(all.total, 2);
  const ana = all.users.find((u) => u.userId === U1)!;
  assert.equal(ana.calls, 1);
  assert.equal(ana.tokens, 500);
  assert.equal(ana.avgScore, 6);
  assert.equal(all.users.find((u) => u.userId === U2)!.lastCallAt, null);

  assert.deepEqual((await store.listUsers({ query: "ANA_", limit: 50, offset: 0 })).users.map((u) => u.email), ["ana_lopez@example.com"]);
  assert.equal((await store.listUsers({ query: "a%o", limit: 50, offset: 0 })).total, 0, "% is literal");
  assert.equal((await store.listUsers({ query: "", limit: 1, offset: 1 })).users.length, 1);

  const until = new Date(Date.now() + 86400_000);
  assert.equal(await store.setPro(U2, true, until), true);
  const p = (await store.getProfile(U2))!;
  assert.equal(proActive(p, new Date()), true);
  assert.equal(proActive(p, new Date(until.getTime() + 1)), false);
  await store.setPro(U2, false, until);
  assert.equal((await store.getProfile(U2))!.proUntil, null);
  assert.equal(proActive({ isPro: true, proUntil: null }, new Date()), true);

  const usage = await store.usageSince(new Date(Date.now() - 3600_000));
  assert.equal(usage.length, 1);
  assert.equal(usage[0]!.tokens, 500);
  assert.equal(usage[0]!.avg, 6);
});

test("db: settings default and update", async () => {
  const store = await freshStore();
  const s = await store.getSettings();
  assert.equal(s.freeDailyLimit, 2);
  assert.match(s.proInstructionsEs, /Pro/);
  await store.updateSettings({ freeDailyLimit: 5, proInstructionsEs: "Escriba a soporte." });
  assert.deepEqual(await store.getSettings(), { freeDailyLimit: 5, proInstructionsEs: "Escriba a soporte." });
});
