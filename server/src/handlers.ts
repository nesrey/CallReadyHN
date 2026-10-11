import type { Config } from "./config.js";
import { ApiError } from "./errors.js";
import { callWithRetry, parseFeedbackOutput, parseTurnOutput } from "./llm/parse.js";
import { polishSpanish } from "./llm/spanish.js";
import { buildCustomerSystem, buildFeedbackSystem, buildFeedbackUser, buildTurnMessages } from "./llm/prompts.js";
import type { TokenBudget } from "./limits.js";
import type { Scenario } from "./scenarios/load.js";
import {
  assertTurnShape, countRole, customerTurnNumber, meaningfulAgentLines, normalizeHistory, resolveEnd,
} from "./turnLogic.js";
import type { LlmClient } from "./types.js";
import { parseSessionBody } from "./validate.js";

export interface Deps {
  config: Config;
  scenarios: Map<string, Scenario>;
  llm: LlmClient;
  budget: TokenBudget;
}

function findScenario(deps: Deps, id: string): Scenario {
  const s = deps.scenarios.get(id);
  if (!s) throw new ApiError(404, "unknown_scenario", `Unknown scenario "${id}".`);
  return s;
}

const capError = () =>
  new ApiError(429, "session_token_cap", "This call reached its usage limit.");

export async function handleTurn(deps: Deps, body: unknown) {
  const { config, budget } = deps;
  const { sessionId, scenarioId, history: rawHistory } = parseSessionBody(body, config);
  const scenario = findScenario(deps, scenarioId);

  const history = normalizeHistory(rawHistory);
  assertTurnShape(history);
  if (countRole(history, "customer") >= config.maxTurns) {
    throw new ApiError(400, "call_over", "This call already reached its maximum length.");
  }
  if (!budget.canTakeTurn(sessionId)) throw capError();

  const turn = customerTurnNumber(history);
  const out = await callWithRetry({
    llm: deps.llm,
    system: buildCustomerSystem(scenario, turn, config.minTurns, config.maxTurns),
    messages: buildTurnMessages(history, scenario),
    maxTokens: 300,
    parse: parseTurnOutput,
    onUsage: (n) => budget.add(sessionId, n),
  });

  return {
    line: out.line,
    callEnded: resolveEnd(out.end, turn, config.minTurns, config.maxTurns),
    turnNumber: turn,
    usage: { sessionTokensUsed: budget.used(sessionId), sessionTokenCap: budget.limit },
  };
}

export async function handleFeedback(deps: Deps, body: unknown) {
  const { config, budget } = deps;
  const { sessionId, scenarioId, history: rawHistory } = parseSessionBody(body, config);
  const scenario = findScenario(deps, scenarioId);
  const history = normalizeHistory(rawHistory);

  if (meaningfulAgentLines(history) < 2) {
    throw new ApiError(422, "not_enough_speech", "Not enough learner speech to give feedback.");
  }
  if (!budget.canGiveFeedback(sessionId)) throw capError();

  const onUsage = (n: number) => budget.add(sessionId, n);
  const draft = await callWithRetry({
    llm: deps.llm,
    system: buildFeedbackSystem(scenario),
    messages: [{ role: "user", content: buildFeedbackUser(history) }],
    maxTokens: 1400,
    parse: parseFeedbackOutput,
    onUsage,
  });
  // Small models often drop accents or use tú/vos; a focused Spanish-only proofread fixes most of it.
  const feedback = await polishSpanish(deps.llm, draft, onUsage);

  return {
    ...feedback,
    usage: { sessionTokensUsed: budget.used(sessionId), sessionTokenCap: budget.limit },
  };
}
