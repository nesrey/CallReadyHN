import { ApiError } from "../errors.js";
import type { LlmClient, LlmMessage } from "../types.js";
import type { Criterion } from "./rubric.js";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export interface TurnOutput {
  line: string;
  end: boolean;
}
/** One scorecard line as the model returns it (score 0-10, with a quote and a tip). */
export interface CriterionResult {
  key: string;
  score: number;
  evidence: string;
  tip: string;
}
export interface Moment {
  said: string;
  better: string;
  why: string;
}
export interface Phrase {
  phrase: string;
  whenToUse: string;
}
export interface FeedbackOutput {
  /** In rubric order. */
  criteria: CriterionResult[];
  strengths: string[];
  moments: Moment[];
  phrases: Phrase[];
  summary: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pull the first JSON object out of model text, tolerating code fences and stray prose. */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) throw new ParseError("No JSON object found in the output");
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch (e) {
    throw new ParseError(`Invalid JSON: ${(e as Error).message}`);
  }
}

function nonEmpty(obj: Rec, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ParseError(`${where}.${key} must be a non-empty string`);
  }
  return v.trim();
}

export function parseTurnOutput(text: string): TurnOutput {
  const raw = extractJson(text);
  if (!isRec(raw)) throw new ParseError("Output must be a JSON object");
  const line = nonEmpty(raw, "line", "output");
  if (raw.end !== undefined && typeof raw.end !== "boolean") {
    throw new ParseError("output.end must be true or false");
  }
  return { line, end: raw.end === true };
}

function list(raw: Rec, key: string, min: number, max: number): unknown[] {
  const v = raw[key];
  if (!Array.isArray(v) || v.length < min) throw new ParseError(`output.${key} must be a list with at least ${min} item(s)`);
  return v.slice(0, max);
}

/** Validate the grader's JSON against the rubric for this call type. */
export function parseFeedbackOutput(text: string, rubric: readonly Criterion[]): FeedbackOutput {
  const raw = extractJson(text);
  if (!isRec(raw)) throw new ParseError("Output must be a JSON object");
  if (!isRec(raw.criteria)) throw new ParseError("output.criteria must be an object");
  const crit = raw.criteria;

  const criteria = rubric.map((c): CriterionResult => {
    const r = crit[c.key];
    if (!isRec(r)) throw new ParseError(`criteria.${c.key} is missing`);
    const s = r.score;
    if (typeof s !== "number" || !Number.isFinite(s)) throw new ParseError(`criteria.${c.key}.score must be a number`);
    const score = Math.round(s);
    if (score < 0 || score > 10) throw new ParseError(`criteria.${c.key}.score must be between 0 and 10`);
    return {
      key: c.key,
      score,
      evidence: nonEmpty(r, "evidence", `criteria.${c.key}`),
      tip: nonEmpty(r, "tip", `criteria.${c.key}`),
    };
  });

  const strengths = list(raw, "strengths", 1, 3).map((s, i) => {
    if (typeof s !== "string" || !s.trim()) throw new ParseError(`strengths[${i}] must be a non-empty string`);
    return s.trim();
  });
  const moments = list(raw, "moments", 1, 3).map((m, i): Moment => {
    if (!isRec(m)) throw new ParseError(`moments[${i}] must be an object`);
    return { said: nonEmpty(m, "said", `moments[${i}]`), better: nonEmpty(m, "better", `moments[${i}]`), why: nonEmpty(m, "why", `moments[${i}]`) };
  });
  const phrases = list(raw, "phrases", 1, 3).map((p, i): Phrase => {
    if (!isRec(p)) throw new ParseError(`phrases[${i}] must be an object`);
    return { phrase: nonEmpty(p, "phrase", `phrases[${i}]`), whenToUse: nonEmpty(p, "whenToUse", `phrases[${i}]`) };
  });

  return {
    criteria,
    strengths,
    moments,
    phrases,
    summary: typeof raw.summary === "string" ? raw.summary.trim() : "",
  };
}

export interface RetryOptions<T> {
  llm: LlmClient;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  parse: (text: string) => T;
  /** Called after every model call (including the retry) with input + output tokens. */
  onUsage: (tokens: number) => void;
}

/** Call the model, validate, and retry exactly once with the parse error fed back. */
export async function callWithRetry<T>(opts: RetryOptions<T>): Promise<T> {
  const { llm, system, messages, maxTokens, parse, onUsage } = opts;

  const first = await llm.complete({ system, messages, maxTokens });
  onUsage(first.inputTokens + first.outputTokens);
  let value: T;
  try {
    value = parse(first.text);
  } catch (err) {
    if (!(err instanceof ParseError)) throw err;
    const retry = await llm.complete({
      system,
      maxTokens,
      messages: [
        ...messages,
        { role: "assistant", content: first.text.trim() || "(empty)" },
        {
          role: "user",
          content: `Your last output was invalid: ${err.message}. Return ONLY valid JSON in the required shape, with no markdown and no extra text.`,
        },
      ],
    });
    onUsage(retry.inputTokens + retry.outputTokens);
    try {
      return parse(retry.text);
    } catch (err2) {
      if (err2 instanceof ParseError) {
        throw new ApiError(502, "llm_bad_output", "The model returned invalid output twice.");
      }
      throw err2;
    }
  }

  return value;
}
