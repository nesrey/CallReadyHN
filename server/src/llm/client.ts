import { ApiError } from "../errors.js";
import type { LlmClient, LlmRequest, LlmResponse } from "../types.js";

interface AnthropicBlock {
  type: string;
  text?: string;
}
interface AnthropicResponse {
  content?: AnthropicBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createAnthropicClient(opts: {
  apiKey: string;
  model: string;
  timeoutMs?: number;
}): LlmClient {
  return {
    async complete(req: LlmRequest): Promise<LlmResponse> {
      let res: Response;
      try {
        res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: req.maxTokens,
            system: req.system,
            messages: req.messages,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
        });
      } catch {
        throw new ApiError(502, "llm_unavailable", "Could not reach the language model.");
      }

      if (!res.ok) {
        // Log details server-side only; never forward upstream bodies to the browser.
        const detail = await res.text().catch(() => "");
        console.error(`Anthropic API error ${res.status}: ${detail.slice(0, 300)}`);
        throw new ApiError(502, "llm_unavailable", "The language model is not available right now.");
      }

      const data = (await res.json()) as AnthropicResponse;
      const text = (data.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      return {
        text,
        inputTokens: data.usage?.input_tokens ?? 0,
        outputTokens: data.usage?.output_tokens ?? 0,
      };
    },
  };
}
