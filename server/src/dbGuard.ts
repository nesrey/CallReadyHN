/**
 * Supabase project refs of the live site. Startup runs schema changes, so a local run pointed at the live database
 * would change production. The server refuses to start against these unless it is running on Render.
 */
export const PRODUCTION_DB_REFS = ["idjtedvobmjpfhxzjife"] as const;

type Env = Record<string, string | undefined>;

/** The production project ref DATABASE_URL points at, or null. Matches every connection form (direct, pooler user). */
export function productionRefIn(databaseUrl: string): string | null {
  let text = databaseUrl.toLowerCase();
  try {
    text = decodeURIComponent(text);
  } catch {
    /* keep the raw text */
  }
  return PRODUCTION_DB_REFS.find((ref) => text.includes(ref)) ?? null;
}

/** Throws before anything connects when a non-Render process is pointed at the production database. */
export function assertSafeDatabase(databaseUrl: string, env: Env): void {
  const ref = productionRefIn(databaseUrl);
  if (ref && env.RENDER !== "true") {
    throw new Error(
      `DATABASE_URL points at the production database (${ref}). Local runs and tests must use a separate database; ` +
        "only the Render service may connect to production.",
    );
  }
}
