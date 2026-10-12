import type { AuthUser } from "./auth.js";
import type { Config } from "./config.js";
import { proActive, type CallRow, type Store } from "./db/store.js";
import { ApiError } from "./errors.js";
import { callWithRetry, parseFeedbackOutput, parseTurnOutput, type FeedbackOutput } from "./llm/parse.js";
import { buildCustomerSystem, buildFeedbackSystem, buildFeedbackUser, buildTurnMessages } from "./llm/prompts.js";
import { qaScore, rubricFor, type Criterion } from "./llm/rubric.js";
import type { ScenarioCatalog } from "./scenarios/catalog.js";
import type { Scenario } from "./scenarios/load.js";
import { startOfDay } from "./time.js";
import {
  assertTurnShape, countRole, customerTurnNumber, meaningfulAgentLines, normalizeHistory, resolveEnd,
} from "./turnLogic.js";
import type { LlmClient } from "./types.js";
import { parseSessionBody } from "./validate.js";

export interface Deps {
  config: Config;
  catalog: ScenarioCatalog;
  store: Store;
  llm: LlmClient;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export const nowOf = (deps: Deps) => (deps.now ? deps.now() : new Date());

/** Feedback was asked for with fewer than this many real agent lines (the greeting counts). */
export const MIN_AGENT_LINES = 3;

function findScenario(deps: Deps, id: string): Scenario {
  const s = deps.catalog.get(id);
  if (!s) throw new ApiError(404, "unknown_scenario", `Unknown scenario "${id}".`);
  return s;
}

const capError = () => new ApiError(429, "session_token_cap", "This call reached its usage limit.");
const notFound = () => new ApiError(404, "not_found", "Call not found.");

/** Free accounts: free-tier scenarios only, and a daily number of calls. Pro: no limits. */
export async function checkCanStart(deps: Deps, user: AuthUser, scenario: Scenario): Promise<void> {
  const now = nowOf(deps);
  const profile = await deps.store.getProfile(user.userId);
  if (profile && proActive(profile, now)) return;
  if (scenario.tier === "pro") throw new ApiError(403, "pro_required", "This scenario is part of Pro.");
  const { freeDailyLimit } = await deps.store.getSettings();
  const today = await deps.store.countCallsSince(user.userId, startOfDay(now, deps.config.timeZone));
  if (today >= freeDailyLimit) throw new ApiError(403, "daily_limit", "Free calls for today are used up.");
}

/** The call this turn belongs to. The first turn (the agent's greeting) creates it, after the plan checks. */
async function openCall(deps: Deps, user: AuthUser, id: string, scenario: Scenario, firstTurn: boolean): Promise<CallRow> {
  const existing = await deps.store.getCall(id);
  if (existing) {
    if (existing.userId !== user.userId) throw notFound();
    if (existing.scenarioId !== scenario.id) throw new ApiError(400, "invalid_request", "Scenario does not match this call.");
    if (existing.finishedAt) throw new ApiError(400, "call_over", "This call already ended.");
    return existing;
  }
  if (!firstTurn) throw notFound();
  await checkCanStart(deps, user, scenario);
  await deps.store.createCall({ id, userId: user.userId, scenarioId: scenario.id });
  return { id, userId: user.userId, scenarioId: scenario.id, startedAt: nowOf(deps), turns: 0, tokens: 0, finishedAt: null };
}

export async function handleTurn(deps: Deps, user: AuthUser, body: unknown) {
  const { config, store } = deps;
  const { sessionId, scenarioId, history: rawHistory } = parseSessionBody(body, config);
  const scenario = findScenario(deps, scenarioId);

  const history = normalizeHistory(rawHistory);
  assertTurnShape(history);
  if (countRole(history, "customer") >= config.maxTurns) {
    throw new ApiError(400, "call_over", "This call already reached its maximum length.");
  }
  const call = await openCall(deps, user, sessionId, scenario, countRole(history, "customer") === 0);
  if (call.tokens >= config.sessionTokenCap - config.feedbackReserve) throw capError();

  const turn = customerTurnNumber(history);
  let spent = 0;
  let out;
  try {
    out = await callWithRetry({
      llm: deps.llm,
      system: buildCustomerSystem(scenario, turn, config.minTurns, config.maxTurns),
      messages: buildTurnMessages(history),
      maxTokens: 300,
      parse: parseTurnOutput,
      onUsage: (n) => { spent += n; },
    });
  } catch (e) {
    if (spent > 0) await store.recordUsage(call.id, spent, false);
    throw e;
  }
  await store.recordUsage(call.id, spent, true);

  return {
    line: out.line,
    callEnded: resolveEnd(out.end, turn, config.minTurns, config.maxTurns),
    turnNumber: turn,
    usage: { sessionTokensUsed: call.tokens + spent, sessionTokenCap: config.sessionTokenCap },
  };
}

/** The scorecard as the page shows it: rubric labels and weights next to each result, plus the 0-100 score. */
export function presentFeedback(f: FeedbackOutput, rubric: readonly Criterion[]) {
  const scores = Object.fromEntries(f.criteria.map((c) => [c.key, c.score]));
  return {
    qaScore: qaScore(scores, rubric),
    criteria: f.criteria.map((c) => {
      const r = rubric.find((x) => x.key === c.key);
      return { ...c, label: r?.label ?? c.key, weight: r?.weight ?? 0 };
    }),
    strengths: f.strengths,
    moments: f.moments,
    phrases: f.phrases,
    summary: f.summary,
  };
}

export async function handleFeedback(deps: Deps, user: AuthUser, body: unknown) {
  const { config, store } = deps;
  const { sessionId, scenarioId, history: rawHistory } = parseSessionBody(body, config);
  const scenario = findScenario(deps, scenarioId);
  const history = normalizeHistory(rawHistory);
  const rubric = rubricFor(scenario.callType);

  const call = await store.getCall(sessionId);
  if (!call || call.userId !== user.userId) throw notFound();
  if (call.scenarioId !== scenario.id) throw new ApiError(400, "invalid_request", "Scenario does not match this call.");
  const usage = (extra: number) => ({ sessionTokensUsed: call.tokens + extra, sessionTokenCap: config.sessionTokenCap });

  // Asking again (e.g. after a dropped connection) returns what was already saved.
  if (call.finishedAt) {
    const saved = await store.getCallDetail(user.userId, call.id);
    if (!saved) throw notFound();
    return { callId: call.id, ...presentFeedback(saved.feedback, rubric), usage: usage(0) };
  }

  if (meaningfulAgentLines(history) < MIN_AGENT_LINES) {
    throw new ApiError(422, "not_enough_speech", "Not enough of the call happened to score it.");
  }
  if (call.tokens >= config.sessionTokenCap) throw capError();

  let spent = 0;
  try {
    const feedback = await callWithRetry({
      llm: deps.llm,
      system: buildFeedbackSystem(scenario),
      messages: [{ role: "user", content: buildFeedbackUser(history) }],
      maxTokens: 2000,
      parse: (text) => parseFeedbackOutput(text, rubric),
      onUsage: (n) => { spent += n; },
    });
    const shown = presentFeedback(feedback, rubric);
    const durationSec = (nowOf(deps).getTime() - call.startedAt.getTime()) / 1000;
    await store.saveFeedback(call.id, durationSec, shown.qaScore, feedback, history);
    return { callId: call.id, ...shown, usage: usage(spent) };
  } finally {
    if (spent > 0) await store.recordUsage(call.id, spent, false);
  }
}
