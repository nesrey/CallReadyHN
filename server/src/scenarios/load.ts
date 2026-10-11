import { readFileSync } from "node:fs";

export const DIFFICULTIES = ["A2", "B1", "B2"] as const;
export const TIERS = ["free", "pro"] as const;
export const CATEGORIES = ["support", "sales", "interview"] as const;
export const AI_ROLES = ["customer", "interviewer"] as const;

export type Difficulty = (typeof DIFFICULTIES)[number];
export type Tier = (typeof TIERS)[number];
export type Category = (typeof CATEGORIES)[number];
export type AiRole = (typeof AI_ROLES)[number];

export interface Scenario {
  id: string;
  title: { es: string; en: string };
  summaryEs: string;
  difficulty: Difficulty;
  tier: Tier;
  category: Category;
  aiRole: AiRole;
  persona: { name: string; background: string; mood: string; speechStyle: string };
  goal: string;
  hiddenFacts: string[];
  expectedFlow: string[];
  difficultyNotes: string;
}

export interface ScenarioSummary {
  id: string;
  title: { es: string; en: string };
  summaryEs: string;
  difficulty: Difficulty;
  tier: Tier;
  category: Category;
  aiRole: AiRole;
  personaName: string;
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);

function noUnknownKeys(obj: Rec, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) throw new ScenarioError(`${where}: unknown field "${k}"`);
  }
}

function str(obj: Rec, key: string, where: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ScenarioError(`${where}: "${key}" must be a non-empty string`);
  }
  return v.trim();
}

function strArray(obj: Rec, key: string, where: string, minLen: number): string[] {
  const v = obj[key];
  if (!Array.isArray(v) || v.length < minLen) {
    throw new ScenarioError(`${where}: "${key}" must be an array with at least ${minLen} item(s)`);
  }
  return v.map((x, i) => {
    if (typeof x !== "string" || x.trim() === "") {
      throw new ScenarioError(`${where}: "${key}[${i}]" must be a non-empty string`);
    }
    return x.trim();
  });
}

function oneOf<T extends string>(obj: Rec, key: string, options: readonly T[], where: string): T {
  const v = obj[key];
  if (typeof v !== "string" || !(options as readonly string[]).includes(v)) {
    throw new ScenarioError(`${where}: "${key}" must be one of ${options.join(", ")}`);
  }
  return v as T;
}

const TOP_KEYS = [
  "id", "title", "summaryEs", "difficulty", "tier", "category", "aiRole",
  "persona", "goal", "hiddenFacts", "expectedFlow", "difficultyNotes",
] as const;

export function validateScenario(raw: unknown, where = "scenario"): Scenario {
  if (!isRec(raw)) throw new ScenarioError(`${where}: must be an object`);
  const id = str(raw, "id", where);
  const w = `${where} "${id}"`;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    throw new ScenarioError(`${w}: id must be lowercase letters, numbers and hyphens`);
  }
  noUnknownKeys(raw, TOP_KEYS, w);

  const title = raw.title;
  if (!isRec(title)) throw new ScenarioError(`${w}: "title" must be an object with es and en`);
  noUnknownKeys(title, ["es", "en"], `${w}.title`);

  const persona = raw.persona;
  if (!isRec(persona)) throw new ScenarioError(`${w}: "persona" must be an object`);
  noUnknownKeys(persona, ["name", "background", "mood", "speechStyle"], `${w}.persona`);

  const difficulty = oneOf(raw, "difficulty", DIFFICULTIES, w);
  const category = oneOf(raw, "category", CATEGORIES, w);
  const defaultTier: Tier = difficulty === "B2" || category === "interview" ? "pro" : "free";
  const tier = raw.tier === undefined ? defaultTier : oneOf(raw, "tier", TIERS, w);
  const aiRole: AiRole =
    raw.aiRole === undefined
      ? category === "interview" ? "interviewer" : "customer"
      : oneOf(raw, "aiRole", AI_ROLES, w);

  return {
    id,
    title: { es: str(title, "es", `${w}.title`), en: str(title, "en", `${w}.title`) },
    summaryEs: str(raw, "summaryEs", w),
    difficulty,
    tier,
    category,
    aiRole,
    persona: {
      name: str(persona, "name", `${w}.persona`),
      background: str(persona, "background", `${w}.persona`),
      mood: str(persona, "mood", `${w}.persona`),
      speechStyle: str(persona, "speechStyle", `${w}.persona`),
    },
    goal: str(raw, "goal", w),
    hiddenFacts: strArray(raw, "hiddenFacts", w, 0),
    expectedFlow: strArray(raw, "expectedFlow", w, 3),
    difficultyNotes:
      raw.difficultyNotes === undefined ? "" : str(raw, "difficultyNotes", w),
  };
}

export function loadScenarios(raw: unknown): Scenario[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ScenarioError("scenarios.json must be a non-empty array");
  }
  const seen = new Set<string>();
  return raw.map((item, i) => {
    const s = validateScenario(item, `scenarios[${i}]`);
    if (seen.has(s.id)) throw new ScenarioError(`duplicate scenario id "${s.id}"`);
    seen.add(s.id);
    return s;
  });
}

export function loadScenariosFromDisk(
  file: URL = new URL("../../data/scenarios.json", import.meta.url),
): Scenario[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ScenarioError(`Could not read scenarios file: ${(e as Error).message}`);
  }
  return loadScenarios(parsed);
}

export function toSummary(s: Scenario): ScenarioSummary {
  return {
    id: s.id,
    title: s.title,
    summaryEs: s.summaryEs,
    difficulty: s.difficulty,
    tier: s.tier,
    category: s.category,
    aiRole: s.aiRole,
    personaName: s.persona.name,
  };
}
