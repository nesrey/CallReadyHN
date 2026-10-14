import { PGlite } from "@electric-sql/pglite";
import { PgStore } from "../db/pgStore.js";
import { loadScenariosFromDisk } from "../scenarios/load.js";
import type { LlmClient, LlmRequest, LlmResponse, Message } from "../types.js";

export class MockLlm implements LlmClient {
  calls: LlmRequest[] = [];
  constructor(private responses: Array<string | Error>, private tokens = { in: 100, out: 50 }) {}
  /** Queue more responses (for tests that share one mock). */
  push(...more: Array<string | Error>): void {
    this.responses.push(...more);
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("MockLlm: no more responses");
    if (next instanceof Error) throw next;
    return { text: next, inputTokens: this.tokens.in, outputTokens: this.tokens.out };
  }
}

/** The agent's greeting, then n caller/agent exchanges: A, C, A, C ... A. Ends with an agent line. */
export function exchanges(n: number): Message[] {
  const out: Message[] = [{ role: "agent", text: "Thank you for calling, my name is Ana. How can I help you?" }];
  for (let i = 1; i <= n; i++) {
    out.push({ role: "customer", text: `Customer line ${i}.` });
    out.push({ role: "agent", text: `Agent answer number ${i} thank you.` });
  }
  return out;
}

/** A valid scorecard for a customer call: every criterion 6/10 (QA 60). */
export function feedbackFor(keys: readonly string[], score = 6) {
  return {
    criteria: Object.fromEntries(keys.map((k) => [k, { score, evidence: `"quote for ${k}"`, tip: `Tip for ${k}.` }])),
    strengths: ["You verified the caller.", "You kept a calm tone."],
    moments: [1, 2, 3].map((i) => ({ said: `no problem ${i}`, better: `Certainly ${i}`, why: "Sounds more professional." })),
    phrases: [1, 2, 3].map((i) => ({ phrase: `Phrase ${i}`, whenToUse: "When closing." })),
    summary: "Solid call.",
  };
}
export const CUSTOMER_KEYS = ["opening", "verification", "listening", "empathy", "control", "resolution", "language", "closing"];
export const goodFeedback = JSON.stringify(feedbackFor(CUSTOMER_KEYS));

/** A model that waits until the test opens the gate, so tests can hold a request "inside" the AI call. */
export class GateLlm implements LlmClient {
  calls: LlmRequest[] = [];
  private waiting: Array<() => void> = [];
  constructor(private responses: string[]) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    await new Promise<void>((r) => this.waiting.push(r));
    const next = this.responses.shift();
    if (next === undefined) throw new Error("GateLlm: no more responses");
    return { text: next, inputTokens: 100, outputTokens: 50 };
  }
  get pending(): number {
    return this.waiting.length;
  }
  open(): void {
    for (const r of this.waiting.splice(0)) r();
  }
}

/** Wait (yielding to the event loop) until `cond` holds. */
export async function until(cond: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A fresh in-memory Postgres (PGlite) with the schema and the seed scenarios. */
export async function freshStore(): Promise<PgStore> {
  const store = new PgStore(new PGlite());
  await store.migrate();
  await store.seedScenarios(loadScenariosFromDisk());
  return store;
}
