export interface RateConfig {
  windowMs: number;
  max: number;
}

export const PROVIDERS = ["anthropic", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface Config {
  provider: Provider;
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
  /** Other sites allowed to call the API from a browser (CORS), e.g. the GitHub Pages site. */
  allowedOrigins: string[];
  /** Lower-cased emails that may open the admin page. */
  adminEmails: string[];
  /** IANA time zone that decides where "today" starts for the free daily limit and usage charts. */
  timeZone: string;
}

/** Accounts and database. Separate from Config so the AI/server settings can be tested on their own. */
export interface AccountConfig {
  supabaseUrl: string;
  /** Public key the page uses to sign people in (sb_publishable_... or the legacy anon key). */
  supabaseKey: string;
  /** Only for older projects that still sign tokens with a shared secret (HS256). */
  supabaseJwtSecret: string;
  databaseUrl: string;
  /** PEM text of Supabase's root certificate; when set, the database certificate is verified. */
  databaseSslCa: string;
}

type Env = Record<string, string | undefined>;

/** Comma-separated list of origins like "https://nesrey.github.io". No paths, no trailing slash. */
function origins(env: Env): string[] {
  const raw = (env.ALLOWED_ORIGINS ?? "").trim();
  if (!raw) return [];
  return raw.split(",").map((o) => o.trim()).filter(Boolean).map((o) => {
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new Error(`ALLOWED_ORIGINS has an invalid entry "${o}"`);
    }
    if ((u.protocol !== "https:" && u.protocol !== "http:") || u.origin !== o.replace(/\/$/, "")) {
      throw new Error(`ALLOWED_ORIGINS entries must look like https://example.com (got "${o}")`);
    }
    return u.origin;
  });
}

function timeZone(env: Env): string {
  const tz = (env.TIMEZONE ?? "").trim() || "America/Tegucigalpa";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`TIMEZONE must be an IANA time zone like America/Tegucigalpa (got "${tz}")`);
  }
  return tz;
}

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
  const keys: Record<Provider, string> = {
    anthropic: (env.ANTHROPIC_API_KEY ?? "").trim(),
    gemini: (env.GEMINI_API_KEY ?? "").trim(),
  };
  // LLM_PROVIDER picks explicitly; otherwise use whichever key is set (Anthropic first).
  const wanted = (env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (wanted && !(PROVIDERS as readonly string[]).includes(wanted)) {
    throw new Error(`LLM_PROVIDER must be one of ${PROVIDERS.join(", ")} (got "${wanted}")`);
  }
  const provider: Provider = (wanted as Provider) || (keys.anthropic ? "anthropic" : keys.gemini ? "gemini" : "anthropic");
  const apiKey = keys[provider];
  if (!apiKey) {
    const keyName = provider === "gemini" ? "GEMINI_API_KEY" : "ANTHROPIC_API_KEY";
    throw new Error(
      wanted
        ? `${keyName} is missing (LLM_PROVIDER=${provider}). Set it in server/.env.`
        : "No API key found. Set ANTHROPIC_API_KEY or GEMINI_API_KEY (copy server/.env.example to server/.env).",
    );
  }
  const model =
    provider === "gemini"
      ? (env.GEMINI_MODEL ?? "").trim() || "gemini-3.5-flash-lite"
      : (env.ANTHROPIC_MODEL ?? "").trim() || "claude-haiku-5-5";
  const minTurns = int(env, "MIN_TURNS", 6);
  const maxTurns = int(env, "MAX_TURNS", 10);
  if (minTurns > maxTurns) throw new Error("MIN_TURNS cannot be greater than MAX_TURNS");

  const cap = int(env, "SESSION_TOKEN_CAP", 20000, 1000);
  const reserve = int(env, "FEEDBACK_TOKEN_RESERVE", 4000, 0);
  if (reserve >= cap) throw new Error("FEEDBACK_TOKEN_RESERVE must be lower than SESSION_TOKEN_CAP");

  return {
    provider,
    apiKey,
    model,
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
    allowedOrigins: origins(env),
    adminEmails: (env.ADMIN_EMAILS ?? "nesrey@gmail.com")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    timeZone: timeZone(env),
  };
}

export function loadAccountConfig(env: Env): AccountConfig {
  const need = (key: string) => {
    const v = (env[key] ?? "").trim();
    if (!v) throw new Error(`${key} is missing. See "Accounts (Supabase)" in the README.`);
    return v;
  };
  const supabaseUrl = need("SUPABASE_URL").replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)) {
    throw new Error(`SUPABASE_URL must look like https://<project>.supabase.co (got "${supabaseUrl}")`);
  }
  const supabaseKey = (env.SUPABASE_PUBLISHABLE_KEY ?? "").trim() || (env.SUPABASE_ANON_KEY ?? "").trim();
  if (!supabaseKey) throw new Error("SUPABASE_PUBLISHABLE_KEY is missing. See \"Accounts (Supabase)\" in the README.");
  return {
    supabaseUrl,
    supabaseKey,
    supabaseJwtSecret: (env.SUPABASE_JWT_SECRET ?? "").trim(),
    databaseUrl: need("DATABASE_URL"),
    databaseSslCa: (env.DATABASE_SSL_CA ?? "").trim(),
  };
}
