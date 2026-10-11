import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeedbackOutput, type FeedbackOutput } from "../llm/parse.js";
import { buildFeedbackSystem } from "../llm/prompts.js";
import { polishSpanish, spanishFields, spanishSpellingIssues, withSpanishFields } from "../llm/spanish.js";
import { loadScenariosFromDisk } from "../scenarios/load.js";
import { MockLlm, goodFeedback } from "./helpers.js";

const withSpanish = (es: string): FeedbackOutput => {
  const f = parseFeedbackOutput(goodFeedback);
  f.corrections[0]!.explanationEs = es;
  return f;
};

test("spelling: clean Spanish passes", () => {
  assert.deepEqual(spanishSpellingIssues(withSpanish("Después de la preposición «for», el verbo lleva -ing. ¿Lo ve? ¡Muy bien!")), []);
  assert.deepEqual(spanishSpellingIssues(withSpanish("Las preposiciones y las expresiones comunes ayudan más.")), []);
});

test("spelling: catches unaccented words seen from Gemini", () => {
  const issues = spanishSpellingIssues(
    withSpanish("Despues de la preposicion for, los verbos deben llevar terminacion -ing. Dejeme verificar. Buen animo y empatia."),
  );
  for (const w of ["Despues", "preposicion", "terminacion", "Dejeme", "animo", "empatia"]) {
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

test("register: tú and vos forms seen from Gemini are flagged, usted is not", () => {
  const issues = spanishSpellingIssues(
    withSpanish("Úsalo al inicio. Usalo bien. Debes usar el presente. Dijiste bien. Usá tu micrófono si podés. Lo que ves."),
  );
  for (const w of ["Úsalo", "Usalo", "Debes", "Dijiste", "Usá", "tu", "podés", "ves"]) {
    assert.ok(issues.some((i) => i.startsWith(`"${w}" addresses`)), `expected ${w} in ${issues.join(" | ")}`);
  }
  assert.deepEqual(
    spanishSpellingIssues(withSpanish("Úselo al inicio. Debe usar el presente. Usted dijo bien. Se recomienda practicar.")),
    [],
  );
});

test("spanishFields / withSpanishFields round-trip and leave scores and English alone", () => {
  const f = parseFeedbackOutput(goodFeedback);
  const texts = spanishFields(f);
  assert.equal(texts.length, 10);
  const g = withSpanishFields(f, texts.map((t, i) => `${i}:${t}`));
  assert.deepEqual(g.scores, f.scores);
  assert.deepEqual(g.corrections.map((c) => c.said), f.corrections.map((c) => c.said));
  assert.deepEqual(g.phrases.map((p) => p.phrase), f.phrases.map((p) => p.phrase));
  assert.equal(g.corrections[0]!.explanationEs, `0:${f.corrections[0]!.explanationEs}`);
  assert.equal(g.phrases[0]!.whenToUseEs, `4:${f.phrases[0]!.whenToUseEs}`);
  assert.equal(g.overallSummaryEs, `9:${f.overallSummaryEs}`);
});

const draft = withSpanish("Despues de for, debes usar -ing.");
const proofread = (first: string) => JSON.stringify({ texts: [first, ...spanishFields(draft).slice(1)] });

test("polish: clean feedback makes no extra call", async () => {
  const llm = new MockLlm([]);
  const f = parseFeedbackOutput(goodFeedback);
  assert.equal(await polishSpanish(llm, f, () => {}), f);
  assert.equal(llm.calls.length, 0);
});

test("polish: sends only the Spanish texts, in Spanish, and applies the fix", async () => {
  const llm = new MockLlm([proofread("Después de «for», debe usar -ing.")]);
  const used: number[] = [];
  const out = await polishSpanish(llm, draft, (n) => used.push(n));
  assert.equal(out.corrections[0]!.explanationEs, "Después de «for», debe usar -ing.");
  assert.deepEqual(out.scores, draft.scores);
  assert.deepEqual(used, [150]);
  const call = llm.calls[0]!;
  assert.match(call.system, /Nunca tú ni vos/);
  assert.match(call.messages[0]!.content, /"Despues" needs its accent/);
  assert.ok(!call.messages[0]!.content.includes(draft.corrections[0]!.better), "English corrections are not sent");
});

test("polish: keeps the original when the proofread is not better", async () => {
  const llm = new MockLlm([proofread("Despues de for, debes usar -ing, tu sabes.")]);
  assert.equal(await polishSpanish(llm, draft, () => {}), draft);
});

test("polish: keeps the original on bad JSON, wrong count, or an upstream error", async () => {
  for (const reply of ["not json", JSON.stringify({ texts: ["solo uno"] }), new Error("llm_busy")]) {
    const llm = new MockLlm([reply]);
    assert.equal(await polishSpanish(llm, draft, () => {}), draft);
  }
});

test("polish: a line that changed length wildly keeps its original text", async () => {
  const llm = new MockLlm([proofread("Sí.")]);
  const out = await polishSpanish(llm, draft, () => {});
  assert.equal(out.corrections[0]!.explanationEs, draft.corrections[0]!.explanationEs);
});

test("feedback prompt asks for accents, opening marks and usted", () => {
  const sys = buildFeedbackSystem(loadScenariosFromDisk()[0]!);
  assert.match(sys, /accent/);
  assert.match(sys, /¿ and ¡/);
  assert.match(sys, /"usted"/);
  assert.match(sys, /Never use "tú" forms/);
});
