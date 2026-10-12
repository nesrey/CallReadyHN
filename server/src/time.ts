import type { UsageRow } from "./db/store.js";

/** Calendar date "YYYY-MM-DD" of `d` in time zone `tz`. */
export function dayKey(d: Date, tz: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Offset of `tz` from UTC at instant `d`, in minutes (e.g. -360 for Honduras). */
function offsetMinutes(d: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** The instant local midnight began, in `tz`, for the day containing `now`. */
export function startOfDay(now: Date, tz: string): Date {
  const [y, m, day] = dayKey(now, tz).split("-").map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(y, m - 1, day));
  // Use the offset in effect at (approximately) that midnight, so DST days are handled.
  const offset = offsetMinutes(new Date(guess.getTime() - offsetMinutes(guess, tz) * 60000), tz);
  return new Date(guess.getTime() - offset * 60000);
}

/** The start of the day `days - 1` days before today, so the range covers `days` calendar days. */
export function startOfRange(now: Date, tz: string, days: number): Date {
  let d = startOfDay(now, tz);
  for (let i = 1; i < days; i++) d = startOfDay(new Date(d.getTime() - 12 * 3600_000), tz);
  return d;
}

export interface UsageDay {
  day: string;
  calls: number;
  users: number;
  tokens: number;
  /** Average QA score (0-100) of the calls that got feedback; null when none did. */
  avgQa: number | null;
}

/** Group started calls by local day, newest day first, including days with no calls. */
export function aggregateUsage(rows: UsageRow[], now: Date, tz: string, days: number): UsageDay[] {
  const byDay = new Map<string, { calls: number; users: Set<string>; tokens: number; scores: number[] }>();
  let d = startOfDay(now, tz);
  for (let i = 0; i < days; i++) {
    byDay.set(dayKey(d, tz), { calls: 0, users: new Set(), tokens: 0, scores: [] });
    d = startOfDay(new Date(d.getTime() - 12 * 3600_000), tz);
  }
  for (const r of rows) {
    const b = byDay.get(dayKey(r.startedAt, tz));
    if (!b) continue;
    b.calls++;
    b.users.add(r.userId);
    b.tokens += r.tokens;
    if (r.qa !== null) b.scores.push(r.qa);
  }
  return [...byDay.entries()].map(([day, b]) => ({
    day,
    calls: b.calls,
    users: b.users.size,
    tokens: b.tokens,
    avgQa: b.scores.length ? Math.round(b.scores.reduce((a, x) => a + x, 0) / b.scores.length) : null,
  }));
}
