import { test } from "node:test";
import assert from "node:assert/strict";
import { callWithRetry, parseFeedbackOutput, spanishSpellingIssues, type FeedbackOutput } from "../llm/parse.js";
import { buildFeedbackSystem } from "../llm/prompts.js";
import { loadScenariosFromDisk } from "../scenarios/load.js";
import { MockLlm, goodFeedback } from "./helpers.js";

const withSpanish = (es: string): FeedbackOutput => {
  const f = parseFeedbackOutput(goodFeedback);
  f.corrections[0]!.explanationEs = es;
  return f;
};
const bad = (es: string) => JSON.stringify({ ...JSON.parse(goodFeedback), overallSummaryEs: es });

test("spelling: clean Spanish passes", () => {
  assert.deepEqual(spanishSpellingIssues(withSpanish("Después de la preposición «for», el verbo lleva -ing. ¿Lo ve? ¡Muy bien!")), []);
  assert.deepEqual(spanishSpellingIssues(withSpanish("Las preposiciones y las expresiones comunes ayudan más.")), []);
});

test("spelling: catches unaccented words seen from Gemini", () => {
  const issues = spanishSpellingIssues(
    withSpanish("Despues de la preposicion for, los verbos deben llevar terminacion -ing. Dejeme verificar."),
  );
  for (const w of ["Despues", "preposicion", "terminacion", "Dejeme"]) {
    assert.ok(issues.some((i) => i.includes(`"${w}"`)), `expected ${w} in ${issues.join(" | ")}`);
  }
});

test("spelling: catches missing opening ¿ and ¡ but not English text", () => {
  assert.ok(spanishSpellingIssues(withSpanish("Hay algo más en lo que pueda ayudarle hoy?")).some((i) => i.includes("¿")));
  assert.ok(spanishSpellingIssues(withSpanish("Muy buen trabajo!")).some((i) => i.includes("¡")));
  const f = withSpanish("Bien.");
  f.corrections[0]!.better = "Is there anything else? Great!"; // English fields are not checked
  assert.deepEqual(spanishSpellingIssues(f), []);
});

test("spelling: accented and ñ words are not flagged, and words only match whole", () => {
  assert.deepEqual(spanishSpellingIssues(withSpanish("Español, inglés, día, mañana, diámetro, asistente, utilidad.")), []);
  assert.deepEqual(spanishSpellingIssues(withSpanish('Use "expression" o "decision" en lugar de "session".')), []);
});

const fbOpts = (llm: MockLlm, used: number[] = []) => ({
  llm,
  system: "sys",
  messages: [{ role: "user" as const, content: "transcript" }],
  maxTokens: 100,
  parse: parseFeedbackOutput,
  onUsage: (n: number) => used.push(n),
  check: spanishSpellingIssues,
});

test("callWithRetry: spelling problems trigger one rewrite with the issues listed", async () => {
  const llm = new MockLlm([bad("Buen trabajo. Despues practica mas."), goodFeedback]);
  const used: number[] = [];
  const out = await callWithRetry(fbOpts(llm, used));
  assert.equal(out.overallSummaryEs, "Buen trabajo.");
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(used, [150, 150]);
  const ask = llm.calls[1]!.messages.at(-1)!.content;
  assert.match(ask, /"Despues" needs its accent/);
});

test("callWithRetry: clean feedback needs no rewrite", async () => {
  const llm = new MockLlm([goodFeedback]);
  await callWithRetry(fbOpts(llm));
  assert.equal(llm.calls.length, 1);
});

test("callWithRetry: if the rewrite is broken, the first valid feedback is kept", async () => {
  const llm = new MockLlm([bad("Despues."), "not json"]);
  const out = await callWithRetry(fbOpts(llm));
  assert.equal(out.overallSummaryEs, "Despues.");
  assert.equal(llm.calls.length, 2);
});

test("callWithRetry: if the rewrite still has issues it is used anyway (no third call)", async () => {
  const llm = new MockLlm([bad("Despues."), bad("Tambien.")]);
  const out = await callWithRetry(fbOpts(llm));
  assert.equal(out.overallSummaryEs, "Tambien.");
  assert.equal(llm.calls.length, 2);
});

test("feedback prompt asks for accents, opening marks and usted", () => {
  const sys = buildFeedbackSystem(loadScenariosFromDisk()[0]!);
  assert.match(sys, /accent/);
  assert.match(sys, /¿ and ¡/);
  assert.match(sys, /"usted"/);
  assert.match(sys, /Never use "tú" forms/);
});

test("register: tú and vos forms seen from Gemini are flagged, usted is not", () => {
  const issues = spanishSpellingIssues(
    withSpanish("Úsalo al inicio. Debes usar el presente. Dijiste bien. Usá tu micrófono si podés."),
  );
  for (const w of ["Úsalo", "Debes", "Dijiste", "Usá", "tu", "podés"]) {
    assert.ok(issues.some((i) => i.startsWith(`"${w}" addresses`)), `expected ${w} in ${issues.join(" | ")}`);
  }
  assert.deepEqual(
    spanishSpellingIssues(withSpanish("Úselo al inicio. Debe usar el presente. Usted dijo bien. Se recomienda practicar.")),
    [],
  );
});
