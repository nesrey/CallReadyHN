import type { Store } from "./db/store.js";

/** An unscored call can't be continued after this; its partial transcript is then deleted. */
export const CALL_TTL_HOURS = 24;
export const CALL_TTL_MS = CALL_TTL_HOURS * 3600_000;

/**
 * Deletes the partial transcripts of calls that were never scored, once they are older than CALL_TTL_HOURS.
 * The free Render plan has no scheduler and sleeps when idle, so this runs at startup and then at most once an hour
 * while requests come in. It never throws: a failed cleanup is logged and retried on a later run.
 */
export class TranscriptJanitor {
  private last = Number.NEGATIVE_INFINITY;
  private running: Promise<number> | null = null;

  constructor(
    private store: Store,
    private now: () => number = Date.now,
    private everyMs = 3600_000,
  ) {}

  /** Start a cleanup if one is due. Returns its promise (for tests), or null when it is not due yet. */
  tick(): Promise<number> | null {
    const t = this.now();
    if (this.running || t - this.last < this.everyMs) return null;
    this.last = t;
    this.running = this.store
      .purgeAbandonedTurns(new Date(t - CALL_TTL_MS))
      .then((n) => {
        if (n > 0) console.log(`Cleanup: deleted the partial transcripts of ${n} unscored call(s) older than ${CALL_TTL_HOURS} h.`);
        return n;
      })
      .catch((e: unknown) => {
        console.error("Cleanup of unscored calls failed:", (e as Error).message);
        this.last = t - this.everyMs + 5 * 60_000; // try again in about 5 minutes
        return 0;
      })
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}
