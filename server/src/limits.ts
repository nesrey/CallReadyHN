/** Per-session token accounting (input + output). In-memory, resets on restart. */
export class TokenBudget {
  private sessions = new Map<string, { used: number; touched: number }>();

  constructor(
    private cap: number,
    private feedbackReserve: number,
    private ttlMs = 60 * 60 * 1000,
    private now: () => number = Date.now,
    private maxSessions = 10_000,
  ) {}

  used(sessionId: string): number {
    this.sweep();
    return this.sessions.get(sessionId)?.used ?? 0;
  }

  /** Turns may use the cap minus the reserve, so feedback always has room. */
  canTakeTurn(sessionId: string): boolean {
    return this.used(sessionId) < this.cap - this.feedbackReserve;
  }

  canGiveFeedback(sessionId: string): boolean {
    return this.used(sessionId) < this.cap;
  }

  add(sessionId: string, tokens: number): void {
    const cur = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { used: (cur?.used ?? 0) + Math.max(0, tokens), touched: this.now() });
  }

  get limit(): number {
    return this.cap;
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) {
      if (t - s.touched > this.ttlMs) this.sessions.delete(id);
    }
    if (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].touched - b[1].touched);
      for (const [id] of oldest.slice(0, this.sessions.size - this.maxSessions)) this.sessions.delete(id);
    }
  }
}

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
