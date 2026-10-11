import { ApiError } from "../errors.js";
import type { LlmClient, LlmMessage } from "../types.js";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export const SCORE_KEYS = ["fluency", "grammar", "vocabulary", "empathyPoliteness", "callFlow"] as const;
export type ScoreKey = (typeof SCORE_KEYS)[number];

export interface TurnOutput {
  line: string;
  end: boolean;
}
export interface Correction {
  said: string;
  better: string;
  explanationEs: string;
}
export interface Phrase {
  phrase: string;
  meaningEs: string;
  whenToUseEs: string;
}
export interface FeedbackOutput {
  scores: Record<ScoreKey, number>;
  corrections: Correction[];
  phrases: Phrase[];
  overallSummaryEs: string;
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

function parseScore(v: unknown, key: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new ParseError(`scores.${key} must be a number`);
  }
  const n = Math.round(v);
  if (n < 1 || n > 10) throw new ParseError(`scores.${key} must be between 1 and 10`);
  return n;
}

export function parseFeedbackOutput(text: string): FeedbackOutput {
  const raw = extractJson(text);
  if (!isRec(raw)) throw new ParseError("Output must be a JSON object");

  if (!isRec(raw.scores)) throw new ParseError("output.scores must be an object");
  const scores = {} as Record<ScoreKey, number>;
  for (const k of SCORE_KEYS) scores[k] = parseScore(raw.scores[k], k);

  if (!Array.isArray(raw.corrections) || raw.corrections.length !== 3) {
    throw new ParseError("output.corrections must contain exactly 3 items");
  }
  const corrections = raw.corrections.map((c: unknown, i: number): Correction => {
    if (!isRec(c)) throw new ParseError(`corrections[${i}] must be an object`);
    return {
      said: nonEmpty(c, "said", `corrections[${i}]`),
      better: nonEmpty(c, "better", `corrections[${i}]`),
      explanationEs: nonEmpty(c, "explanationEs", `corrections[${i}]`),
    };
  });

  if (!Array.isArray(raw.phrases) || raw.phrases.length !== 3) {
    throw new ParseError("output.phrases must contain exactly 3 items");
  }
  const phrases = raw.phrases.map((p: unknown, i: number): Phrase => {
    if (!isRec(p)) throw new ParseError(`phrases[${i}] must be an object`);
    return {
      phrase: nonEmpty(p, "phrase", `phrases[${i}]`),
      meaningEs: nonEmpty(p, "meaningEs", `phrases[${i}]`),
      whenToUseEs: nonEmpty(p, "whenToUseEs", `phrases[${i}]`),
    };
  });

  const summary = raw.overallSummaryEs;
  return {
    scores,
    corrections,
    phrases,
    overallSummaryEs: typeof summary === "string" ? summary.trim() : "",
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
  try {
    return parse(first.text);
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
}
