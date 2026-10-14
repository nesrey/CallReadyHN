import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { PgStore } from "../db/pgStore.js";
import { proActive } from "../db/store.js";
import { parseFeedbackOutput } from "../llm/parse.js";
import { CUSTOMER_RUBRIC } from "../llm/rubric.js";
import { loadScenariosFromDisk } from "../scenarios/load.js";
import { exchanges, freshStore, goodFeedback } from "./helpers.js";

const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const fb = () => parseFeedbackOutput(goodFeedback, CUSTOMER_RUBRIC);

test("db: migrate is idempotent and seeding never duplicates or overwrites", async () => {
  const store = await freshStore();
  await store.migrate();
  const seed = loadScenariosFromDisk();
  assert.equal(await store.seedScenarios(seed), 0);
  const list = await store.listScenarios();
  assert.deepEqual(list.map((s) => s.id), seed.map((s) => s.id));
  assert.ok(list.every((s) => s.enabled));

  await store.saveScenario({ ...seed[0]!, summary: "Edited summary." }, true);
  await store.seedScenarios(seed);
  assert.equal((await store.listScenarios())[0]!.summary, "Edited summary.");
});

test("db: scenarios round-trip with the desk panel, new ones go last, and can be disabled", async () => {
  const store = await freshStore();
  const base = loadScenariosFromDisk()[1]!;
  await store.saveScenario({ ...base, id: "new-one", hiddenFacts: ["a", "b"] }, false);
  const list = await store.listScenarios();
  const last = list[list.length - 1]!;
  assert.equal(last.id, "new-one");
  assert.equal(last.enabled, false);
  assert.deepEqual(last.account, base.account);
  assert.deepEqual(last.policies, base.policies);
  assert.deepEqual(last.hiddenFacts, ["a", "b"]);
  assert.deepEqual(last.persona, base.persona);
  assert.equal(last.temperament, base.temperament);
  assert.equal(await store.setScenarioEnabled("new-one", true), true);
  assert.equal(await store.setScenarioEnabled("missing", true), false);
});

test("db: version 1 accounts and the free limit carry over; old calls stay behind", async () => {
  const db = new PGlite();
  await db.exec(`create schema callready;
    create table callready.profiles (user_id uuid primary key, email text not null, goal text, level text,
      is_pro boolean not null default false, pro_until timestamptz, created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now());
    create table callready.settings (id boolean primary key default true, free_daily_limit integer not null default 2,
      pro_instructions_es text not null default 'x', updated_at timestamptz not null default now());
    insert into callready.profiles (user_id, email, goal, level, is_pro) values ('${U1}', 'ana@example.com', 'job', 'B1', true);
    insert into callready.settings (id, free_daily_limit) values (true, 4);`);
  const store = new PgStore(db);
  await store.migrate();
  const p = (await store.getProfile(U1))!;
  assert.equal(p.email, "ana@example.com");
  assert.equal(p.isPro, true);
  assert.equal(p.role, null, "goal/level do not map to the new role");
  assert.equal((await store.getSettings()).freeDailyLimit, 4);
  await store.migrate(); // a second start changes nothing
  assert.equal((await store.getSettings()).freeDailyLimit, 4);
});

test("db: profiles are created on first sign-in and keep role and interests", async () => {
  const store = await freshStore();
  assert.equal(await store.getProfile(U1), null);
  await store.touchProfile(U1, "ana@example.com");
  await store.updateProfile(U1, "agent", ["collections", "tech"]);
  await store.touchProfile(U1, "ana.new@example.com");
  const p = (await store.getProfile(U1))!;
  assert.equal(p.email, "ana.new@example.com");
  assert.equal(p.role, "agent");
  assert.deepEqual(p.interests, ["collections", "tech"]);
  assert.equal(p.isPro, false);
});

test("db: only calls the AI answered count toward the daily limit", async () => {
  const store = await freshStore();
  await store.touchProfile(U1, "ana@example.com");
  const since = new Date(Date.now() - 60_000);
  await store.createCall({ id: C1, userId: U1, scenarioId: "service-late-fee" });
  await store.createCall({ id: C2, userId: U1, scenarioId: "tech-wifi-down" });
  assert.equal(await store.countCallsSince(U1, since), 0);
  await store.recordUsage(C1, 120, false);
  await store.recordUsage(C1, 150, true);
  const c = (await store.getCall(C1))!;
  assert.equal(c.turns, 1);
  assert.equal(c.tokens, 270);
  assert.equal(await store.countCallsSince(U1, since), 1);
  assert.equal(await store.countCallsSince(U1, new Date(Date.now() + 60_000)), 0);
});

test("db: the scorecard and transcript are stored once and read back exactly", async () => {
  const store = await freshStore();
  await store.touchProfile(U1, "ana@example.com");
  await store.createCall({ id: C1, userId: U1, scenarioId: "service-late-fee" });
  const transcript = exchanges(2);
  assert.equal(await store.saveFeedback(C1, 185, 60, fb(), transcript), true);
  assert.equal(await store.saveFeedback(C1, 185, 60, fb(), transcript), false);

  const d = (await store.getCallDetail(U1, C1))!;
  assert.deepEqual(d.feedback, fb());
  assert.deepEqual(d.transcript, transcript);
  assert.equal(d.durationSec, 185);
  assert.equal(d.qaScore, 60);
  assert.equal(d.title, "Late fee question");
  assert.equal(d.callType, "service");
  assert.equal(d.temperament, "calm");
  assert.equal(await store.getCallDetail(U2, C1), null, "other users cannot read it");
  assert.deepEqual((await store.listCalls(U1, 10)).map((c) => c.id), [C1]);
});

test("db: admin user list, search, Pro and usage", async () => {
  const store = await freshStore();
  await store.touchProfile(U1, "ana_lopez@example.com");
  await store.touchProfile(U2, "beto@example.com");
  await store.createCall({ id: C1, userId: U1, scenarioId: "service-late-fee" });
  await store.recordUsage(C1, 500, true);
  await store.saveFeedback(C1, 60, 72, fb(), exchanges(1));

  const all = await store.listUsers({ query: "", limit: 50, offset: 0 });
  assert.equal(all.total, 2);
  const ana = all.users.find((u) => u.userId === U1)!;
  assert.equal(ana.calls, 1);
  assert.equal(ana.tokens, 500);
  assert.equal(ana.avgQa, 72);
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
  assert.equal(usage[0]!.qa, 72);
});

test("db: existing calls become legacy calls; new columns are added once and safely", async () => {
  const db = new PGlite();
  const store = new PgStore(db);
  await store.migrate();
  await store.seedScenarios(loadScenariosFromDisk());
  await store.touchProfile(U1, "ana@example.com");
  await db.query(`insert into callready_v2.calls (id, user_id, scenario_id) values ($1, $2, 'service-late-fee')`, [C1, U1]);
  await store.migrate(); // the next start runs the same script again
  const c = (await store.getCall(C1))!;
  assert.equal(c.serverTranscript, false, "a row from before the change keeps the browser transcript");
  assert.equal(c.callerEndedAt, null);
  assert.equal(await store.createCall({ id: C2, userId: U1, scenarioId: "tech-wifi-down", serverTranscript: true }), true);
  assert.equal((await store.getCall(C2))!.serverTranscript, true);
  assert.equal(await store.createCall({ id: C2, userId: U2, scenarioId: "tech-wifi-down" }), false, "an existing id is never overwritten");
  assert.equal((await store.getCall(C2))!.userId, U1);
});

test("db: leases are fenced by their token; an expired holder can't write or release a newer lease", async () => {
  const store = await freshStore();
  await store.touchProfile(U1, "ana@example.com");
  await store.createCall({ id: C1, userId: U1, scenarioId: "service-late-fee", serverTranscript: true });
  const old = "00000000-0000-4000-8000-000000000001";
  const fresh = "00000000-0000-4000-8000-000000000002";
  const turn = (token: string, position: number) => ({
    callId: C1, userId: U1, leaseToken: token, position, agentText: `agent ${position}`, callerText: `caller ${position}`, tokens: 100, ended: false,
  });

  assert.ok(await store.acquireLease(C1, U1, old, -1), "the old request's lease has run out");
  assert.ok(await store.acquireLease(C1, U1, fresh, 90), "so a newer request takes the call");
  assert.equal(await store.acquireLease(C1, U1, "00000000-0000-4000-8000-000000000003", 90), null, "one holder at a time");
  assert.equal(await store.commitTurn(turn(old, 0)), false, "the expired request can't store its turn");
  await store.releaseLease(C1, U1, old, 50);
  assert.equal(await store.acquireLease(C1, U1, "00000000-0000-4000-8000-000000000004", 90), null, "nor release the newer lease");
  assert.equal((await store.getCall(C1))!.tokens, 50, "but its tokens are still counted");

  assert.equal(await store.commitTurn(turn(fresh, 0)), true);
  assert.equal(await store.commitTurn(turn(fresh, 2)), false, "a lease is used up by its commit");
  assert.deepEqual(await store.getTurns(C1, U1), [{ role: "agent", text: "agent 0" }, { role: "customer", text: "caller 0" }]);
  const c = (await store.getCall(C1))!;
  assert.equal(c.turns, 1);
  assert.equal(c.tokens, 150);
  assert.equal(await store.acquireLease(C1, U2, fresh, 90), null, "only the owner can take a call");
});

test("db: a turn is stored completely or not at all", async () => {
  const store = await freshStore();
  await store.touchProfile(U1, "ana@example.com");
  await store.createCall({ id: C1, userId: U1, scenarioId: "service-late-fee", serverTranscript: true });
  const t1 = "00000000-0000-4000-8000-000000000001";
  assert.ok(await store.acquireLease(C1, U1, t1, 90));
  await store.commitTurn({ callId: C1, userId: U1, leaseToken: t1, position: 0, agentText: "a", callerText: "c", tokens: 10, ended: false });
  const t2 = "00000000-0000-4000-8000-000000000002";
  assert.ok(await store.acquireLease(C1, U1, t2, 90));
  // Position 0 is taken: the insert fails, and the counters must not move either.
  await assert.rejects(store.commitTurn({ callId: C1, userId: U1, leaseToken: t2, position: 0, agentText: "x", callerText: "y", tokens: 10, ended: true }));
  const c = (await store.getCall(C1))!;
  assert.equal(c.turns, 1);
  assert.equal(c.tokens, 10);
  assert.equal(c.callerEndedAt, null);
  assert.equal((await store.getTurns(C1, U1)).length, 2);
});

test("db: scoring with a lease only saves while the lease is held, and frees the call", async () => {
  const store = await freshStore();
  await store.touchProfile(U1, "ana@example.com");
  await store.createCall({ id: C1, userId: U1, scenarioId: "service-late-fee", serverTranscript: true });
  const stale = "00000000-0000-4000-8000-000000000001";
  assert.ok(await store.acquireLease(C1, U1, stale, -1));
  assert.equal(await store.saveFeedback(C1, 60, 60, fb(), null, stale), false, "an expired lease can't save");
  const live = "00000000-0000-4000-8000-000000000002";
  assert.ok(await store.acquireLease(C1, U1, live, 90));
  assert.equal(await store.saveFeedback(C1, 60, 60, fb(), null, live), true);
  assert.equal((await store.getCallDetail(U1, C1))!.qaScore, 60);
});

test("db: settings default and update", async () => {
  const store = await freshStore();
  const s = await store.getSettings();
  assert.equal(s.freeDailyLimit, 2);
  assert.match(s.proInstructions, /Pro/);
  await store.updateSettings({ freeDailyLimit: 5, proInstructions: "Pay by transfer." });
  assert.deepEqual(await store.getSettings(), { freeDailyLimit: 5, proInstructions: "Pay by transfer." });
});
