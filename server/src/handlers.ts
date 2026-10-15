import { randomUUID } from "node:crypto";
import type { AuthUser } from "./auth.js";
import type { Config } from "./config.js";
import { proActive, type AiLimits, type AiPeriods, type CallRow, type Store } from "./db/store.js";
import { ApiError } from "./errors.js";
import { CALL_TTL_MS, type TranscriptJanitor } from "./janitor.js";
import { callWithRetry, parseFeedbackOutput, parseTurnOutput, type FeedbackOutput } from "./llm/parse.js";
import { buildCustomerSystem, buildFeedbackSystem, buildFeedbackUser, buildTurnMessages } from "./llm/prompts.js";
import { qaScore, rubricFor, type Criterion } from "./llm/rubric.js";
import type { ScenarioCatalog } from "./scenarios/catalog.js";
import type { Scenario } from "./scenarios/load.js";
import { dayKey, startOfDay } from "./time.js";
import { assertTurnShape, countRole, meaningfulAgentLines, normalizeHistory, resolveEnd, sequenceOf } from "./turnLogic.js";
import type { LlmClient } from "./types.js";
import { parseSessionBody } from "./validate.js";

export interface Deps {
  config: Config;
  catalog: ScenarioCatalog;
  store: Store;
  llm: LlmClient;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Deletes old partial transcripts; nudged on each turn. */
  janitor?: TranscriptJanitor;
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
const callOver = (msg = "This call already ended.") => new ApiError(400, "call_over", msg);
const inProgress = () => new ApiError(409, "turn_in_progress", "The last reply is still being prepared. Try again in a moment.", 3);
const outOfSync = () => new ApiError(409, "turn_conflict", "This call is out of sync with the server.");
/** An unscored call from before the server recorded transcripts. They all expired within a day of that change. */
const oldCall = () => callOver("This call can no longer be continued.");

/** The quota day and month `now` falls in, in the AI quota time zone. */
export function aiPeriods(now: Date, timeZone: string): AiPeriods {
  const day = dayKey(now, timeZone);
  return { day: `d:${day}`, month: `m:${day.slice(0, 7)}` };
}

/** Request limits for one AI request: a new call must leave the reserve free for calls already running. */
export function aiLimits(cap: Config["aiCap"], newCall: boolean): AiLimits {
  const reserve = newCall ? cap.newCallReserve : 0;
  const less = (n: number) => (n > 0 ? n - reserve : 0);
  return { dayRequests: less(cap.dailyRequests), dayTokens: cap.dailyTokens, monthRequests: less(cap.monthlyRequests) };
}

const aiCapacity = () => new ApiError(503, "ai_capacity", "CallReady has reached today's practice limit. Please try again tomorrow.");

/**
 * The model, counted against the site-wide AI budget: every attempt (retries too) reserves one request first and
 * is refused once a limit is reached; a request that fails still counts, as it does at the provider.
 */
function meteredLlm(deps: Deps, newCall: boolean): LlmClient {
  return {
    async complete(req) {
      const periods = aiPeriods(nowOf(deps), deps.config.aiCap.timeZone);
      if (!(await deps.store.reserveAiRequest(periods, aiLimits(deps.config.aiCap, newCall)))) throw aiCapacity();
      const res = await deps.llm.complete(req);
      try {
        await deps.store.addAiTokens(periods, res.inputTokens + res.outputTokens);
      } catch (e) {
        console.error("Could not record AI tokens:", (e as Error).message);
      }
      return res;
    },
  };
}

/** An unscored call older than the time limit can no longer be continued or scored. */
const expired = (call: CallRow, now: Date) => call.finishedAt === null && now.getTime() - call.startedAt.getTime() >= CALL_TTL_MS;

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
  const { store, config } = deps;
  let call = await store.getCall(id);
  if (!call) {
    if (!firstTurn) throw notFound();
    await checkCanStart(deps, user, scenario);
    // A second request with the same id may have created it first; then the checks below decide.
    const created = await store.createCall({ id, userId: user.userId, scenarioId: scenario.id });
    call = await store.getCall(id);
    if (!call) throw notFound();
    if (created) return call;
  }
  if (call.userId !== user.userId) throw notFound();
  if (call.scenarioId !== scenario.id) throw new ApiError(400, "invalid_request", "Scenario does not match this call.");
  if (call.finishedAt) throw callOver();
  if (expired(call, nowOf(deps))) throw callOver("This call expired.");
  if (!call.serverTranscript) throw oldCall();
  return call;
}

/** The lease was not free: the call was scored meanwhile, or another request is working on it. */
async function busyOrOver(deps: Deps, callId: string): Promise<ApiError> {
  const again = await deps.store.getCall(callId);
  return again?.finishedAt ? callOver() : inProgress();
}

/** Let go of a lease without hiding the error that is already on its way out. */
async function release(deps: Deps, callId: string, userId: string, token: string, tokens: number): Promise<void> {
  try {
    await deps.store.releaseLease(callId, userId, token, tokens);
  } catch (e) {
    console.error(`Could not release call ${callId}:`, (e as Error).message);
  }
}

export async function handleTurn(deps: Deps, user: AuthUser, body: unknown) {
  const { config } = deps;
  const { sessionId, scenarioId, history: rawHistory } = parseSessionBody(body, config);
  const scenario = findScenario(deps, scenarioId);

  const history = normalizeHistory(rawHistory);
  assertTurnShape(history);
  const { seq, agentText } = sequenceOf(history);
  if (seq >= config.maxTurns) throw callOver("This call already reached its maximum length.");
  const call = await openCall(deps, user, sessionId, scenario, seq === 0);
  deps.janitor?.tick();
  return serverTurn(deps, user, call, scenario, seq, agentText);
}

/**
 * One turn on a server-recorded call. The page supplies only the agent's new line and which caller line it answers
 * (`seq`); the conversation so far comes from the server's own records.
 */
async function serverTurn(deps: Deps, user: AuthUser, call: CallRow, scenario: Scenario, seq: number, agentText: string) {
  const { config, store } = deps;
  const token = randomUUID();
  const live = await store.acquireLease(call.id, user.userId, token, config.leaseSeconds);
  if (!live) throw await busyOrOver(deps, call.id);

  let spent = 0;
  let held = true;
  try {
    const turns = await store.getTurns(call.id, user.userId);
    const stored = countRole(turns, "customer");
    const usage = (extra: number) => ({ sessionTokensUsed: live.tokens + extra, sessionTokenCap: config.sessionTokenCap });

    if (stored > seq) {
      // Already answered: a retry gets the same reply; a different line for an answered turn is refused.
      const said = turns[2 * seq];
      const reply = turns[2 * seq + 1];
      if (!said || !reply || said.role !== "agent" || said.text !== agentText) throw outOfSync();
      const last = seq + 1 === stored;
      return { line: reply.text, callEnded: last && live.callerEndedAt !== null, turnNumber: seq + 1, usage: usage(0) };
    }
    if (stored < seq) throw outOfSync();
    if (live.callerEndedAt) throw callOver();
    if (live.tokens >= config.sessionTokenCap - config.feedbackReserve) throw capError();

    const turn = seq + 1;
    const out = await callWithRetry({
      llm: meteredLlm(deps, seq === 0), // the greeting's reply starts a new call
      system: buildCustomerSystem(scenario, turn, config.minTurns, config.maxTurns),
      messages: buildTurnMessages([...turns, { role: "agent", text: agentText }]),
      maxTokens: 300,
      parse: parseTurnOutput,
      onUsage: (n) => { spent += n; },
    });
    const ended = resolveEnd(out.end, turn, config.minTurns, config.maxTurns);
    const committed = await store.commitTurn({
      callId: call.id, userId: user.userId, leaseToken: token, position: 2 * seq, agentText, callerText: out.line, tokens: spent, ended,
    });
    // The lease ran out while the model was answering; a newer request owns the call now, so this reply is dropped.
    if (!committed) throw inProgress();
    held = false;
    return { line: out.line, callEnded: ended, turnNumber: turn, usage: usage(spent) };
  } finally {
    if (held) await release(deps, call.id, user.userId, token, spent);
  }
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
  const { store } = deps;
  // Whatever history the page sends is not used: the server scores its own record of the call.
  const { sessionId, scenarioId } = parseSessionBody(body, deps.config, { historyRequired: false });
  const scenario = findScenario(deps, scenarioId);
  const rubric = rubricFor(scenario.callType);

  const call = await store.getCall(sessionId);
  if (!call || call.userId !== user.userId) throw notFound();
  if (call.scenarioId !== scenario.id) throw new ApiError(400, "invalid_request", "Scenario does not match this call.");

  // Asking again (e.g. after a dropped connection) returns what was already saved.
  if (call.finishedAt) return savedFeedback(deps, user, call, rubric);
  if (expired(call, nowOf(deps))) throw callOver("This call expired.");
  if (!call.serverTranscript) throw oldCall();
  return serverFeedback(deps, user, call, scenario, rubric);
}

async function savedFeedback(deps: Deps, user: AuthUser, call: CallRow, rubric: readonly Criterion[]) {
  const saved = await deps.store.getCallDetail(user.userId, call.id);
  if (!saved) throw notFound();
  return {
    callId: call.id,
    ...presentFeedback(saved.feedback, rubric),
    transcript: saved.transcript,
    usage: { sessionTokensUsed: call.tokens, sessionTokenCap: deps.config.sessionTokenCap },
  };
}

/** Scores the server's own transcript. The history in the request is not used. */
async function serverFeedback(deps: Deps, user: AuthUser, call: CallRow, scenario: Scenario, rubric: readonly Criterion[]) {
  const { config, store } = deps;
  const token = randomUUID();
  const live = await store.acquireLease(call.id, user.userId, token, config.leaseSeconds);
  if (!live) {
    const again = await store.getCall(call.id);
    if (again?.finishedAt) return savedFeedback(deps, user, again, rubric);
    throw inProgress();
  }

  let spent = 0;
  let held = true;
  try {
    const transcript = await store.getTurns(call.id, user.userId);
    if (meaningfulAgentLines(transcript) < MIN_AGENT_LINES) {
      throw new ApiError(422, "not_enough_speech", "Not enough of the call happened to score it.");
    }
    if (live.tokens >= config.sessionTokenCap) throw capError();

    const feedback = await callWithRetry({
      llm: meteredLlm(deps, false),
      system: buildFeedbackSystem(scenario),
      messages: [{ role: "user", content: buildFeedbackUser(transcript) }],
      maxTokens: 2000,
      parse: (text) => parseFeedbackOutput(text, rubric),
      onUsage: (n) => { spent += n; },
    });
    const shown = presentFeedback(feedback, rubric);
    const durationSec = (nowOf(deps).getTime() - call.startedAt.getTime()) / 1000;
    if (!(await store.saveFeedback(call.id, durationSec, shown.qaScore, feedback, token))) {
      // The lease ran out while grading; whoever holds the call now decides. Never return an unsaved scorecard.
      const again = await store.getCall(call.id);
      if (again?.finishedAt) return savedFeedback(deps, user, again, rubric);
      throw inProgress();
    }
    held = false;
    return {
      callId: call.id, ...shown, transcript,
      usage: { sessionTokensUsed: live.tokens + spent, sessionTokenCap: config.sessionTokenCap },
    };
  } finally {
    if (held) await release(deps, call.id, user.userId, token, spent);
    else if (spent > 0) await store.recordUsage(call.id, spent, false);
  }
}
