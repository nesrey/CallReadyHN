import { ApiError } from "./errors.js";
import type { Message } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCENARIO_ID = /^[a-z0-9-]{1,64}$/;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

export interface SessionBody {
  /** The call's id: a UUID the page generates; the first turn creates the call with it. */
  sessionId: string;
  scenarioId: string;
  history: Message[];
}

const bad = (msg: string) => new ApiError(400, "invalid_request", msg);

export function parseSessionBody(
  body: unknown,
  limits: { maxHistory: number; maxChars: number },
): SessionBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw bad("Body must be a JSON object.");
  }
  const b = body as Record<string, unknown>;
  if (!isUuid(b.sessionId)) throw bad("sessionId must be a UUID.");
  if (typeof b.scenarioId !== "string" || !SCENARIO_ID.test(b.scenarioId)) {
    throw bad("scenarioId is invalid.");
  }
  if (!Array.isArray(b.history)) throw bad("history must be an array.");
  if (b.history.length > limits.maxHistory) {
    throw bad(`history can have at most ${limits.maxHistory} messages.`);
  }
  const history = b.history.map((m: unknown, i: number): Message => {
    if (typeof m !== "object" || m === null) throw bad(`history[${i}] must be an object.`);
    const { role, text } = m as Record<string, unknown>;
    if (role !== "customer" && role !== "agent") throw bad(`history[${i}].role must be customer or agent.`);
    if (typeof text !== "string") throw bad(`history[${i}].text must be a string.`);
    const t = text.trim();
    if (t.length === 0) throw bad(`history[${i}].text cannot be empty.`);
    if (t.length > limits.maxChars) throw bad(`history[${i}].text is longer than ${limits.maxChars} characters.`);
    return { role, text: t };
  });
  return { sessionId: b.sessionId, scenarioId: b.scenarioId, history };
}
