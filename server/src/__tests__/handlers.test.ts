import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { handleFeedback, handleTurn, type Deps } from "../handlers.js";
import { TokenBudget } from "../limits.js";
import { loadScenariosFromDisk } from "../scenarios/load.js";
import { MockLlm, exchanges, goodFeedback } from "./helpers.js";
import type { Message } from "../types.js";

const config = loadConfig({ ANTHROPIC_API_KEY: "test" });
const scenarios = new Map(loadScenariosFromDisk().map((s) => [s.id, s]));

function deps(llm: MockLlm, cap = config.sessionTokenCap): Deps {
  return { config, scenarios, llm, budget: new TokenBudget(cap, config.feedbackReserve) };
}
const body = (history: Message[], extra: Record<string, unknown> = {}) => ({
  sessionId: "session-0001",
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

test("turn: empty history makes the customer open the call", async () => {
  const llm = new MockLlm([turnJson("Hello, I need help with my bill.")]);
  const out = await handleTurn(deps(llm), body([]));
  assert.equal(out.line, "Hello, I need help with my bill.");
  assert.equal(out.callEnded, false);
  assert.equal(out.turnNumber, 1);
  assert.equal(out.usage.sessionTokensUsed, 150);
  assert.match(llm.calls[0]!.system, /turn #1 of at most 10/);
});

test("turn: the model cannot end the call before the minimum", async () => {
  const llm = new MockLlm([turnJson("Okay, goodbye!", true)]);
  const out = await handleTurn(deps(llm), body(exchanges(2))); // turn 3
  assert.equal(out.callEnded, false);
});

test("turn: model may end the call between min and max", async () => {
  const llm = new MockLlm([turnJson("Thanks, bye!", true)]);
  const out = await handleTurn(deps(llm), body(exchanges(6))); // turn 7
  assert.equal(out.callEnded, true);
});

test("turn: the call is forced to end at the maximum", async () => {
  const llm = new MockLlm([turnJson("One more thing...", false)]);
  const out = await handleTurn(deps(llm), body(exchanges(9))); // turn 10
  assert.equal(out.turnNumber, 10);
  assert.equal(out.callEnded, true);
});

test("turn: refuses to continue a call already at max length", async () => {
  await assert.rejects(handleTurn(deps(new MockLlm([])), body(exchanges(10))), code("call_over", 400));
});

test("turn: unknown scenario and bad shapes", async () => {
  await assert.rejects(
    handleTurn(deps(new MockLlm([])), body([], { scenarioId: "nope" })),
    code("unknown_scenario", 404),
  );
  await assert.rejects(
    handleTurn(deps(new MockLlm([])), body(exchanges(1).slice(0, 1))), // ends with customer
    code("invalid_request", 400),
  );
  await assert.rejects(handleTurn(deps(new MockLlm([])), { nope: 1 }), code("invalid_request", 400));
});

test("turn: retries once on bad JSON and counts both calls' tokens", async () => {
  const llm = new MockLlm(["not json at all", turnJson("Sorry, could you repeat that?")]);
  const out = await handleTurn(deps(llm), body([]));
  assert.equal(out.line, "Sorry, could you repeat that?");
  assert.equal(llm.calls.length, 2);
  assert.equal(out.usage.sessionTokensUsed, 300);
});

test("turn: two bad outputs give llm_bad_output", async () => {
  await assert.rejects(handleTurn(deps(new MockLlm(["x", "y"])), body([])), code("llm_bad_output", 502));
});

test("turn: stops when the turn budget is used, but feedback stays possible", async () => {
  const d = deps(new MockLlm([]), 10_000);
  d.budget.add("session-0001", 6_500); // cap - reserve = 6000
  await assert.rejects(handleTurn(d, body(exchanges(1))), code("session_token_cap", 429));

  const d2 = deps(new MockLlm([goodFeedback]), 10_000);
  d2.budget.add("session-0001", 6_500);
  const fb = await handleFeedback(d2, body(exchanges(2)));
  assert.equal(fb.scores.fluency, 6);
});

test("feedback: returns scores, 3 corrections, 3 phrases", async () => {
  const llm = new MockLlm([goodFeedback]);
  const out = await handleFeedback(deps(llm), body(exchanges(3)));
  assert.equal(out.corrections.length, 3);
  assert.equal(out.phrases.length, 3);
  assert.equal(out.overallSummaryEs, "Buen trabajo.");
  const user = llm.calls[0]!.messages[0]!.content;
  assert.match(user, /^<transcript>/);
  assert.match(user, /AGENT: Agent answer number 1/);
});

test("feedback: 422 when the learner barely spoke", async () => {
  const llm = new MockLlm([goodFeedback]);
  const thin: Message[] = [
    { role: "customer", text: "Hello, how can I help?" },
    { role: "agent", text: "Hi" },
  ];
  await assert.rejects(handleFeedback(deps(llm), body(thin)), code("not_enough_speech", 422));
  assert.equal(llm.calls.length, 0);
});

test("feedback: retries on invalid output, 502 after two failures", async () => {
  const llm = new MockLlm(['{"scores":{}}', goodFeedback]);
  const out = await handleFeedback(deps(llm), body(exchanges(2)));
  assert.equal(out.scores.callFlow, 6);
  assert.equal(llm.calls.length, 2);
  await assert.rejects(
    handleFeedback(deps(new MockLlm(["bad", "bad"])), body(exchanges(2))),
    code("llm_bad_output", 502),
  );
});

test("feedback: session cap blocks even feedback once fully used", async () => {
  const d = deps(new MockLlm([goodFeedback]), 10_000);
  d.budget.add("session-0001", 10_000);
  await assert.rejects(handleFeedback(d, body(exchanges(2))), code("session_token_cap", 429));
});
