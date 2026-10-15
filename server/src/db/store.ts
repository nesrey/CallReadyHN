import type { FeedbackOutput } from "../llm/parse.js";
import type { CallType, Scenario, Temperament } from "../scenarios/load.js";
import type { Message } from "../types.js";

export const ROLES = ["job_seeker", "agent", "trainer"] as const;
export type Role = (typeof ROLES)[number];

export interface Profile {
  userId: string;
  email: string;
  role: Role | null;
  /** Call types the learner cares about most; used to order the scenario list. */
  interests: CallType[];
  isPro: boolean;
  /** null means Pro has no end date (only meaningful when isPro is true). */
  proUntil: Date | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface Settings {
  freeDailyLimit: number;
  /** Shown on the Pro page: how to pay and get Pro activated (manual payments). */
  proInstructions: string;
}

export interface StoredScenario extends Scenario {
  enabled: boolean;
  sortOrder: number;
}

export interface CallRow {
  id: string;
  userId: string;
  scenarioId: string;
  startedAt: Date;
  /** Caller lines the AI has produced; a call counts toward the daily limit once this is above 0. */
  turns: number;
  tokens: number;
  finishedAt: Date | null;
  /**
   * true for every call made since the server started recording turns. false: a call from before that, whose
   * transcript came from the page; it can't be continued or scored now, but a scored one stays readable.
   */
  serverTranscript: boolean;
  /** When the server ended the call (the caller said goodbye or the turn limit was reached). */
  callerEndedAt: Date | null;
}

/** One finished turn: the agent's line and the caller's reply, written together by the lease holder. */
export interface TurnCommit {
  callId: string;
  userId: string;
  leaseToken: string;
  /** Position of the agent line; the caller's reply goes right after it. */
  position: number;
  agentText: string;
  callerText: string;
  tokens: number;
  ended: boolean;
}

export interface CallSummary {
  id: string;
  scenarioId: string;
  title: string;
  callType: CallType;
  temperament: Temperament;
  startedAt: Date;
  durationSec: number;
  qaScore: number;
}

export interface CallDetail extends CallSummary {
  /** The rubric version the stored score was computed with. */
  rubricVersion: number;
  feedback: FeedbackOutput;
  transcript: Message[];
}

export interface AdminUser {
  userId: string;
  email: string;
  role: Role | null;
  createdAt: Date;
  lastSeenAt: Date;
  isPro: boolean;
  proUntil: Date | null;
  /** Calls where the AI answered at least once. */
  calls: number;
  tokens: number;
  lastCallAt: Date | null;
  avgQa: number | null;
}

/** One started call, for the admin usage view (aggregated by day in code, in the configured time zone). */
export interface UsageRow {
  startedAt: Date;
  userId: string;
  tokens: number;
  qa: number | null;
}

/** Average score (0-10) per scorecard item across a learner's customer calls (interviews excluded). */
export interface SkillAverage {
  key: string;
  avg: number;
  n: number;
}

/** Admin overview: counts and the latest activity. */
export interface OverviewCounts {
  users: number;
  newUsers: number;
  proUsers: number;
}
export interface RecentCall {
  email: string;
  title: string;
  callType: CallType;
  temperament: Temperament;
  startedAt: Date;
  /** null while the call has no scorecard (abandoned or in progress). */
  qaScore: number | null;
}
export interface RecentUser {
  email: string;
  role: Role | null;
  createdAt: Date;
}
export interface ScenarioCount {
  title: string;
  callType: CallType;
  calls: number;
}

/** A user's Supabase sign-in record (auth.users), as far as the admin check needs it. */
export interface AuthAccount {
  /** Lower-cased current email, or null. */
  email: string | null;
  emailConfirmed: boolean;
  /** Banned right now (banned_until in the future). */
  banned: boolean;
  deleted: boolean;
  anonymous: boolean;
}

/** The quota periods one AI request counts toward. */
export interface AiPeriods {
  /** "d:YYYY-MM-DD" in the quota time zone. */
  day: string;
  /** "m:YYYY-MM" in the quota time zone. */
  month: string;
}
/** Limits for one reservation; 0 = no limit. */
export interface AiLimits {
  dayRequests: number;
  dayTokens: number;
  monthRequests: number;
}
export interface AiUsage {
  day: { requests: number; tokens: number };
  month: { requests: number; tokens: number };
}

export function proActive(p: Pick<Profile, "isPro" | "proUntil">, now: Date): boolean {
  return p.isPro && (p.proUntil === null || p.proUntil.getTime() > now.getTime());
}

export interface Store {
  migrate(): Promise<void>;

  /** Create the profile on first sign-in; refresh email and last-seen (at most every few minutes). */
  touchProfile(userId: string, email: string): Promise<void>;
  getProfile(userId: string): Promise<Profile | null>;
  /** The sign-in record Supabase keeps for this user (read-only), or null if there is none. */
  getAuthAccount(userId: string): Promise<AuthAccount | null>;
  updateProfile(userId: string, role: Role, interests: CallType[]): Promise<void>;

  getSettings(): Promise<Settings>;
  updateSettings(s: Settings): Promise<void>;

  listScenarios(): Promise<StoredScenario[]>;
  /** Insert scenarios that do not exist yet; never overwrites edits made in the admin page. */
  seedScenarios(list: Scenario[]): Promise<number>;
  saveScenario(s: Scenario, enabled: boolean): Promise<void>;
  setScenarioEnabled(id: string, enabled: boolean): Promise<boolean>;

  getCall(id: string): Promise<CallRow | null>;
  /** A new server-recorded call. Returns false when a call with this id already exists (nothing is changed then). */
  createCall(c: { id: string; userId: string; scenarioId: string }): Promise<boolean>;
  /** Add the tokens a model request used; count a turn when the AI produced a line. */
  recordUsage(callId: string, tokens: number, turn: boolean): Promise<void>;
  /** Calls with at least one AI turn, started at or after `since`. */
  countCallsSince(userId: string, since: Date): Promise<number>;

  /**
   * Take the call for one request (a turn or the scoring) under a fresh `token`, if it is unfinished and nobody holds
   * an unexpired lease. Returns the call as it is now, or null.
   */
  acquireLease(callId: string, userId: string, token: string, seconds: number): Promise<CallRow | null>;
  /** Add `tokens` and let go of the lease, but only if `token` still holds it (a newer holder is never released). */
  releaseLease(callId: string, userId: string, token: string, tokens: number): Promise<void>;
  /** Store a turn, its tokens, and the end of the call in one step; false (nothing stored) if the lease was lost. */
  commitTurn(t: TurnCommit): Promise<boolean>;
  /** The server's transcript of a call, in order. Empty for someone else's call. */
  getTurns(callId: string, userId: string): Promise<Message[]>;
  /** Delete the transcript lines of calls started before `before` that were never scored. Returns how many calls. */
  purgeAbandonedTurns(before: Date): Promise<number>;

  /**
   * Store the scorecard and close the call (its turns are already stored). With `leaseToken`, only the current lease
   * holder can save. False if nothing was saved.
   */
  saveFeedback(callId: string, durationSec: number, qaScore: number, f: FeedbackOutput, leaseToken?: string | null): Promise<boolean>;
  getCallDetail(userId: string, callId: string): Promise<CallDetail | null>;
  listCalls(userId: string, limit: number): Promise<CallSummary[]>;
  skillAverages(userId: string): Promise<SkillAverage[]>;

  /** Count one AI request in `p` if every limit still allows it (atomic). False = over a limit, nothing counted. */
  reserveAiRequest(p: AiPeriods, limits: AiLimits): Promise<boolean>;
  /** Add the tokens a finished AI request used. */
  addAiTokens(p: AiPeriods, tokens: number): Promise<void>;
  aiUsage(p: AiPeriods): Promise<AiUsage>;

  listUsers(opts: { query: string; limit: number; offset: number }): Promise<{ users: AdminUser[]; total: number }>;
  setPro(userId: string, isPro: boolean, proUntil: Date | null): Promise<boolean>;
  usageSince(since: Date): Promise<UsageRow[]>;
  /** newUsers: signed up at or after newSince; proUsers: Pro active at `now`. */
  overviewCounts(newSince: Date, now: Date): Promise<OverviewCounts>;
  recentCalls(limit: number): Promise<RecentCall[]>;
  recentUsers(limit: number): Promise<RecentUser[]>;
  topScenarios(since: Date, limit: number): Promise<ScenarioCount[]>;
}
