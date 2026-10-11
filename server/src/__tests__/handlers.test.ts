import { test } from "node:test";
import assert from "node:assert/strict";
import type { AuthUser } from "../auth.js";
import { loadConfig } from "../config.js";
import type { PgStore } from "../db/pgStore.js";
import { ApiError } from "../errors.js";
import { handleFeedback, handleTurn, type Deps } from "../handlers.js";
import { ScenarioCatalog } from "../scenarios/catalog.js";
import type { Message } from "../types.js";
import { MockLlm, exchanges, freshStore, goodFeedback } from "./helpers.js";

const config = loadConfig({ ANTHROPIC_API_KEY: "test", SESSION_TOKEN_CAP: "10000", FEEDBACK_TOKEN_RESERVE: "4000" });
const ANA: AuthUser = { userId: "11111111-1111-4111-8111-111111111111", email: "ana@example.com" };
const BETO: AuthUser = { userId: "22222222-2222-4222-8222-222222222222", email: "beto@example.com" };
const CALL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ids = Array.from({ length: 5 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-00000000000${i}`);

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

/** A call that already had `n` exchanges, as if earlier turns happened. */
async function ongoing(store: PgStore, id = CALL, user = ANA, scenarioId = "billing-dispute", tokens = 0) {
  await store.createCall({ id, userId: user.userId, scenarioId });
  await store.recordUsage(id, tokens, true);
}

const body = (history: Message[], extra: Record<string, unknown> = {}) => ({
  sessionId: CALL,
  scenarioId: "billing-dispute",
  history,
  ...extra,
});
const turnJson = (line: string, end = false) => JSON.stringify({ line, end });
const code = (c: string, status: number) => (e: unknown) => {
  if (!(e instanceof ApiError)) throw e;
  assert.equal(e.code, c);
  assert.equal(e.status, status);
  return true;
};

test("turn: the first turn creates the call and records usage", async () => {
  const { deps, store, llm } = await setup([turnJson("Hello, I need help with my bill.")]);
  const out = await handleTurn(deps, ANA, body([]));
  assert.equal(out.line, "Hello, I need help with my bill.");
  assert.equal(out.callEnded, false);
  assert.equal(out.turnNumber, 1);
  assert.equal(out.usage.sessionTokensUsed, 150);
  assert.match(llm.calls[0]!.system, /turn #1 of at most 10/);
  const call = (await store.getCall(CALL))!;
  assert.equal(call.userId, ANA.userId);
  assert.equal(call.turns, 1);
  assert.equal(call.tokens, 150);
});

test("turn: end rules (never before min, model decides between, forced at max)", async () => {
  let s = await setup([turnJson("Okay, goodbye!", true)]);
  await ongoing(s.store);
  assert.equal((await handleTurn(s.deps, ANA, body(exchanges(2)))).callEnded, false);

  s = await setup([turnJson("Thanks, bye!", true)]);
  await ongoing(s.store);
  assert.equal((await handleTurn(s.deps, ANA, body(exchanges(6)))).callEnded, true);

  s = await setup([turnJson("One more thing...", false)]);
  await ongoing(s.store);
  const out = await handleTurn(s.deps, ANA, body(exchanges(9)));
  assert.equal(out.turnNumber, 10);
  assert.equal(out.callEnded, true);

  s = await setup([]);
  await ongoing(s.store);
  await assert.rejects(handleTurn(s.deps, ANA, body(exchanges(10))), code("call_over", 400));
});

test("turn: calls belong to one user and one scenario", async () => {
  const { deps, store } = await setup([]);
  await assert.rejects(handleTurn(deps, ANA, body(exchanges(1))), code("not_found", 404), "unknown call mid-way");
  await ongoing(store);
  await assert.rejects(handleTurn(deps, BETO, body(exchanges(1))), code("not_found", 404), "someone else's call");
  await assert.rejects(
    handleTurn(deps, ANA, body(exchanges(1), { scenarioId: "order-status" })),
    code("invalid_request", 400),
  );
  await store.saveFeedback(CALL, 30, JSON.parse(goodFeedback));
  await assert.rejects(handleTurn(deps, ANA, body(exchanges(1))), code("call_over", 400), "finished call");
});

test("turn: unknown or disabled scenario and bad shapes", async () => {
  const { deps, store } = await setup([]);
  await assert.rejects(handleTurn(deps, ANA, body([], { scenarioId: "nope" })), code("unknown_scenario", 404));
  await store.setScenarioEnabled("billing-dispute", false);
  await deps.catalog.refresh();
  await assert.rejects(handleTurn(deps, ANA, body([])), code("unknown_scenario", 404));
  await assert.rejects(handleTurn(deps, ANA, { nope: 1 }), code("invalid_request", 400));
  await assert.rejects(handleTurn(deps, ANA, body([], { sessionId: "not-a-uuid" })), code("invalid_request", 400));
});

test("turn: retry tokens are counted; a failed first turn does not use a free call", async () => {
  let s = await setup(["not json at all", turnJson("Sorry, could you repeat that?")]);
  const out = await handleTurn(s.deps, ANA, body([]));
  assert.equal(out.line, "Sorry, could you repeat that?");
  assert.equal(out.usage.sessionTokensUsed, 300);

  s = await setup(["x", "y"]);
  await assert.rejects(handleTurn(s.deps, ANA, body([])), code("llm_bad_output", 502));
  const call = (await s.store.getCall(CALL))!;
  assert.equal(call.turns, 0);
  assert.equal(call.tokens, 300);
  assert.equal(await s.store.countCallsSince(ANA.userId, new Date(0)), 0);
});

test("limits: free accounts get the daily number of calls and free scenarios only", async () => {
  const { deps, store } = await setup(ids.map(() => turnJson("Hi.")));
  await assert.rejects(handleTurn(deps, ANA, body([], { scenarioId: "job-interview" })), code("pro_required", 403));
  await handleTurn(deps, ANA, body([], { sessionId: ids[0] }));
  await handleTurn(deps, ANA, body([], { sessionId: ids[1] }));
  await assert.rejects(handleTurn(deps, ANA, body([], { sessionId: ids[2] })), code("daily_limit", 403));
  assert.equal(await store.getCall(ids[2]!), null, "a refused call is not created");
  await handleTurn(deps, BETO, body([], { sessionId: ids[2] })); // other users are unaffected

  await store.updateSettings({ freeDailyLimit: 3, proInstructionsEs: "x" });
  await handleTurn(deps, ANA, body([], { sessionId: ids[3] }));
});

test("limits: the daily count resets at local midnight", async () => {
  const tomorrow = new Date(Date.now() + 36 * 3600_000);
  const { deps, store } = await setup([turnJson("Hi.")]);
  for (const id of ids.slice(0, 2)) await ongoing(store, id);
  deps.now = () => tomorrow;
  await handleTurn(deps, ANA, body([]));
});

test("limits: Pro has no limits until it expires", async () => {
  const { deps, store } = await setup(ids.map(() => turnJson("Hi.")));
  for (const id of ids.slice(0, 2)) await ongoing(store, id);
  await store.setPro(ANA.userId, true, new Date(Date.now() + 86400_000));
  await handleTurn(deps, ANA, body([], { scenarioId: "job-interview" }));

  await store.setPro(ANA.userId, true, new Date(Date.now() - 1000)); // expired
  await assert.rejects(handleTurn(deps, ANA, body([], { sessionId: ids[4] })), code("daily_limit", 403));
});

test("turn: stops at the turn budget, but feedback stays possible", async () => {
  const { deps, store } = await setup([goodFeedback]);
  await ongoing(store, CALL, ANA, "billing-dispute", 6_500); // cap 10000 - reserve 4000 = 6000
  await assert.rejects(handleTurn(deps, ANA, body(exchanges(1))), code("session_token_cap", 429));
  const fb = await handleFeedback(deps, ANA, body(exchanges(2)));
  assert.equal(fb.scores.fluency, 6);
});

test("feedback: saved to the call, and asking again returns the saved copy", async () => {
  const { deps, store, llm } = await setup([goodFeedback]);
  await ongoing(store);
  const out = await handleFeedback(deps, ANA, body(exchanges(3)));
  assert.equal(out.callId, CALL);
  assert.equal(out.corrections.length, 3);
  assert.equal(out.phrases.length, 3);
  assert.match(llm.calls[0]!.messages[0]!.content, /AGENT: Agent answer number 1/);

  const saved = (await store.getCallDetail(ANA.userId, CALL))!;
  assert.equal(saved.feedback.overallSummaryEs, "Buen trabajo.");
  assert.equal((await store.getCall(CALL))!.tokens, 150);

  const again = await handleFeedback(deps, ANA, body(exchanges(3)));
  assert.deepEqual(again.scores, out.scores);
  assert.equal(llm.calls.length, 1, "no second model call");
});

test("feedback: Spanish problems are proofread before saving", async () => {
  const fb = JSON.parse(goodFeedback);
  fb.overallSummaryEs = "Buen trabajo. Despues practique mas.";
  const fixed = [
    ...fb.corrections.map((c: { explanationEs: string }) => c.explanationEs),
    ...fb.phrases.flatMap((p: { meaningEs: string; whenToUseEs: string }) => [p.meaningEs, p.whenToUseEs]),
    "Buen trabajo. Después practique más.",
  ];
  const { deps, store } = await setup([JSON.stringify(fb), JSON.stringify({ texts: fixed })]);
  await ongoing(store);
  const out = await handleFeedback(deps, ANA, body(exchanges(3)));
  assert.equal(out.overallSummaryEs, "Buen trabajo. Después practique más.");
  assert.equal((await store.getCallDetail(ANA.userId, CALL))!.feedback.overallSummaryEs, out.overallSummaryEs);
});

test("feedback: refused for thin calls, other users, and spent budgets", async () => {
  const { deps, store, llm } = await setup([goodFeedback]);
  await ongoing(store);
  const thin: Message[] = [
    { role: "customer", text: "Hello, how can I help?" },
    { role: "agent", text: "Hi" },
  ];
  await assert.rejects(handleFeedback(deps, ANA, body(thin)), code("not_enough_speech", 422));
  await assert.rejects(handleFeedback(deps, BETO, body(exchanges(2))), code("not_found", 404));
  await store.recordUsage(CALL, 10_000, false);
  await assert.rejects(handleFeedback(deps, ANA, body(exchanges(2))), code("session_token_cap", 429));
  assert.equal(llm.calls.length, 0);
});

test("feedback: retries on invalid output, 502 after two failures", async () => {
  let s = await setup(['{"scores":{}}', goodFeedback]);
  await ongoing(s.store);
  const out = await handleFeedback(s.deps, ANA, body(exchanges(2)));
  assert.equal(out.scores.callFlow, 6);
  assert.equal(s.llm.calls.length, 2);

  s = await setup(["bad", "bad"]);
  await ongoing(s.store);
  await assert.rejects(handleFeedback(s.deps, ANA, body(exchanges(2))), code("llm_bad_output", 502));
  assert.equal((await s.store.getCall(CALL))!.tokens, 300, "tokens are recorded even when it fails");
});
