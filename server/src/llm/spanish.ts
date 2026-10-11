import { extractJson, ParseError, type FeedbackOutput } from "./parse.js";
import type { LlmClient } from "../types.js";

/** Unaccented spellings that are never correct Spanish (the accented form is the only word). */
const UNACCENTED = [
  "despues", "tambien", "ademas", "aqui", "alli", "asi", "todavia", "dia", "dias", "facil", "dificil",
  "util", "utiles", "rapido", "rapida", "rapidamente", "numero", "telefono", "pagina", "ingles", "espanol",
  "gramatica", "ultimo", "ultima", "senor", "senora", "manana", "pequeno", "pequena", "dejeme", "permitame",
  "digame", "disculpeme", "practicamente", "basico", "basica", "basicos", "basicas", "logico", "tecnico",
  "tecnica", "publico", "animo", "empatia", "proximo", "proxima", "unico", "unica", "area", "energia",
  "categoria", "analisis", "simbolo", "periodo", "credito", "debito", "envio", "envios", "garantia",
];
const LETTER = "\\p{L}";
const WORD_RE = new RegExp(`(?<!${LETTER})(${UNACCENTED.join("|")})(?!${LETTER})`, "giu");
/**
 * Singular -ción words always carry the accent (preposición); plurals do not. -sión is left out on purpose:
 * explanations often quote English words like "expression" or "decision".
 */
const CION_RE = new RegExp(`(?<!${LETTER})${LETTER}+cion(?!${LETTER})`, "giu");

/** Words that address the learner as "tú" or "vos". The app speaks neutral Spanish ("usted" or impersonal). */
const TU_VOS = [
  "tú", "tu", "tus", "te", "ti", "contigo", "vos",
  "debes", "tienes", "puedes", "quieres", "necesitas", "sabes", "eres", "estás", "haces", "dices", "usas",
  "hablas", "practicas", "intentas", "recuerdas", "puedas", "debas", "tengas", "uses", "hables", "practiques",
  "ves", "necesites", "combines", "olvides", "confundas", "asegúrate", "asegurarte",
  "hiciste", "dijiste", "usaste", "completaste", "mostraste", "lograste", "hablaste", "cometiste", "resolviste",
  "respondiste", "tuviste", "pudiste", "manejaste", "ofreciste", "seguiste", "empezaste", "terminaste", "cubriste",
  "úsalo", "úsala", "fíjate", "recuérdalo", "practícalo", "inténtalo", "repítelo", "escúchalo",
  "usá", "usalo", "usala", "fijate", "tenés", "podés", "decí", "recordá", "practicá", "intentá", "escuchá",
  "hacé", "sos", "debés", "querés", "necesitás", "sabés", "hablás", "usás",
];
const TU_VOS_RE = new RegExp(`(?<!${LETTER})(${TU_VOS.join("|")})(?!${LETTER})`, "giu");

function textIssues(t: string, issues: Set<string>): void {
  for (const m of t.matchAll(WORD_RE)) issues.add(`"${m[0]}" needs its accent`);
  for (const m of t.matchAll(CION_RE)) issues.add(`"${m[0]}" needs its accent`);
  for (const m of t.matchAll(TU_VOS_RE)) issues.add(`"${m[0]}" addresses the learner as tú/vos; use usted or an impersonal form`);
  if (t.includes("?") && !t.includes("¿")) issues.add("a question is missing the opening ¿");
  if (t.includes("!") && !t.includes("¡")) issues.add("an exclamation is missing the opening ¡");
}

/** The feedback's Spanish texts, in a fixed order (see withSpanishFields). */
export function spanishFields(f: FeedbackOutput): string[] {
  return [
    ...f.corrections.map((c) => c.explanationEs),
    ...f.phrases.flatMap((p) => [p.meaningEs, p.whenToUseEs]),
    f.overallSummaryEs,
  ];
}

/** Put Spanish texts back in the order spanishFields produced. Scores and English stay untouched. */
export function withSpanishFields(f: FeedbackOutput, texts: string[]): FeedbackOutput {
  let i = 0;
  const next = () => texts[i++]!;
  return {
    scores: f.scores,
    corrections: f.corrections.map((c) => ({ ...c, explanationEs: next() })),
    phrases: f.phrases.map((p) => ({ ...p, meaningEs: next(), whenToUseEs: next() })),
    overallSummaryEs: next(),
  };
}

/** Problems in the Spanish fields: unaccented words, missing opening ¿ / ¡, and tú/vos forms. Empty when clean. */
export function spanishSpellingIssues(f: FeedbackOutput): string[] {
  const issues = new Set<string>();
  for (const t of spanishFields(f)) if (t) textIssues(t, issues);
  return [...issues];
}

export const PROOFREAD_SYSTEM = `Usted es corrector de estilo de español neutro y profesional para una aplicación que enseña inglés a personas de Honduras.
Recibirá un objeto JSON con una lista de textos en español. Corrija cada texto:
- Ortografía completa: todas las tildes (á, é, í, ó, ú, ü), la ñ y los signos de apertura ¿ y ¡. Ejemplos: después, preposición, también, día, más, ánimo, empatía, ¿Hay algo más en lo que pueda ayudarle?
- Trato de usted o forma impersonal. Nunca tú ni vos. Ejemplos: "usa" → "use", "úsalo" o "usalo" → "úselo", "debes" → "debe", "dijiste" → "dijo", "tu respuesta" → "su respuesta", "te ayuda" → "le ayuda".
- Gramática y puntuación correctas.
No cambie el significado. No traduzca ni modifique las palabras o frases en inglés que aparecen dentro de los textos.
Devuelva SOLO un objeto JSON con la forma {"texts": [...]}, con la misma cantidad de textos y en el mismo orden.`;

export function buildProofreadUser(texts: string[], issues: string[]): string {
  return `Problemas detectados (pueden existir otros): ${issues.join("; ")}\n\n${JSON.stringify({ texts })}`;
}

export function parseProofread(text: string, expected: number): string[] {
  const raw = extractJson(text) as { texts?: unknown };
  const t = raw?.texts;
  if (!Array.isArray(t) || t.length !== expected) throw new ParseError(`texts must be an array of ${expected}`);
  return t.map((x, i) => {
    if (typeof x !== "string" || !x.trim()) throw new ParseError(`texts[${i}] must be a non-empty string`);
    return x.trim();
  });
}

/**
 * If the feedback's Spanish has problems, ask the model to proofread just those texts and keep whichever
 * version has fewer problems. Never throws: on any failure the original feedback is returned.
 */
export async function polishSpanish(
  llm: LlmClient,
  f: FeedbackOutput,
  onUsage: (tokens: number) => void,
): Promise<FeedbackOutput> {
  const before = spanishSpellingIssues(f);
  if (before.length === 0) return f;
  const texts = spanishFields(f);
  try {
    const res = await llm.complete({
      system: PROOFREAD_SYSTEM,
      messages: [{ role: "user", content: buildProofreadUser(texts, before) }],
      maxTokens: 1200,
    });
    onUsage(res.inputTokens + res.outputTokens);
    const fixed = parseProofread(res.text, texts.length);
    // A proofread line that shrank or grew a lot probably lost or invented content; keep the original line.
    const merged = fixed.map((t, i) => {
      const ratio = t.length / Math.max(1, texts[i]!.length);
      return ratio >= 0.6 && ratio <= 1.7 ? t : texts[i]!;
    });
    const candidate = withSpanishFields(f, merged);
    const after = spanishSpellingIssues(candidate);
    console.log(`Spanish proofread: ${before.length} issue(s) -> ${after.length}`);
    return after.length < before.length ? candidate : f;
  } catch (err) {
    console.error(`Spanish proofread skipped: ${(err as Error).message}`);
    return f;
  }
}
