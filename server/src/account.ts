import type { AuthUser } from "./auth.js";
import { proActive, ROLES, type AuthAccount, type Role } from "./db/store.js";
import { ApiError } from "./errors.js";
import { nowOf, presentFeedback, type Deps } from "./handlers.js";
import { CUSTOMER_RUBRIC, rubricFor } from "./llm/rubric.js";
import { CALL_TYPES, type CallType } from "./scenarios/load.js";
import { startOfDay } from "./time.js";
import { isUuid } from "./validate.js";

const bad = (msg: string) => new ApiError(400, "invalid_request", msg);

/**
 * Why a user whose token email is in ADMIN_EMAILS should still not be trusted as an admin, or null if nothing is
 * wrong. Only Supabase's own record counts here, never anything the user can edit (like user_metadata).
 */
export function adminProblem(account: AuthAccount | null, tokenEmail: string, adminEmails: readonly string[]): string | null {
  if (!account) return "no sign-in record";
  if (account.deleted) return "account deleted";
  if (account.anonymous) return "anonymous account";
  if (account.banned) return "account banned";
  if (!account.emailConfirmed) return "email not confirmed";
  if (!account.email || !adminEmails.includes(account.email)) return "sign-in email is not an admin email";
  if (account.email !== tokenEmail) return "token email differs from the account's current email";
  return null;
}

/**
 * Admin = the token's email is in ADMIN_EMAILS and Supabase's record of that user agrees (confirmed, current, not
 * banned or deleted). ADMIN_AUTH_MODE=report only logs a disagreement; enforce refuses. Ordinary users never reach
 * the database lookup.
 */
export async function isAdmin(deps: Deps, user: AuthUser): Promise<boolean> {
  const { adminEmails, adminAuthMode } = deps.config;
  if (!adminEmails.includes(user.email)) return false;
  let problem: string | null;
  try {
    problem = adminProblem(await deps.store.getAuthAccount(user.userId), user.email, adminEmails);
  } catch (e) {
    problem = `sign-in record could not be read (${(e as Error).message})`;
  }
  if (!problem) return true;
  console.warn(`admin_auth ${adminAuthMode === "enforce" ? "refused" : "would refuse"}: user ${user.userId}: ${problem}`);
  return adminAuthMode === "report";
}

/** Everything the page needs about the signed-in learner. */
export async function getMe(deps: Deps, user: AuthUser) {
  const now = nowOf(deps);
  const [profile, settings, callsToday, admin] = await Promise.all([
    deps.store.getProfile(user.userId),
    deps.store.getSettings(),
    deps.store.countCallsSince(user.userId, startOfDay(now, deps.config.timeZone)),
    isAdmin(deps, user),
  ]);
  if (!profile) throw new ApiError(401, "unauthorized", "Sign in again.");
  const pro = proActive(profile, now);
  return {
    email: profile.email,
    role: profile.role,
    interests: profile.interests,
    isPro: pro,
    proUntil: pro && profile.proUntil ? profile.proUntil.toISOString() : null,
    isAdmin: admin,
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
  const [calls, skills] = await Promise.all([deps.store.listCalls(user.userId, 200), deps.store.skillAverages(user.userId)]);
  return {
    calls: calls.map((c) => ({ ...c, startedAt: c.startedAt.toISOString() })),
    // In scorecard order, only the items the learner has been scored on.
    skills: CUSTOMER_RUBRIC.flatMap((c) => {
      const s = skills.find((x) => x.key === c.key);
      return s ? [{ key: c.key, label: c.label, avg: s.avg, n: s.n }] : [];
    }),
  };
}

export async function getMyCall(deps: Deps, user: AuthUser, id: string) {
  if (!isUuid(id)) throw new ApiError(404, "not_found", "Call not found.");
  const c = await deps.store.getCallDetail(user.userId, id);
  if (!c) throw new ApiError(404, "not_found", "Call not found.");
  const { feedback, ...rest } = c;
  // Shown exactly as it was scored: the stored score, and the rubric version it was scored with.
  return { ...rest, startedAt: c.startedAt.toISOString(), feedback: presentFeedback(feedback, rubricFor(c.callType, c.rubricVersion), c.qaScore) };
}
