import type { AuthUser } from "./auth.js";
import { proActive, type Goal } from "./db/store.js";
import { ApiError } from "./errors.js";
import { nowOf, type Deps } from "./handlers.js";
import { DIFFICULTIES, type Difficulty } from "./scenarios/load.js";
import { startOfDay } from "./time.js";
import { isUuid } from "./validate.js";

const GOALS: readonly Goal[] = ["job", "improve"];
const bad = (msg: string) => new ApiError(400, "invalid_request", msg);

export function isAdmin(deps: Deps, user: AuthUser): boolean {
  return deps.config.adminEmails.includes(user.email);
}

/** Everything the page needs about the signed-in learner. */
export async function getMe(deps: Deps, user: AuthUser) {
  const now = nowOf(deps);
  const [profile, settings, callsToday] = await Promise.all([
    deps.store.getProfile(user.userId),
    deps.store.getSettings(),
    deps.store.countCallsSince(user.userId, startOfDay(now, deps.config.timeZone)),
  ]);
  if (!profile) throw new ApiError(401, "unauthorized", "Sign in again.");
  const pro = proActive(profile, now);
  return {
    email: profile.email,
    goal: profile.goal,
    level: profile.level,
    isPro: pro,
    proUntil: pro && profile.proUntil ? profile.proUntil.toISOString() : null,
    isAdmin: isAdmin(deps, user),
    callsToday,
    freeDailyLimit: settings.freeDailyLimit,
    proInstructionsEs: settings.proInstructionsEs,
    /** For showing dates (e.g. Pro end) in the same time zone the server counts days in. */
    timeZone: deps.config.timeZone,
  };
}

export async function updateMe(deps: Deps, user: AuthUser, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!GOALS.includes(b.goal as Goal)) throw bad("goal must be job or improve.");
  if (!(DIFFICULTIES as readonly string[]).includes(b.level as string)) throw bad("level must be A2, B1 or B2.");
  await deps.store.updateGoalLevel(user.userId, b.goal as Goal, b.level as Difficulty);
  return getMe(deps, user);
}

export async function listMyCalls(deps: Deps, user: AuthUser) {
  const calls = await deps.store.listCalls(user.userId, 200);
  return { calls: calls.map((c) => ({ ...c, startedAt: c.startedAt.toISOString() })) };
}

export async function getMyCall(deps: Deps, user: AuthUser, id: string) {
  if (!isUuid(id)) throw new ApiError(404, "not_found", "Call not found.");
  const c = await deps.store.getCallDetail(user.userId, id);
  if (!c) throw new ApiError(404, "not_found", "Call not found.");
  return { ...c, startedAt: c.startedAt.toISOString() };
}
