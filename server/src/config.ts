export interface RateConfig {
  windowMs: number;
  max: number;
}

export interface Config {
  apiKey: string;
  model: string;
  port: number;
  host: string;
  sessionTokenCap: number;
  feedbackReserve: number;
  turnRate: RateConfig;
  feedbackRate: RateConfig;
  minTurns: number;
  maxTurns: number;
  maxHistory: number;
  maxChars: number;
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, def: number, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) {
    throw new Error(`${key} must be an integer >= ${min} (got "${raw}")`);
  }
  return n;
}

export function loadConfig(env: Env): Config {
  const apiKey = (env.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is missing. Copy server/.env.example to server/.env and set it.",
    );
  }
  const minTurns = int(env, "MIN_TURNS", 6);
  const maxTurns = int(env, "MAX_TURNS", 10);
  if (minTurns > maxTurns) throw new Error("MIN_TURNS cannot be greater than MAX_TURNS");

  const cap = int(env, "SESSION_TOKEN_CAP", 20000, 1000);
  const reserve = int(env, "FEEDBACK_TOKEN_RESERVE", 4000, 0);
  if (reserve >= cap) throw new Error("FEEDBACK_TOKEN_RESERVE must be lower than SESSION_TOKEN_CAP");

  return {
    apiKey,
    model: (env.ANTHROPIC_MODEL ?? "").trim() || "claude-haiku-5-5",
    port: int(env, "PORT", 3000),
    host: (env.HOST ?? "").trim() || "127.0.0.1",
    sessionTokenCap: cap,
    feedbackReserve: reserve,
    turnRate: {
      max: int(env, "RATE_TURN_MAX", 40),
      windowMs: int(env, "RATE_TURN_WINDOW_SEC", 600) * 1000,
    },
    feedbackRate: {
      max: int(env, "RATE_FEEDBACK_MAX", 6),
      windowMs: int(env, "RATE_FEEDBACK_WINDOW_SEC", 600) * 1000,
    },
    minTurns,
    maxTurns,
    maxHistory: 24,
    maxChars: 500,
  };
}
