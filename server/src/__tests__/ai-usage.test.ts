// The site-wide AI budget: every model attempt is counted per Pacific-time day, new calls stop before the cap so
// running calls can finish, and requests arriving together can't go past it. In-memory database, fake model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { adminOverview } from "../admin.js";
import type { AuthUser } from "../auth.js";
import { loadConfig, type Config } from "../config.js";
import { ApiError } from "../errors.js";
import { aiLimits, aiPeriods, handleFeedback, handleTurn, type Deps } from "../handlers.js";
import { ScenarioCatalog } from "../scenarios/catalog.js";
import type { Message } from "../types.js";
import { MockLlm, freshStore, goodFeedback } from "./helpers.js";

const ANA: AuthUser = { userId: "11111111-1111-4111-8111-111111111111", email: "ana@example.com" };
const BETO: AuthUser = { userId: "22222222-2222-4222-8222-222222222222", email: "beto@example.com" };
const ids = Array.from({ length: 6 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`);
const FREE = "service-late-fee";
const GREETING = "Thank you for calling, my name is Ana. How can I help you?";
const turnJson = (line: string) => JSON.stringify({ line, end: false });
const code = (c: string, status: number) => (e: unknown) => {
  if (!(e instanceof ApiError)) throw e;
  assert.equal(e.code, c);
  assert.equal(e.status, status);
  return true;
};

async function setup(aiCap: Partial<Config["aiCap"]> = {}, now?: () => Date) {
  const store = await freshStore();
  await store.touchProfile(ANA.userId, ANA.email);
  await store.touchProfile(BETO.userId, BETO.email);
  await store.setPro(ANA.userId, true, null);
  const catalog = new ScenarioCatalog(store);
  await catalog.refresh();
  const base = loadConfig({ ANTHROPIC_API_KEY: "test" });
  const llm = new MockLlm([]);
  const deps: Deps = { config: { ...base, aiCap: { ...base.aiCap, ...aiCap } }, catalog, store, llm, now };
  const usage = () => store.aiUsage(aiPeriods(now ? now() : new Date(), deps.config.aiCap.timeZone));
  return { deps, store, llm, usage };
}

/** One honest turn on call `id`; `h` is the page's history so far (ends with the caller, or is empty). */
async function turn(deps: Deps, llm: MockLlm, id: string, h: Message[], user = ANA) {
  const history: Message[] = h.length ? [...h, { role: "agent", text: `Agent line ${h.length}.` }] : [{ role: "agent", text: GREETING }];
  llm.push(turnJson(`Caller line ${h.length}.`));
  const out = await handleTurn(deps, user, { sessionId: id, scenarioId: FREE, history });
  return [...history, { role: "customer" as const, text: out.line }];
}

test("config: defaults fit the free tier (400 a day, new calls stop 50 earlier, Pacific day); 0 is off", () => {
  const c = loadConfig({ ANTHROPIC_API_KEY: "k" }).aiCap;
  assert.deepEqual(c, { dailyRequests: 400, dailyTokens: 0, monthlyRequests: 0, newCallReserve: 50, timeZone: "America/Los_Angeles" });
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k", AI_DAILY_REQUEST_CAP: "0" }).aiCap.dailyRequests, 0);
  assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", AI_DAILY_REQUEST_CAP: "40", AI_NEW_CALL_RESERVE: "40" }), /AI_NEW_CALL_RESERVE/);
  assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", AI_QUOTA_TIMEZONE: "Mars/Base" }), /AI_QUOTA_TIMEZONE/);
});

test("aiPeriods: the AI day turns at midnight Pacific, summer and winter time", () => {
  const p = (iso: string) => aiPeriods(new Date(iso), "America/Los_Angeles");
  assert.deepEqual(p("2026-10-15T06:59:59Z"), { day: "d:2026-10-14", month: "m:2026-10" }); // 23:59 PDT
  assert.deepEqual(p("2026-10-15T07:00:00Z"), { day: "d:2026-10-15", month: "m:2026-10" });
  assert.deepEqual(p("2026-12-01T07:59:59Z"), { day: "d:2026-11-30", month: "m:2026-11" }); // 23:59 PST
  assert.deepEqual(p("2026-12-01T08:00:00Z"), { day: "d:2026-12-01", month: "m:2026-12" });
});

test("aiLimits: a new call leaves the reserve for running calls; 0 stays off", () => {
  const cap = { dailyRequests: 400, dailyTokens: 9000, monthlyRequests: 1000, newCallReserve: 50, timeZone: "UTC" };
  assert.deepEqual(aiLimits(cap, true), { dayRequests: 350, dayTokens: 9000, monthRequests: 950 });
  assert.deepEqual(aiLimits(cap, false), { dayRequests: 400, dayTokens: 9000, monthRequests: 1000 });
  assert.deepEqual(aiLimits({ ...cap, dailyRequests: 0, monthlyRequests: 0 }, true), { dayRequests: 0, dayTokens: 9000, monthRequests: 0 });
});

test("store: reservations arriving together stop exactly at the limit; day, month and token limits all hold", async () => {
  const { store } = await setup();
  const p = { day: "d:2026-10-15", month: "m:2026-10" };
  const got = await Promise.all(Array.from({ length: 30 }, () => store.reserveAiRequest(p, { dayRequests: 10, dayTokens: 0, monthRequests: 0 })));
  assert.equal(got.filter(Boolean).length, 10);
  assert.deepEqual(await store.aiUsage(p), { day: { requests: 10, tokens: 0 }, month: { requests: 10, tokens: 0 } });

  const next = { day: "d:2026-10-16", month: "m:2026-10" };
  assert.equal(await store.reserveAiRequest(next, { dayRequests: 10, dayTokens: 0, monthRequests: 11 }), true, "month at 11 of 11 after this");
  assert.equal(await store.reserveAiRequest(next, { dayRequests: 10, dayTokens: 0, monthRequests: 11 }), false, "the month is full");
  await store.addAiTokens(next, 500);
  assert.equal(await store.reserveAiRequest(next, { dayRequests: 0, dayTokens: 500, monthRequests: 0 }), false, "the day's tokens are used up");
  assert.deepEqual((await store.aiUsage(next)).day, { requests: 1, tokens: 500 });
  assert.deepEqual((await store.aiUsage(next)).month, { requests: 11, tokens: 500 }, "refused reservations count nothing");
});

test("every model attempt counts: replies, retries and failed requests; replays and refusals don't", async () => {
  const { deps, llm, usage } = await setup();
  const h = await turn(deps, llm, ids[0]!, []);
  assert.deepEqual((await usage()).day, { requests: 1, tokens: 150 });

  llm.push("not json", turnJson("Caller line after a retry."));
  await handleTurn(deps, ANA, { sessionId: ids[0], scenarioId: FREE, history: [...h, { role: "agent", text: "Agent line 2." }] });
  assert.equal((await usage()).day.requests, 3, "the retry is a second request");

  llm.push(new ApiError(502, "llm_unavailable", "down"));
  const h2 = [...h, { role: "agent" as const, text: "Agent line 2." }, { role: "customer" as const, text: "Caller line after a retry." }, { role: "agent" as const, text: "Agent line 4." }];
  await assert.rejects(handleTurn(deps, ANA, { sessionId: ids[0], scenarioId: FREE, history: h2 }), code("llm_unavailable", 502));
  assert.deepEqual((await usage()).day, { requests: 4, tokens: 450 }, "a failed request counts; its tokens are unknown");

  await handleTurn(deps, ANA, { sessionId: ids[0], scenarioId: FREE, history: [{ role: "agent", text: GREETING }] }); // replay
  assert.equal((await usage()).day.requests, 4, "a stored reply costs nothing");
});

test("a new call is refused at cap − reserve; a running call goes on to the cap, and scoring is refused only there", async () => {
  const { deps, store, llm, usage } = await setup({ dailyRequests: 10, newCallReserve: 4 });
  let a = await turn(deps, llm, ids[0]!, []); // call A starts: 1
  for (const id of ids.slice(1, 6)) await turn(deps, llm, id, []); // five more calls start: 6 = 10 - 4
  assert.equal((await usage()).day.requests, 6);

  const before = llm.calls.length;
  await assert.rejects(handleTurn(deps, ANA, { sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", scenarioId: FREE, history: [{ role: "agent", text: GREETING }] }),
    (e: unknown) => code("ai_capacity", 503)(e) && /today's practice limit/.test((e as ApiError).message));
  assert.equal(llm.calls.length, before, "the AI is not asked");
  assert.equal((await store.getCall("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"))?.turns ?? 0, 0, "the refused call doesn't count as a call");

  for (let i = 0; i < 4; i++) a = await turn(deps, llm, ids[0]!, a); // call A continues: 7, 8, 9, 10
  assert.equal((await usage()).day.requests, 10);
  await assert.rejects(handleTurn(deps, ANA, { sessionId: ids[0], scenarioId: FREE, history: [...a, { role: "agent", text: "One more." }] }), code("ai_capacity", 503));
  llm.push(goodFeedback);
  await assert.rejects(handleFeedback(deps, ANA, { sessionId: ids[0], scenarioId: FREE }), code("ai_capacity", 503));
  assert.equal((await store.getCall(ids[0]!))!.finishedAt, null, "nothing is lost: the call can still be scored once there's room");

  // With room again (here: a higher cap), the same call is scored normally.
  const roomier = { ...deps, config: { ...deps.config, aiCap: { ...deps.config.aiCap, dailyRequests: 20 } } };
  const fb = await handleFeedback(roomier, ANA, { sessionId: ids[0], scenarioId: FREE });
  assert.equal(fb.qaScore, 60);
  assert.equal((await usage()).day.requests, 11);
});

test("the free daily limit is separate and unchanged", async () => {
  const { deps, llm, usage } = await setup();
  await turn(deps, llm, ids[0]!, [], BETO);
  await turn(deps, llm, ids[1]!, [], BETO);
  await assert.rejects(handleTurn(deps, BETO, { sessionId: ids[2], scenarioId: FREE, history: [{ role: "agent", text: GREETING }] }), code("daily_limit", 403));
  assert.equal((await usage()).day.requests, 2, "a refused free call costs no AI request");
});

test("admin overview: today's and this month's AI numbers next to the caps", async () => {
  const { deps, llm } = await setup({ dailyRequests: 400, newCallReserve: 50 });
  await turn(deps, llm, ids[0]!, []);
  const o = await adminOverview(deps);
  assert.equal(o.ai.timeZone, "America/Los_Angeles");
  assert.deepEqual(o.ai.today, { requests: 1, tokens: 150, cap: 400, newCallsStopAt: 350, tokenCap: null });
  assert.deepEqual(o.ai.month, { requests: 1, tokens: 150, cap: null });
});
