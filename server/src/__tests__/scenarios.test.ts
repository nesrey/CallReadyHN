import { test } from "node:test";
import assert from "node:assert/strict";
import { loadScenarios, loadScenariosFromDisk, validateScenario, toSummary } from "../scenarios/load.js";

const seeds = loadScenariosFromDisk();
const base = () => structuredClone(seeds[0]) as unknown as Record<string, unknown>;

test("loads the 6 seed scenarios with unique ids", () => {
  assert.equal(seeds.length, 6);
  assert.deepEqual(
    seeds.map((s) => s.id).sort(),
    ["angry-refund", "billing-dispute", "internet-support", "job-interview", "order-status", "phone-plan-upsell"],
  );
});

test("free tier is A2/B1 non-interview; pro tier is B2 or interview", () => {
  for (const s of seeds) {
    const pro = s.difficulty === "B2" || s.category === "interview";
    assert.equal(s.tier, pro ? "pro" : "free", s.id);
  }
});

test("every scenario has a flow of at least 3 stages and a persona", () => {
  for (const s of seeds) {
    assert.ok(s.expectedFlow.length >= 3, s.id);
    assert.ok(s.persona.name.length > 0, s.id);
  }
});

test("interview scenario uses the interviewer role", () => {
  const s = seeds.find((x) => x.id === "job-interview")!;
  assert.equal(s.aiRole, "interviewer");
});

test("tier and aiRole default sensibly when omitted", () => {
  const raw = base();
  delete raw.tier;
  delete raw.aiRole;
  raw.difficulty = "B2";
  const s = validateScenario(raw);
  assert.equal(s.tier, "pro");
  assert.equal(s.aiRole, "customer");
});

test("rejects duplicate ids", () => {
  assert.throws(() => loadScenarios([base(), base()]), /duplicate scenario id/);
});

test("rejects bad difficulty", () => {
  const raw = base();
  raw.difficulty = "C1";
  assert.throws(() => validateScenario(raw), /difficulty/);
});

test("rejects unknown fields", () => {
  const raw = base();
  raw.surprise = true;
  assert.throws(() => validateScenario(raw), /unknown field "surprise"/);
});

test("reports missing fields clearly", () => {
  const raw = base();
  delete raw.goal;
  assert.throws(() => validateScenario(raw), /"goal" must be a non-empty string/);
});

test("rejects bad id format and empty list", () => {
  const raw = base();
  raw.id = "Bad Id";
  assert.throws(() => validateScenario(raw), /id must be/);
  assert.throws(() => loadScenarios([]), /non-empty array/);
});

test("summary hides persona details and hidden facts", () => {
  const sum = toSummary(seeds[0]!);
  assert.equal(sum.personaName, "Mr. David Reyes");
  assert.ok(!("hiddenFacts" in sum));
  assert.ok(!("persona" in sum));
});
