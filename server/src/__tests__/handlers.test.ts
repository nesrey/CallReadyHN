import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthUser } from "../auth.js";
import { loadConfig } from "../config.js";
import type { PgStore } from "../db/pgStore.js";
import { ApiError } from "../errors.js";
import { handleFeedback, handleTurn, type Deps } from "../handlers.js";
import { parseFeedbackOutput } from "../llm/parse.js";
import { CUSTOMER_RUBRIC } from "../llm/rubric.js";
import { ScenarioCatalog } from "../scenarios/catalog.js";
import type { Message } from "../types.js";
import { CUSTOMER_KEYS, MockLlm, exchanges, feedbackFor, freshStore, goodFeedback, recordTurns } from "./helpers.js";

const config = loadConfig({ ANTHROPIC_API_KEY: "test", SESSION_TOKEN_CAP: "10000", FEEDBACK_TOKEN_RESERVE: "4000" });
const ANA: AuthUser = { userId: "11111111-1111-4111-8111-111111111111", email: "ana@example.com" };
const BETO: AuthUser = { userId: "22222222-2222-4222-8222-222222222222", email: "beto@example.com" };
const CALL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ids = Array.from({ length: 5 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`);
const FREE = "service-late-fee";
const FREE_2 = "tech-wifi-down";
const PRO = "service-double-charge";

async function setup(responses: Array<string | Error> = [], now?: () => Date) {
  const store = await freshStore();
  await store.touchProfile(ANA.userId, ANA.email);
  await store.touchProfile(BETO.userId, BETO.email);
  const catalog = new ScenarioCatalog(store);
  await catalog.refresh();
  const llm = new MockLlm(responses);
  const deps: Deps = { config, catalog, store, llm, now };
  return { deps, store, llm };
}

/**
 * A call in progress whose first `turns` exchanges are already stored by the server (as exchanges(turns) has them),
 * plus `tokens` already used. The forgery and concurrency cases are in transcripts.test.ts.
 */
async function ongoing(store: PgStore, id = CALL, user = ANA, scenarioId = FREE, tokens = 0, turns = 1) {
  await store.createCall({ id, userId: user.userId, scenarioId });
  await recordTurns(store, id, user.userId, exchanges(turns));
  if (tokens) await store.recordUsage(id, tokens, false);
}

const body = (history: Message[], extra: Record<string, unknown> = {}) => ({
  sessionId: CALL,
  scenarioId: FREE,
  history,
  ...extra,
});
const greeting = exchanges(0);
const turnJson = (line: string, end = false) => JSON.stringify({ line, end });
const code = (c: string, status: number) => (e: unknown) => {
  if (!(e instanceof ApiError)) throw e;
  assert.equal(e.code, c);
  assert.equal(e.status, status);
  return true;
};

test("turn: the agent's greeting creates the call and the caller answers", async () => {
  const { deps, store, llm } = await setup([turnJson("Hi, I have a question about a late fee.")]);
  const out = await handleTurn(deps, ANA, body(greeting));
  assert.equal(out.line, "Hi, I have a question about a late fee.");
  assert.equal(out.turnNumber, 1);
  assert.equal(out.usage.sessionTokensUsed, 150);
  assert.match(llm.calls[0]!.system, /turn #1 of at most 10/);
  assert.match(llm.calls[0]!.messages[0]!.content, /Thank you for calling/);
  const call = (await store.getCall(CALL))!;
  assert.equal(call.userId, ANA.userId);
  assert.equal(call.turns, 1);
  assert.equal(call.tokens, 150);
});

test("turn: a call cannot start without the agent's greeting", async () => {
  const { deps } = await setup([]);
  await assert.rejects(handleTurn(deps, ANA, body([])), code("invalid_request", 400));
});

test("turn: end rules (never before min, model decides between, forced at max)", async () => {
  let s = await setup([turnJson("Okay, goodbye!", true)]);
  await ongoing(s.store, CALL, ANA, FREE, 0, 2);
  assert.equal((await handleTurn(s.deps, ANA, body(exchanges(2)))).callEnded, false);

  s = await setup([turnJson("Thanks, bye!", true)]);
  await ongoing(s.store, CALL, ANA, FREE, 0, 6);
  assert.equal((await handleTurn(s.deps, ANA, body(exchanges(6)))).callEnded, true);

  s = await setup([turnJson("One more thing...", false)]);
  await ongoing(s.store, CALL, ANA, FREE, 0, 9);
  const out = await handleTurn(s.deps, ANA, body(exchanges(9)));
  assert.equal(out.turnNumber, 10);
  assert.equal(out.callEnded, true);

  s = await setup([]);
  await ongoing(s.store, CALL, ANA, FREE, 0, 10);
  await assert.rejects(handleTurn(s.deps, ANA, body(exchanges(10))), code("call_over", 400));
});

test("turn: calls belong to one user and one scenario", async () => {
  const { deps, store } = await setup([]);
  await assert.rejects(handleTurn(deps, ANA, body(exchanges(1))), code("not_found", 404), "unknown call mid-way");
  await ongoing(store);
  await assert.rejects(handleTurn(deps, BETO, body(exchanges(1))), code("not_found", 404), "someone else's call");
  await assert.rejects(handleTurn(deps, ANA, body(exchanges(1), { scenarioId: FREE_2 })), code("invalid_request", 400));
  await store.saveFeedback(CALL, 30, 60, parseFeedbackOutput(goodFeedback, CUSTOMER_RUBRIC));
  await assert.rejects(handleTurn(deps, ANA, body(exchanges(1))), code("call_over", 400), "finished call");
});

test("turn: unknown or disabled scenario and bad shapes", async () => {
  const { deps, store } = await setup([]);
  await assert.rejects(handleTurn(deps, ANA, body(greeting, { scenarioId: "nope" })), code("unknown_scenario", 404));
  await store.setScenarioEnabled(FREE, false);
  await deps.catalog.refresh();
  await assert.rejects(handleTurn(deps, ANA, body(greeting)), code("unknown_scenario", 404));
  await assert.rejects(handleTurn(deps, ANA, { nope: 1 }), code("invalid_request", 400));
  await assert.rejects(handleTurn(deps, ANA, body(greeting, { sessionId: "not-a-uuid", scenarioId: FREE_2 })), code("invalid_request", 400));
});

test("turn: retry tokens are counted; a failed first turn does not use a free call", async () => {
  let s = await setup(["not json at all", turnJson("Sorry, could you repeat that?")]);
  const out = await handleTurn(s.deps, ANA, body(greeting));
  assert.equal(out.line, "Sorry, could you repeat that?");
  assert.equal(out.usage.sessionTokensUsed, 300);

  s = await setup(["x", "y"]);
  await assert.rejects(handleTurn(s.deps, ANA, body(greeting)), code("llm_bad_output", 502));
  const call = (await s.store.getCall(CALL))!;
  assert.equal(call.turns, 0);
  assert.equal(call.tokens, 300);
  assert.equal(await s.store.countCallsSince(ANA.userId, new Date(0)), 0);
});

test("limits: free accounts get the daily number of calls and calm scenarios only", async () => {
  const { deps, store } = await setup(ids.map(() => turnJson("Hi.")));
  await assert.rejects(handleTurn(deps, ANA, body(greeting, { scenarioId: PRO })), code("pro_required", 403));
  await handleTurn(deps, ANA, body(greeting, { sessionId: ids[0] }));
  await handleTurn(deps, ANA, body(greeting, { sessionId: ids[1] }));
  await assert.rejects(handleTurn(deps, ANA, body(greeting, { sessionId: ids[2] })), code("daily_limit", 403));
  assert.equal(await store.getCall(ids[2]!), null, "a refused call is not created");
  await handleTurn(deps, BETO, body(greeting, { sessionId: ids[2] })); // other users are unaffected

  await store.updateSettings({ freeDailyLimit: 3, proInstructions: "x" });
  await handleTurn(deps, ANA, body(greeting, { sessionId: ids[3] }));
});

test("limits: the daily count resets at local midnight", async () => {
  const tomorrow = new Date(Date.now() + 36 * 3600_000);
  const { deps, store } = await setup([turnJson("Hi.")]);
  for (const id of ids.slice(0, 2)) await ongoing(store, id);
  deps.now = () => tomorrow;
  await handleTurn(deps, ANA, body(greeting));
});

test("limits: Pro has no limits until it expires", async () => {
  const { deps, store } = await setup(ids.map(() => turnJson("Hi.")));
  for (const id of ids.slice(0, 2)) await ongoing(store, id);
  await store.setPro(ANA.userId, true, new Date(Date.now() + 86400_000));
  await handleTurn(deps, ANA, body(greeting, { scenarioId: PRO }));

  await store.setPro(ANA.userId, true, new Date(Date.now() - 1000)); // expired
  await assert.rejects(handleTurn(deps, ANA, body(greeting, { sessionId: ids[4] })), code("daily_limit", 403));
});

test("turn: stops at the turn budget, but feedback stays possible", async () => {
  const { deps, store } = await setup([goodFeedback]);
  await ongoing(store, CALL, ANA, FREE, 6_500, 3); // cap 10000 - reserve 4000 = 6000
  await assert.rejects(handleTurn(deps, ANA, body(exchanges(3))), code("session_token_cap", 429));
  const fb = await handleFeedback(deps, ANA, body(exchanges(3)));
  assert.equal(fb.qaScore, 60);
});

test("feedback: QA scorecard with labels, saved with the transcript; asking again returns the saved copy", async () => {
  const { deps, store, llm } = await setup([goodFeedback]);
  await ongoing(store, CALL, ANA, FREE, 0, 3);
  const out = await handleFeedback(deps, ANA, body(exchanges(3)));
  assert.equal(out.callId, CALL);
  assert.equal(out.qaScore, 60);
  assert.deepEqual(out.criteria.map((c) => c.key), CUSTOMER_KEYS);
  assert.equal(out.criteria.find((c) => c.key === "resolution")!.label, "Resolution");
  assert.equal(out.criteria.find((c) => c.key === "resolution")!.weight, 20);
  assert.match(llm.calls[0]!.messages[0]!.content, /AGENT: Agent answer number 1/);
  assert.match(llm.calls[0]!.system, /Policies the agent had to follow/);

  const saved = (await store.getCallDetail(ANA.userId, CALL))!;
  assert.equal(saved.qaScore, 60);
  assert.equal(saved.transcript.length, 6, "the server's 3 stored turns; the page's unanswered last line is not part of it");
  assert.equal((await store.getCall(CALL))!.tokens, 150);

  const again = await handleFeedback(deps, ANA, body(exchanges(3)));
  assert.equal(again.qaScore, 60);
  assert.deepEqual(again.criteria, out.criteria);
  assert.equal(llm.calls.length, 1, "no second model call");
});

test("feedback: interview calls use the interview scorecard", async () => {
  const keys = ["introduction", "clarity", "experience", "situational", "professionalism", "closing"];
  const { deps, store } = await setup([JSON.stringify(feedbackFor(keys, 8))]);
  await store.setPro(ANA.userId, true, null);
  await ongoing(store, CALL, ANA, "interview-bilingual-agent", 0, 3);
  const out = await handleFeedback(deps, ANA, body(exchanges(3), { scenarioId: "interview-bilingual-agent" }));
  assert.deepEqual(out.criteria.map((c) => c.key), keys);
  assert.equal(out.qaScore, 80);
});

test("feedback: refused for thin calls, other users, and spent budgets", async () => {
  const { deps, store, llm } = await setup([goodFeedback]);
  const thin = ids[0]!;
  await ongoing(store, thin);
  await assert.rejects(handleFeedback(deps, ANA, body(exchanges(3), { sessionId: thin })), code("not_enough_speech", 422), "the server's record decides, not the page's");
  await ongoing(store, CALL, ANA, FREE, 0, 3);
  await assert.rejects(handleFeedback(deps, BETO, body(exchanges(3))), code("not_found", 404));
  await store.recordUsage(CALL, 10_000, false);
  await assert.rejects(handleFeedback(deps, ANA, body(exchanges(3))), code("session_token_cap", 429));
  assert.equal(llm.calls.length, 0);
});

test("feedback: retries on invalid output, 502 after two failures", async () => {
  let s = await setup(['{"criteria":{}}', goodFeedback]);
  await ongoing(s.store, CALL, ANA, FREE, 0, 3);
  const out = await handleFeedback(s.deps, ANA, body(exchanges(3)));
  assert.equal(out.qaScore, 60);
  assert.equal(s.llm.calls.length, 2);

  s = await setup(["bad", "bad"]);
  await ongoing(s.store, CALL, ANA, FREE, 0, 3);
  await assert.rejects(handleFeedback(s.deps, ANA, body(exchanges(3))), code("llm_bad_output", 502));
  assert.equal((await s.store.getCall(CALL))!.tokens, 300, "tokens are recorded even when it fails");
});
