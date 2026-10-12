import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The web app keeps its pure logic between LOGIC:START / LOGIC:END markers so it can be tested here.
const html = readFileSync(new URL("../../../app/index.html", import.meta.url), "utf8");
const block = html.split("/* LOGIC:START")[1]?.split("/* LOGIC:END */")[0];
assert.ok(block, "LOGIC markers not found in app/index.html");

const L = new Function(
  `${block.slice(block.indexOf("*/") + 2)}
   return { computeStreak, canStartCall, sortScenarios, formatTime, trendPoints, dateKey, freeUsedText, verdict, markQuotes, timeAgo };`,
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
  assert.equal(L.freeUsedText(2), "You have used your 2 free calls for today.");
  assert.equal(L.freeUsedText(1), "You have used your free call for today.");
  assert.equal(L.freeUsedText(0), "There are no free calls available today.");
});

test("verdict names the QA band", () => {
  assert.equal(L.verdict(92), "Ready for live calls");
  assert.equal(L.verdict(85), "Ready for live calls");
  assert.equal(L.verdict(70), "Solid call");
  assert.equal(L.verdict(55), "Needs coaching");
  assert.equal(L.verdict(20), "Keep practicing");
});

test("trendPoints returns chronological QA scores, last N only", () => {
  const calls = [
    { startedAt: "2026-10-03T10:00:00Z", qaScore: 70 },
    { startedAt: "2026-10-01T10:00:00Z", qaScore: 50 },
    { startedAt: "2026-10-02T10:00:00Z", qaScore: 60 },
  ];
  assert.deepEqual(L.trendPoints(calls, 20), [50, 60, 70]);
  assert.deepEqual(L.trendPoints(calls, 2), [60, 70]);
});

test("sortScenarios: the learner's call types first, calm to furious; interviews by role", () => {
  const list = [
    { id: "s-fur", callType: "service", temperament: "furious" },
    { id: "iv", callType: "interview", temperament: "demanding" },
    { id: "t-calm", callType: "tech", temperament: "calm" },
    { id: "s-calm", callType: "service", temperament: "calm" },
    { id: "c-dem", callType: "collections", temperament: "demanding" },
  ];
  const ids = (p: unknown) => L.sortScenarios(list, p).map((s: { id: string }) => s.id);
  assert.deepEqual(ids({ role: "agent", interests: ["collections"] }), ["c-dem", "t-calm", "s-calm", "s-fur", "iv"]);
  assert.deepEqual(ids({ role: "job_seeker", interests: [] }), ["iv", "t-calm", "s-calm", "c-dem", "s-fur"]);
  assert.deepEqual(ids(null), ["t-calm", "s-calm", "c-dem", "s-fur", "iv"]);
});

test("markQuotes highlights coaching quotes inside a line, case-insensitive", () => {
  const parts = L.markQuotes("Okay no problem, I can do that for you.", ['"No problem,"', "do that"]);
  assert.deepEqual(parts, [
    { text: "Okay ", hit: false },
    { text: "no problem", hit: true },
    { text: ", I can ", hit: false },
    { text: "do that", hit: true },
    { text: " for you.", hit: false },
  ]);
  assert.deepEqual(L.markQuotes("Hello there", ["missing", "ok"]), [{ text: "Hello there", hit: false }]);
});

test("formatTime pads minutes and seconds", () => {
  assert.equal(L.formatTime(0), "00:00");
  assert.equal(L.formatTime(65), "01:05");
  assert.equal(L.formatTime(-5), "00:00");
});

test("timeAgo says how long ago, then falls back to a date", () => {
  const now = new Date("2026-10-11T18:00:00Z");
  assert.equal(L.timeAgo("2026-10-11T17:59:30Z", now), "just now");
  assert.equal(L.timeAgo("2026-10-11T17:55:00Z", now), "5 min ago");
  assert.equal(L.timeAgo("2026-10-11T15:00:00Z", now), "3 h ago");
  assert.equal(L.timeAgo("2026-10-10T17:00:00Z", now), "1 day ago");
  assert.equal(L.timeAgo("2026-10-08T18:00:00Z", now), "3 days ago");
  assert.match(L.timeAgo("2026-09-20T18:00:00Z", now), /Sep 20/);
});
