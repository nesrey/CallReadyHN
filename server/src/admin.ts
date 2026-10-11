import type { StoredScenario } from "./db/store.js";
import { ApiError } from "./errors.js";
import { nowOf, type Deps } from "./handlers.js";
import { ScenarioError, validateScenario } from "./scenarios/load.js";
import { aggregateUsage, startOfDay, startOfRange } from "./time.js";
import { isUuid } from "./validate.js";

const bad = (msg: string) => new ApiError(400, "invalid_request", msg);
const iso = (d: Date | null) => (d ? d.toISOString() : null);
const rec = (body: unknown): Record<string, unknown> =>
  typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

export async function adminListUsers(deps: Deps, query: Record<string, unknown>) {
  const q = typeof query.q === "string" ? query.q.slice(0, 100) : "";
  const offset = Math.max(0, Number.parseInt(String(query.offset ?? "0"), 10) || 0);
  const { users, total } = await deps.store.listUsers({ query: q, limit: 50, offset });
  const now = nowOf(deps);
  return {
    total,
    offset,
    users: users.map((u) => ({
      ...u,
      createdAt: u.createdAt.toISOString(),
      lastSeenAt: u.lastSeenAt.toISOString(),
      lastCallAt: iso(u.lastCallAt),
      proUntil: iso(u.proUntil),
      proActive: u.isPro && (u.proUntil === null || u.proUntil > now),
    })),
  };
}

/** body: { isPro: boolean, proUntil?: "YYYY-MM-DD" | null }. Pro lasts through the end of that local day. */
export async function adminSetPro(deps: Deps, userId: string, body: unknown) {
  if (!isUuid(userId)) throw new ApiError(404, "not_found", "User not found.");
  const b = rec(body);
  if (typeof b.isPro !== "boolean") throw bad("isPro must be true or false.");
  let until: Date | null = null;
  if (b.isPro && b.proUntil !== undefined && b.proUntil !== null && b.proUntil !== "") {
    const m = typeof b.proUntil === "string" ? b.proUntil.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
    if (!m) throw bad("proUntil must be a date like 2026-12-31.");
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const day = new Date(Date.UTC(y, mo - 1, d, 12));
    if (day.getUTCMonth() !== mo - 1) throw bad("proUntil is not a real date.");
    // Start of the next local day = end of the chosen day.
    until = startOfDay(new Date(day.getTime() + 24 * 3600_000), deps.config.timeZone);
    if (until <= nowOf(deps)) throw bad("proUntil must be in the future.");
  }
  if (!(await deps.store.setPro(userId, b.isPro, until))) throw new ApiError(404, "not_found", "User not found.");
  return { ok: true, isPro: b.isPro, proUntil: iso(until) };
}

export async function adminUsage(deps: Deps, query: Record<string, unknown>) {
  const days = Math.min(90, Math.max(1, Number.parseInt(String(query.days ?? "30"), 10) || 30));
  const now = nowOf(deps);
  const tz = deps.config.timeZone;
  const rows = await deps.store.usageSince(startOfRange(now, tz, days));
  const byDay = aggregateUsage(rows, now, tz, days);
  const scored = rows.filter((r) => r.avg !== null);
  return {
    days,
    timeZone: tz,
    totals: {
      calls: rows.length,
      users: new Set(rows.map((r) => r.userId)).size,
      tokens: rows.reduce((a, r) => a + r.tokens, 0),
      avgScore: scored.length
        ? Math.round((scored.reduce((a, r) => a + (r.avg as number), 0) / scored.length) * 10) / 10
        : null,
    },
    byDay,
  };
}

/** Scenarios in the same shape as data/scenarios.json, plus "enabled". */
function scenarioOut(s: StoredScenario) {
  const { sortOrder: _order, ...rest } = s;
  return rest;
}

export function adminListScenarios(deps: Deps) {
  return { scenarios: deps.catalog.list().map(scenarioOut) };
}

/** body: { scenario: {...same fields as scenarios.json...}, enabled: boolean }. Creates or replaces. */
export async function adminSaveScenario(deps: Deps, id: string, body: unknown) {
  const b = rec(body);
  if (typeof b.enabled !== "boolean") throw bad("enabled must be true or false.");
  let s;
  try {
    s = validateScenario(b.scenario, "scenario");
  } catch (e) {
    if (e instanceof ScenarioError) throw bad(e.message);
    throw e;
  }
  if (s.id !== id) throw bad("The scenario id cannot change.");
  await deps.store.saveScenario(s, b.enabled);
  await deps.catalog.refresh();
  return { scenario: scenarioOut(deps.catalog.list().find((x) => x.id === id)!) };
}

export async function adminSetScenarioEnabled(deps: Deps, id: string, body: unknown) {
  const b = rec(body);
  if (typeof b.enabled !== "boolean") throw bad("enabled must be true or false.");
  if (!(await deps.store.setScenarioEnabled(id, b.enabled))) throw new ApiError(404, "not_found", "Scenario not found.");
  await deps.catalog.refresh();
  return { ok: true };
}

export async function adminGetSettings(deps: Deps) {
  return deps.store.getSettings();
}

export async function adminSaveSettings(deps: Deps, body: unknown) {
  const b = rec(body);
  const limit = b.freeDailyLimit;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0 || limit > 100) {
    throw bad("freeDailyLimit must be a whole number from 0 to 100.");
  }
  const text = typeof b.proInstructionsEs === "string" ? b.proInstructionsEs.trim() : "";
  if (!text || text.length > 1000) throw bad("proInstructionsEs must be 1 to 1000 characters.");
  await deps.store.updateSettings({ freeDailyLimit: limit, proInstructionsEs: text });
  return deps.store.getSettings();
}
