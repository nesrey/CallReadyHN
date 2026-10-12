import type { AuthUser } from "./auth.js";
import { proActive, ROLES, type Role } from "./db/store.js";
import { ApiError } from "./errors.js";
import { nowOf, presentFeedback, type Deps } from "./handlers.js";
import { rubricFor } from "./llm/rubric.js";
import { CALL_TYPES, type CallType } from "./scenarios/load.js";
import { startOfDay } from "./time.js";
import { isUuid } from "./validate.js";

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
    role: profile.role,
    interests: profile.interests,
    isPro: pro,
    proUntil: pro && profile.proUntil ? profile.proUntil.toISOString() : null,
    isAdmin: isAdmin(deps, user),
    callsToday,
    freeDailyLimit: settings.freeDailyLimit,
    proInstructions: settings.proInstructions,
    /** For showing dates (e.g. Pro end) in the same time zone the server counts days in. */
    timeZone: deps.config.timeZone,
  };
}

export async function updateMe(deps: Deps, user: AuthUser, body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!(ROLES as readonly string[]).includes(b.role as string)) throw bad(`role must be one of ${ROLES.join(", ")}.`);
  const interests = b.interests;
  if (!Array.isArray(interests) || interests.some((x) => !(CALL_TYPES as readonly string[]).includes(x as string))) {
    throw bad(`interests must be a list of ${CALL_TYPES.join(", ")}.`);
  }
  await deps.store.updateProfile(user.userId, b.role as Role, [...new Set(interests as CallType[])]);
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
  const { feedback, ...rest } = c;
  return { ...rest, startedAt: c.startedAt.toISOString(), feedback: presentFeedback(feedback, rubricFor(c.callType)) };
}
