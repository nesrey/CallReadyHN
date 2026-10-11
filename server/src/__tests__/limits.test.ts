import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, TokenBudget } from "../limits.js";

test("TokenBudget keeps a reserve for feedback", () => {
  const b = new TokenBudget(1000, 300);
  b.add("s1", 650);
  assert.equal(b.canTakeTurn("s1"), true);
  b.add("s1", 100); // 750 >= 700
  assert.equal(b.canTakeTurn("s1"), false);
  assert.equal(b.canGiveFeedback("s1"), true);
  b.add("s1", 250); // 1000
  assert.equal(b.canGiveFeedback("s1"), false);
});

test("TokenBudget tracks sessions separately and expires them", () => {
  let t = 0;
  const b = new TokenBudget(1000, 100, 1000, () => t);
  b.add("a", 500);
  b.add("b", 10);
  assert.equal(b.used("a"), 500);
  assert.equal(b.used("b"), 10);
  t = 2000;
  assert.equal(b.used("a"), 0);
});

test("RateLimiter limits per key and resets after the window", () => {
  let t = 0;
  const r = new RateLimiter(2, 1000, () => t);
  assert.equal(r.check("dev1").allowed, true);
  assert.equal(r.check("dev1").allowed, true);
  const blocked = r.check("dev1");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1);
  assert.equal(r.check("dev2").allowed, true); // other device unaffected
  t = 1001;
  assert.equal(r.check("dev1").allowed, true);
});
