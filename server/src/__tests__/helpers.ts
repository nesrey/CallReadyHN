import type { LlmClient, LlmRequest, LlmResponse, Message } from "../types.js";

export class MockLlm implements LlmClient {
  calls: LlmRequest[] = [];
  constructor(private responses: Array<string | Error>, private tokens = { in: 100, out: 50 }) {}
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("MockLlm: no more responses");
    if (next instanceof Error) throw next;
    return { text: next, inputTokens: this.tokens.in, outputTokens: this.tokens.out };
  }
}

/** n customer/agent exchanges: C, A, C, A ... ending with an agent line. */
export function exchanges(n: number): Message[] {
  const out: Message[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({ role: "customer", text: `Customer line ${i}.` });
    out.push({ role: "agent", text: `Agent answer number ${i} thank you.` });
  }
  return out;
}

export const goodFeedback = JSON.stringify({
  scores: { fluency: 6, grammar: 5, vocabulary: 6, empathyPoliteness: 7, callFlow: 6 },
  corrections: [1, 2, 3].map((i) => ({
    said: `I can't to help ${i}`,
    better: `I'm unable to help ${i}`,
    explanationEs: "Después de 'can' no se usa 'to'.",
  })),
  phrases: [1, 2, 3].map((i) => ({
    phrase: `Phrase ${i}`,
    meaningEs: "Significado",
    whenToUseEs: "Cuando sea necesario",
  })),
  overallSummaryEs: "Buen trabajo.",
});
