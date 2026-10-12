import { readFileSync } from "node:fs";

export const CALL_TYPES = ["service", "tech", "sales", "collections", "interview"] as const;
export const TEMPERAMENTS = ["calm", "demanding", "furious"] as const;
export const TIERS = ["free", "pro"] as const;

export type CallType = (typeof CALL_TYPES)[number];
export type Temperament = (typeof TEMPERAMENTS)[number];
export type Tier = (typeof TIERS)[number];
export type AiRole = "customer" | "interviewer";

/** One line of the agent's desk panel, e.g. { label: "Plan", value: "Fiber 300, $65/month" }. */
export interface DeskField {
  label: string;
  value: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** Shown to the learner on the scenario card. */
  summary: string;
  callType: CallType;
  temperament: Temperament;
  tier: Tier;
  /** The (fictional) company the agent works for. */
  company: string;
  persona: { name: string; background: string; speechStyle: string };
  /** What the caller wants from this call. */
  goal: string;
  /** Agent-visible: the customer account (or, for interviews, the job posting). */
  account: DeskField[];
  /** Agent-visible: the rules the agent must follow. The grader checks resolutions against them. */
  policies: string[];
  /** Caller-only: revealed when the agent asks. */
  hiddenFacts: string[];
  /** Extra direction for how the caller behaves. */
  behaviorNotes: string;
}

/** What the page receives: everything the agent may see, never the caller-only facts. */
export interface ScenarioSummary {
  id: string;
  title: string;
  summary: string;
  callType: CallType;
  temperament: Temperament;
  tier: Tier;
  aiRole: AiRole;
  company: string;
  personaName: string;
  account: DeskField[];
  policies: string[];
}

export const aiRoleOf = (s: Pick<Scenario, "callType">): AiRole => (s.callType === "interview" ? "interviewer" : "customer");

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
    throw new ScenarioError(`${where}: "${key}" must be a list with at least ${minLen} item(s)`);
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
  "id", "title", "summary", "callType", "temperament", "tier", "company", "persona", "goal",
  "account", "policies", "hiddenFacts", "behaviorNotes",
] as const;

export function validateScenario(raw: unknown, where = "scenario"): Scenario {
  if (!isRec(raw)) throw new ScenarioError(`${where}: must be an object`);
  const id = str(raw, "id", where);
  const w = `${where} "${id}"`;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    throw new ScenarioError(`${w}: id must be lowercase letters, numbers and hyphens`);
  }
  noUnknownKeys(raw, TOP_KEYS, w);

  const persona = raw.persona;
  if (!isRec(persona)) throw new ScenarioError(`${w}: "persona" must be an object`);
  noUnknownKeys(persona, ["name", "background", "speechStyle"], `${w}.persona`);

  if (!Array.isArray(raw.account) || raw.account.length < 2) {
    throw new ScenarioError(`${w}: "account" must be a list with at least 2 fields`);
  }
  const account = raw.account.map((f: unknown, i: number): DeskField => {
    if (!isRec(f)) throw new ScenarioError(`${w}: "account[${i}]" must be { label, value }`);
    noUnknownKeys(f, ["label", "value"], `${w}.account[${i}]`);
    return { label: str(f, "label", `${w}.account[${i}]`), value: str(f, "value", `${w}.account[${i}]`) };
  });

  const callType = oneOf(raw, "callType", CALL_TYPES, w);
  const temperament = oneOf(raw, "temperament", TEMPERAMENTS, w);
  const defaultTier: Tier = temperament === "calm" && callType !== "interview" ? "free" : "pro";

  return {
    id,
    title: str(raw, "title", w),
    summary: str(raw, "summary", w),
    callType,
    temperament,
    tier: raw.tier === undefined ? defaultTier : oneOf(raw, "tier", TIERS, w),
    company: str(raw, "company", w),
    persona: {
      name: str(persona, "name", `${w}.persona`),
      background: str(persona, "background", `${w}.persona`),
      speechStyle: str(persona, "speechStyle", `${w}.persona`),
    },
    goal: str(raw, "goal", w),
    account,
    policies: strArray(raw, "policies", w, 1),
    hiddenFacts: strArray(raw, "hiddenFacts", w, 0),
    behaviorNotes: raw.behaviorNotes === undefined ? "" : str(raw, "behaviorNotes", w),
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
    summary: s.summary,
    callType: s.callType,
    temperament: s.temperament,
    tier: s.tier,
    aiRole: aiRoleOf(s),
    company: s.company,
    personaName: s.persona.name,
    account: s.account,
    policies: s.policies,
  };
}
