import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callWithRetry, extractJson, parseFeedbackOutput, parseTurnOutput,
} from "../llm/parse.js";
import { ApiError } from "../errors.js";
import { CUSTOMER_RUBRIC, INTERVIEW_RUBRIC, qaScore } from "../llm/rubric.js";
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

test("parseFeedbackOutput returns the criteria in rubric order", () => {
  const out = parseFeedbackOutput(goodFeedback, CUSTOMER_RUBRIC);
  assert.deepEqual(out.criteria.map((c) => c.key), CUSTOMER_RUBRIC.map((c) => c.key));
  assert.equal(out.criteria[0]!.score, 6);
  assert.equal(out.strengths.length, 2);
  assert.equal(out.moments.length, 3);
  assert.equal(out.phrases[0]!.whenToUse, "When closing.");
  assert.equal(out.summary, "Solid call.");
});

test("parseFeedbackOutput rounds scores and checks the 0-10 range", () => {
  const f = fb(); f.criteria.opening.score = 6.6;
  assert.equal(parseFeedbackOutput(JSON.stringify(f), CUSTOMER_RUBRIC).criteria[0]!.score, 7);
  const z = fb(); z.criteria.opening.score = 0;
  assert.equal(parseFeedbackOutput(JSON.stringify(z), CUSTOMER_RUBRIC).criteria[0]!.score, 0, "0 = not done is valid");
  const a = fb(); a.criteria.empathy.score = 11;
  assert.throws(() => parseFeedbackOutput(JSON.stringify(a), CUSTOMER_RUBRIC), /between 0 and 10/);
  const b = fb(); b.criteria.empathy.score = "7";
  assert.throws(() => parseFeedbackOutput(JSON.stringify(b), CUSTOMER_RUBRIC), /must be a number/);
});

test("parseFeedbackOutput needs every rubric item with evidence and a tip", () => {
  const a = fb(); delete a.criteria.closing;
  assert.throws(() => parseFeedbackOutput(JSON.stringify(a), CUSTOMER_RUBRIC), /closing is missing/);
  const b = fb(); b.criteria.resolution.evidence = "";
  assert.throws(() => parseFeedbackOutput(JSON.stringify(b), CUSTOMER_RUBRIC), /resolution\.evidence/);
  // The interview rubric has different items, so a customer scorecard does not pass it.
  assert.throws(() => parseFeedbackOutput(goodFeedback, INTERVIEW_RUBRIC), /introduction is missing/);
});

test("parseFeedbackOutput needs at least one strength, moment and phrase, and keeps at most 3", () => {
  const a = fb(); a.moments = [];
  assert.throws(() => parseFeedbackOutput(JSON.stringify(a), CUSTOMER_RUBRIC), /moments/);
  const b = fb(); b.phrases.push(...b.phrases);
  assert.equal(parseFeedbackOutput(JSON.stringify(b), CUSTOMER_RUBRIC).phrases.length, 3);
  const c = fb(); c.moments[1].why = " ";
  assert.throws(() => parseFeedbackOutput(JSON.stringify(c), CUSTOMER_RUBRIC), /moments\[1\]\.why/);
  const d = fb(); delete d.summary;
  assert.equal(parseFeedbackOutput(JSON.stringify(d), CUSTOMER_RUBRIC).summary, "");
});

test("qaScore weights the 0-10 scores into 0-100", () => {
  const all = (n: number) => Object.fromEntries(CUSTOMER_RUBRIC.map((c) => [c.key, n]));
  assert.equal(qaScore(all(10), CUSTOMER_RUBRIC), 100);
  assert.equal(qaScore(all(6), CUSTOMER_RUBRIC), 60);
  assert.equal(qaScore({ ...all(10), resolution: 0 }, CUSTOMER_RUBRIC), 80, "resolution weighs 20");
  for (const r of [CUSTOMER_RUBRIC, INTERVIEW_RUBRIC]) assert.equal(r.reduce((a, c) => a + c.weight, 0), 100);
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
