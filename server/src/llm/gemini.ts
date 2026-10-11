import { ApiError } from "../errors.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../types.js";

interface GeminiPart {
  text?: string;
  thought?: boolean;
}
export interface GeminiResponse {
  candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
}

/** Gemini's output limit also covers "thinking" tokens, so leave room above the visible answer. */
const THINKING_HEADROOM = 512;

export function buildGeminiBody(req: LlmRequest) {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: req.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
    generationConfig: {
      maxOutputTokens: req.maxTokens + THINKING_HEADROOM,
      // Both prompts ask for a JSON object; this makes Gemini return JSON without code fences.
      responseMimeType: "application/json",
    },
  };
}

/** Visible text (thought parts dropped) plus token usage. An empty or blocked answer gives "" for the parser to reject. */
export function readGeminiResponse(data: GeminiResponse): LlmResponse {
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const u = data.usageMetadata ?? {};
  return {
    text: parts.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text as string).join(""),
    inputTokens: u.promptTokenCount ?? 0,
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
  };
}

export function createGeminiClient(opts: { apiKey: string; model: string; timeoutMs?: number }): LlmClient {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`;
  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
          body: JSON.stringify(buildGeminiBody(req)),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
      } catch {
        throw new ApiError(502, "llm_unavailable", "Could not reach the language model.");
      }

      if (!res.ok) {
        // Log details server-side only; never forward upstream bodies to the browser.
        const detail = await res.text().catch(() => "");
        console.error(`Gemini API error ${res.status}: ${detail.slice(0, 300)}`);
        if (res.status === 429) {
          throw new ApiError(503, "llm_busy", "The language model's usage limit was reached. Try again later.");
        }
        throw new ApiError(502, "llm_unavailable", "The language model is not available right now.");
      }

      const data = (await res.json()) as GeminiResponse;
      const out = readGeminiResponse(data);
      if (!out.text) {
        console.error(
          `Gemini returned no text (finish: ${data.candidates?.[0]?.finishReason ?? "none"}, block: ${data.promptFeedback?.blockReason ?? "none"})`,
        );
      }
      return out;
    },
  };
}
