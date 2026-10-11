export interface RateResult {
  allowed: boolean;
  retryAfterSec: number;
}

/** Fixed-window limiter keyed by device id. In-memory, resets on restart. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  check(key: string): RateResult {
    const t = this.now();
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    }
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      return { allowed: true, retryAfterSec: 0 };
    }
    if (cur.count >= this.max) {
      return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - t) / 1000)) };
    }
    cur.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }
}
