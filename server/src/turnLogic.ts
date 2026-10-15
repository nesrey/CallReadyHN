import { ApiError } from "./errors.js";
import type { Message } from "./types.js";

/** Merge consecutive messages from the same speaker so roles strictly alternate. */
export function normalizeHistory(history: Message[]): Message[] {
  const out: Message[] = [];
  for (const m of history) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      out[out.length - 1] = { role: m.role, text: `${last.text} ${m.text}` };
    } else {
      out.push({ role: m.role, text: m.text });
    }
  }
  return out;
}

export function countRole(history: Message[], role: Message["role"]): number {
  return history.filter((m) => m.role === role).length;
}

/** The agent answers the call first, and always has the last word before the AI replies. */
export function assertTurnShape(history: Message[]): void {
  if (history.length === 0 || history[0]!.role !== "agent") {
    throw new ApiError(400, "invalid_request", "The agent answers the call first.");
  }
  if (history[history.length - 1]!.role !== "agent") {
    throw new ApiError(400, "invalid_request", "History must end with the agent's line.");
  }
}

/**
 * What a turn request asks for, from a normalized history that ends with the agent: `seq` is how many caller lines
 * the page has seen (the agent is answering caller line number `seq`), `agentText` is the agent's new line. Nothing
 * else in the page's history is trusted.
 */
export function sequenceOf(history: Message[]): { seq: number; agentText: string } {
  return { seq: countRole(history, "customer"), agentText: history[history.length - 1]!.text };
}

/** The server, not the model, decides when the call is allowed to end. */
export function resolveEnd(modelEnd: boolean, turn: number, minTurns: number, maxTurns: number): boolean {
  if (turn < minTurns) return false;
  if (turn >= maxTurns) return true;
  return modelEnd;
}

/** Agent lines with at least 2 words; used to refuse feedback on an (almost) empty call. */
export function meaningfulAgentLines(history: Message[]): number {
  return history.filter(
    (m) => m.role === "agent" && m.text.trim().split(/\s+/).filter(Boolean).length >= 2,
  ).length;
}
