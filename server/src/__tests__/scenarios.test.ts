import { test } from "node:test";
import assert from "node:assert/strict";
import { CALL_TYPES, loadScenarios, loadScenariosFromDisk, toSummary, validateScenario } from "../scenarios/load.js";

const seeds = loadScenariosFromDisk();
const base = () => structuredClone(seeds[0]) as unknown as Record<string, unknown>;

test("seed: 3 scenarios per call type (calm, demanding, furious) plus the interview", () => {
  assert.equal(seeds.length, 13);
  assert.equal(new Set(seeds.map((s) => s.id)).size, 13);
  for (const type of CALL_TYPES.filter((t) => t !== "interview")) {
    const of = seeds.filter((s) => s.callType === type).map((s) => s.temperament).sort();
    assert.deepEqual(of, ["calm", "demanding", "furious"], type);
  }
  assert.equal(seeds.filter((s) => s.callType === "interview").length, 1);
});

test("seed: free tier is the calm call of each type; everything else is Pro", () => {
  for (const s of seeds) {
    assert.equal(s.tier, s.temperament === "calm" && s.callType !== "interview" ? "free" : "pro", s.id);
  }
});

test("seed: every call has a desk panel, policies and a verification rule", () => {
  for (const s of seeds) {
    assert.ok(s.account.length >= 2, s.id);
    assert.ok(s.policies.length >= 1, s.id);
    if (s.callType !== "interview") assert.ok(s.policies.some((p) => /verif/i.test(p)), `${s.id} has no verification policy`);
  }
});

test("seed: collections calls require the debt-collection disclosure", () => {
  for (const s of seeds.filter((x) => x.callType === "collections")) {
    assert.ok(s.policies.some((p) => /attempt to collect a debt|disclosure/i.test(p)), s.id);
  }
});

test("tier defaults from temperament when omitted", () => {
  const raw = base();
  delete raw.tier;
  raw.temperament = "furious";
  assert.equal(validateScenario(raw).tier, "pro");
  raw.temperament = "calm";
  assert.equal(validateScenario(raw).tier, "free");
});

test("rejects duplicate ids, bad enums, unknown fields and missing data", () => {
  assert.throws(() => loadScenarios([base(), base()]), /duplicate scenario id/);
  assert.throws(() => validateScenario({ ...base(), callType: "retail" }), /callType/);
  assert.throws(() => validateScenario({ ...base(), temperament: "angry" }), /temperament/);
  assert.throws(() => validateScenario({ ...base(), surprise: true }), /unknown field "surprise"/);
  const raw = base();
  delete raw.goal;
  assert.throws(() => validateScenario(raw), /"goal" must be a non-empty string/);
  assert.throws(() => validateScenario({ ...base(), id: "Bad Id" }), /id must be/);
  assert.throws(() => loadScenarios([]), /non-empty array/);
});

test("desk panel fields need a label and a value; policies are required", () => {
  assert.throws(() => validateScenario({ ...base(), account: [{ label: "Plan" }, { label: "x", value: "y" }] }), /"value"/);
  assert.throws(() => validateScenario({ ...base(), account: [{ label: "a", value: "b" }] }), /at least 2 fields/);
  assert.throws(() => validateScenario({ ...base(), policies: [] }), /"policies"/);
});

test("summary shows the desk panel but never the caller-only facts", () => {
  const s = seeds.find((x) => x.id === "tech-wifi-down")!;
  const sum = toSummary(s);
  assert.equal(sum.personaName, "Mr. Tom Bennett");
  assert.equal(sum.aiRole, "customer");
  assert.deepEqual(sum.policies, s.policies);
  assert.ok(sum.account.some((f) => f.label === "Area outage"));
  const json = JSON.stringify(sum);
  assert.ok(!json.includes("loose"), "the hidden fact about the loose cable must not leak");
  assert.ok(!("hiddenFacts" in sum) && !("behaviorNotes" in sum) && !("goal" in sum));
  assert.equal(toSummary(seeds.find((x) => x.callType === "interview")!).aiRole, "interviewer");
});
