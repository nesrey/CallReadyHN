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

export function proActive(p: Pick<Profile, "isPro" | "proUntil">, now: Date): boolean {
  return p.isPro && (p.proUntil === null || p.proUntil.getTime() > now.getTime());
}

export interface Store {
  migrate(): Promise<void>;

  /** Create the profile on first sign-in; refresh email and last-seen (at most every few minutes). */
  touchProfile(userId: string, email: string): Promise<void>;
  getProfile(userId: string): Promise<Profile | null>;
  updateProfile(userId: string, role: Role, interests: CallType[]): Promise<void>;

  getSettings(): Promise<Settings>;
  updateSettings(s: Settings): Promise<void>;

  listScenarios(): Promise<StoredScenario[]>;
  /** Insert scenarios that do not exist yet; never overwrites edits made in the admin page. */
  seedScenarios(list: Scenario[]): Promise<number>;
  saveScenario(s: Scenario, enabled: boolean): Promise<void>;
  setScenarioEnabled(id: string, enabled: boolean): Promise<boolean>;

  getCall(id: string): Promise<CallRow | null>;
  createCall(c: { id: string; userId: string; scenarioId: string }): Promise<void>;
  /** Add the tokens a model request used; count a turn when the AI produced a line. */
  recordUsage(callId: string, tokens: number, turn: boolean): Promise<void>;
  /** Calls with at least one AI turn, started at or after `since`. */
  countCallsSince(userId: string, since: Date): Promise<number>;
  /** Store the scorecard and transcript and close the call. Returns false if the call was already closed. */
  saveFeedback(callId: string, durationSec: number, qaScore: number, f: FeedbackOutput, transcript: Message[]): Promise<boolean>;
  getCallDetail(userId: string, callId: string): Promise<CallDetail | null>;
  listCalls(userId: string, limit: number): Promise<CallSummary[]>;
  skillAverages(userId: string): Promise<SkillAverage[]>;

  listUsers(opts: { query: string; limit: number; offset: number }): Promise<{ users: AdminUser[]; total: number }>;
  setPro(userId: string, isPro: boolean, proUntil: Date | null): Promise<boolean>;
  usageSince(since: Date): Promise<UsageRow[]>;
}
