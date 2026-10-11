import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The web app keeps its pure logic between LOGIC:START / LOGIC:END markers so it can be tested here.
const html = readFileSync(new URL("../../../web/index.html", import.meta.url), "utf8");
const block = html.split("/* LOGIC:START")[1]?.split("/* LOGIC:END */")[0];
assert.ok(block, "LOGIC markers not found in web/index.html");

const L = new Function(
  `${block.slice(block.indexOf("*/") + 2)}
   return { computeStreak, canStartCall, avgScores, sortScenarios, formatTime, trendPoints, dateKey, freeUsedText };`,
)() as Record<string, any>;

const d = (s: string) => new Date(s); // local-time dates, e.g. "2026-10-11T12:00:00"

test("dateKey uses local calendar date", () => {
  assert.equal(L.dateKey(d("2026-01-05T23:59:00")), "2026-01-05");
  assert.equal(L.dateKey(d("2026-01-06T00:01:00")), "2026-01-06");
});

test("streak: empty history", () => {
  assert.deepEqual(L.computeStreak([], d("2026-10-11T10:00:00")), { current: 0, best: 0 });
});

test("streak: consecutive days ending today", () => {
  const keys = ["2026-10-09", "2026-10-10", "2026-10-11"];
  assert.deepEqual(L.computeStreak(keys, d("2026-10-11T09:00:00")), { current: 3, best: 3 });
});

test("streak: still alive if last practice was yesterday", () => {
  const keys = ["2026-10-09", "2026-10-10"];
  assert.deepEqual(L.computeStreak(keys, d("2026-10-11T09:00:00")), { current: 2, best: 2 });
});

test("streak: broken after a missed day, best is kept", () => {
  const keys = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-09"];
  assert.deepEqual(L.computeStreak(keys, d("2026-10-11T09:00:00")), { current: 0, best: 4 });
});

test("streak: several calls on one day count once", () => {
  const keys = ["2026-10-10", "2026-10-10", "2026-10-10", "2026-10-11"];
  assert.deepEqual(L.computeStreak(keys, d("2026-10-11T09:00:00")), { current: 2, best: 2 });
});

test("streak: works across month and year boundaries", () => {
  const keys = ["2026-12-30", "2026-12-31", "2027-01-01"];
  assert.deepEqual(L.computeStreak(keys, d("2027-01-01T20:00:00")), { current: 3, best: 3 });
});

test("streak: gap in the middle keeps current from the latest run", () => {
  const keys = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-10", "2026-10-11"];
  assert.deepEqual(L.computeStreak(keys, d("2026-10-11T09:00:00")), { current: 2, best: 3 });
});

test("free users: the daily limit from the server, free-tier scenarios only", () => {
  const free = { tier: "free" };
  assert.deepEqual(L.canStartCall({ isPro: false, scenario: free, startsToday: 0, limit: 2 }), { ok: true, reason: null });
  assert.deepEqual(L.canStartCall({ isPro: false, scenario: free, startsToday: 1, limit: 2 }), { ok: true, reason: null });
  assert.deepEqual(L.canStartCall({ isPro: false, scenario: free, startsToday: 2, limit: 2 }), { ok: false, reason: "daily_limit" });
  assert.deepEqual(L.canStartCall({ isPro: false, scenario: free, startsToday: 2, limit: 5 }), { ok: true, reason: null });
  assert.deepEqual(L.canStartCall({ isPro: false, scenario: free, startsToday: 0, limit: 0 }), { ok: false, reason: "daily_limit" });
});

test("free users cannot start pro scenarios; pro users have no limits", () => {
  const pro = { tier: "pro" };
  assert.deepEqual(L.canStartCall({ isPro: false, scenario: pro, startsToday: 0, limit: 2 }), { ok: false, reason: "pro_required" });
  assert.equal(L.canStartCall({ isPro: true, scenario: pro, startsToday: 50, limit: 2 }).ok, true);
});

test("freeUsedText uses the right number and plural", () => {
  assert.equal(L.freeUsedText(2), "Ya usó sus 2 llamadas gratis de hoy.");
  assert.equal(L.freeUsedText(1), "Ya usó su llamada gratis de hoy.");
  assert.equal(L.freeUsedText(0), "Hoy no hay llamadas gratis disponibles.");
});

test("avgScores averages the five scores to one decimal", () => {
  assert.equal(L.avgScores({ fluency: 6, grammar: 5, vocabulary: 6, empathyPoliteness: 7, callFlow: 6 }), 6);
  assert.equal(L.avgScores({ fluency: 7, grammar: 6, vocabulary: 6, empathyPoliteness: 8, callFlow: 7 }), 6.8);
  assert.equal(L.avgScores({}), 0);
});

test("trendPoints returns chronological averages, last N only", () => {
  const calls = [
    { startedAt: "2026-10-03T10:00:00Z", avg: 7 },
    { startedAt: "2026-10-01T10:00:00Z", avg: 5 },
    { startedAt: "2026-10-02T10:00:00Z", avg: 6 },
  ];
  assert.deepEqual(L.trendPoints(calls, 20), [5, 6, 7]);
  assert.deepEqual(L.trendPoints(calls, 2), [6, 7]);
});

test("sortScenarios puts the learner's level first, interviews first for job seekers", () => {
  const list = [
    { id: "a2", difficulty: "A2", category: "support" },
    { id: "b1", difficulty: "B1", category: "support" },
    { id: "b2", difficulty: "B2", category: "support" },
    { id: "iv", difficulty: "B2", category: "interview" },
  ];
  const ids = (p: unknown) => L.sortScenarios(list, p).map((s: { id: string }) => s.id);
  assert.deepEqual(ids({ level: "B1", goal: "improve" }), ["b1", "a2", "b2", "iv"]);
  assert.deepEqual(ids({ level: "B2", goal: "job" }), ["iv", "b2", "b1", "a2"]);
  assert.deepEqual(ids(null), ["a2", "b1", "b2", "iv"]);
});

test("formatTime pads minutes and seconds", () => {
  assert.equal(L.formatTime(0), "00:00");
  assert.equal(L.formatTime(65), "01:05");
  assert.equal(L.formatTime(-5), "00:00");
});
