import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callWithRetry, extractJson, parseFeedbackOutput, parseTurnOutput,
} from "../llm/parse.js";
import { ApiError } from "../errors.js";
import { MockLlm, goodFeedback } from "./helpers.js";

const fb = () => JSON.parse(goodFeedback) as Record<string, any>;

test("extractJson handles plain, fenced, and prose-wrapped JSON", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: {"a":1} Hope that helps.'), { a: 1 });
});

test("extractJson throws on garbage", () => {
  assert.throws(() => extractJson("no json here"), /No JSON object/);
  assert.throws(() => extractJson("{not valid}"), /Invalid JSON/);
});

test("parseTurnOutput accepts valid output and defaults end to false", () => {
  assert.deepEqual(parseTurnOutput('{"line":"Hello there.","end":true}'), { line: "Hello there.", end: true });
  assert.deepEqual(parseTurnOutput('{"line":"Hi"}'), { line: "Hi", end: false });
});

test("parseTurnOutput rejects empty line and wrong types", () => {
  assert.throws(() => parseTurnOutput('{"line":"  ","end":false}'), /non-empty/);
  assert.throws(() => parseTurnOutput('{"line":5}'), /non-empty/);
  assert.throws(() => parseTurnOutput('{"line":"x","end":"yes"}'), /true or false/);
});

test("parseFeedbackOutput accepts a valid payload", () => {
  const out = parseFeedbackOutput(goodFeedback);
  assert.equal(out.scores.grammar, 5);
  assert.equal(out.corrections.length, 3);
  assert.equal(out.phrases.length, 3);
  assert.equal(out.overallSummaryEs, "Buen trabajo.");
});

test("parseFeedbackOutput rounds fractional scores", () => {
  const f = fb();
  f.scores.fluency = 6.6;
  assert.equal(parseFeedbackOutput(JSON.stringify(f)).scores.fluency, 7);
});

test("parseFeedbackOutput rejects out-of-range and non-numeric scores", () => {
  const a = fb(); a.scores.grammar = 11;
  assert.throws(() => parseFeedbackOutput(JSON.stringify(a)), /between 1 and 10/);
  const b = fb(); b.scores.grammar = 0;
  assert.throws(() => parseFeedbackOutput(JSON.stringify(b)), /between 1 and 10/);
  const c = fb(); c.scores.grammar = "7";
  assert.throws(() => parseFeedbackOutput(JSON.stringify(c)), /must be a number/);
});

test("parseFeedbackOutput rejects missing score and wrong counts", () => {
  const a = fb(); delete a.scores.callFlow;
  assert.throws(() => parseFeedbackOutput(JSON.stringify(a)), /callFlow/);
  const b = fb(); b.corrections.pop();
  assert.throws(() => parseFeedbackOutput(JSON.stringify(b)), /exactly 3/);
  const c = fb(); c.phrases.push(c.phrases[0]);
  assert.throws(() => parseFeedbackOutput(JSON.stringify(c)), /exactly 3/);
});

test("parseFeedbackOutput rejects empty correction fields", () => {
  const f = fb(); f.corrections[1].explanationEs = "";
  assert.throws(() => parseFeedbackOutput(JSON.stringify(f)), /explanationEs/);
});

test("parseFeedbackOutput tolerates a missing summary", () => {
  const f = fb(); delete f.overallSummaryEs;
  assert.equal(parseFeedbackOutput(JSON.stringify(f)).overallSummaryEs, "");
});

const retryOpts = (llm: MockLlm, used: number[] = []) => ({
  llm,
  system: "sys",
  messages: [{ role: "user" as const, content: "hi" }],
  maxTokens: 100,
  parse: parseTurnOutput,
  onUsage: (n: number) => used.push(n),
});

test("callWithRetry returns first valid output without retrying", async () => {
  const llm = new MockLlm(['{"line":"Hello","end":false}']);
  const used: number[] = [];
  const out = await callWithRetry(retryOpts(llm, used));
  assert.equal(out.line, "Hello");
  assert.equal(llm.calls.length, 1);
  assert.deepEqual(used, [150]);
});

test("callWithRetry retries once with the error fed back, counting both calls", async () => {
  const llm = new MockLlm(["oops not json", '{"line":"Second try","end":false}']);
  const used: number[] = [];
  const out = await callWithRetry(retryOpts(llm, used));
  assert.equal(out.line, "Second try");
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(used, [150, 150]);
  const nudge = llm.calls[1]!.messages;
  assert.equal(nudge[nudge.length - 1]!.role, "user");
  assert.match(nudge[nudge.length - 1]!.content, /invalid/);
  assert.equal(nudge[nudge.length - 2]!.content, "oops not json");
});

test("callWithRetry gives 502 llm_bad_output after two failures", async () => {
  const llm = new MockLlm(["bad", "still bad"]);
  await assert.rejects(callWithRetry(retryOpts(llm)), (e: unknown) => {
    if (!(e instanceof ApiError)) throw e;
    assert.equal(e.status, 502);
    assert.equal(e.code, "llm_bad_output");
    return true;
  });
  assert.equal(llm.calls.length, 2);
});

test("callWithRetry does not retry upstream failures", async () => {
  const llm = new MockLlm([new ApiError(502, "llm_unavailable", "down")]);
  await assert.rejects(callWithRetry(retryOpts(llm)), /down/);
  assert.equal(llm.calls.length, 1);
});
