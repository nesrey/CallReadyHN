import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../config.js";
import { buildGeminiBody, readGeminiResponse } from "../llm/gemini.js";

test("provider: picked from whichever key is set, Anthropic first", () => {
  const g = loadConfig({ GEMINI_API_KEY: "g" });
  assert.equal(g.provider, "gemini");
  assert.equal(g.apiKey, "g");
  assert.equal(g.model, "gemini-3.5-flash-lite");
  assert.equal(loadConfig({ GEMINI_API_KEY: "g", GEMINI_MODEL: "gemini-3.8-flash" }).model, "gemini-3.8-flash");
  const both = loadConfig({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" });
  assert.equal(both.provider, "anthropic");
  assert.equal(both.apiKey, "a");
});

test("provider: LLM_PROVIDER overrides, and needs its own key", () => {
  const c = loadConfig({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", LLM_PROVIDER: "Gemini" });
  assert.equal(c.provider, "gemini");
  assert.equal(c.apiKey, "g");
  assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "a", LLM_PROVIDER: "gemini" }), /GEMINI_API_KEY is missing/);
  assert.throws(() => loadConfig({ GEMINI_API_KEY: "g", LLM_PROVIDER: "openai" }), /LLM_PROVIDER must be one of/);
});

test("gemini body: system instruction, model role, JSON output, thinking headroom", () => {
  const body = buildGeminiBody({
    system: "SYS",
    maxTokens: 300,
    messages: [
      { role: "user", content: "[The call connects.]" },
      { role: "assistant", content: '{"line":"Hi","end":false}' },
      { role: "user", content: "Hello" },
    ],
  });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "SYS" }] });
  assert.deepEqual(body.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(body.contents[2]!.parts[0]!.text, "Hello");
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.ok(body.generationConfig.maxOutputTokens > 300);
});

test("gemini response: drops thought parts, counts thinking as output tokens", () => {
  const out = readGeminiResponse({
    candidates: [{ content: { parts: [{ text: "secret reasoning", thought: true }, { text: '{"line":' }, { text: '"Hi"}' }] } }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 15 },
  });
  assert.equal(out.text, '{"line":"Hi"}');
  assert.equal(out.inputTokens, 120);
  assert.equal(out.outputTokens, 45);
});

test("gemini response: blocked or empty answer gives empty text", () => {
  assert.equal(readGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }).text, "");
  assert.equal(readGeminiResponse({ candidates: [{ finishReason: "MAX_TOKENS" }] }).text, "");
});
