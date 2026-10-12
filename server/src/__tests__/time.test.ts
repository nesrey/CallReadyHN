import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage, dayKey, startOfDay, startOfRange } from "../time.js";

const HN = "America/Tegucigalpa"; // UTC-6, no daylight saving

test("dayKey uses the configured time zone", () => {
  assert.equal(dayKey(new Date("2026-10-11T03:00:00Z"), HN), "2026-10-10"); // 9 p.m. the day before in Honduras
  assert.equal(dayKey(new Date("2026-10-11T07:00:00Z"), HN), "2026-10-11");
});

test("startOfDay is local midnight", () => {
  assert.equal(startOfDay(new Date("2026-10-11T03:00:00Z"), HN).toISOString(), "2026-10-10T06:00:00.000Z");
  assert.equal(startOfDay(new Date("2026-10-11T23:59:00Z"), HN).toISOString(), "2026-10-11T06:00:00.000Z");
});

test("startOfDay handles daylight saving days", () => {
  // New York switched to EDT (UTC-4) at 2 a.m. on 2026-03-08; midnight that day was still EST (UTC-5).
  assert.equal(startOfDay(new Date("2026-03-08T20:00:00Z"), "America/New_York").toISOString(), "2026-03-08T05:00:00.000Z");
  assert.equal(startOfDay(new Date("2026-03-09T20:00:00Z"), "America/New_York").toISOString(), "2026-03-09T04:00:00.000Z");
});

test("startOfRange covers N calendar days including today", () => {
  assert.equal(startOfRange(new Date("2026-10-11T12:00:00Z"), HN, 1).toISOString(), "2026-10-11T06:00:00.000Z");
  assert.equal(startOfRange(new Date("2026-10-11T12:00:00Z"), HN, 30).toISOString(), "2026-09-12T06:00:00.000Z");
});

test("aggregateUsage groups by local day, newest first, with empty days", () => {
  const now = new Date("2026-10-11T18:00:00Z");
  const rows = [
    { startedAt: new Date("2026-10-11T15:00:00Z"), userId: "a", tokens: 1000, qa: 60 },
    { startedAt: new Date("2026-10-11T16:00:00Z"), userId: "a", tokens: 500, qa: 70 },
    { startedAt: new Date("2026-10-11T17:00:00Z"), userId: "b", tokens: 200, qa: null },
    { startedAt: new Date("2026-10-10T03:00:00Z"), userId: "b", tokens: 300, qa: 80 }, // Oct 9, 9 p.m. local
    { startedAt: new Date("2026-09-01T12:00:00Z"), userId: "c", tokens: 999, qa: 50 }, // outside the range
  ];
  const days = aggregateUsage(rows, now, HN, 3);
  assert.deepEqual(days, [
    { day: "2026-10-11", calls: 3, users: 2, tokens: 1700, avgQa: 65 },
    { day: "2026-10-10", calls: 0, users: 0, tokens: 0, avgQa: null },
    { day: "2026-10-09", calls: 1, users: 1, tokens: 300, avgQa: 80 },
  ]);
});
