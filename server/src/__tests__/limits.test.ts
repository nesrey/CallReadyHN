import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../limits.js";

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
