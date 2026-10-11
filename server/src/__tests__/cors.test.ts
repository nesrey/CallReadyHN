import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import { loadConfig } from "../config.js";
import { TokenBudget } from "../limits.js";
import { loadScenariosFromDisk } from "../scenarios/load.js";
import { MockLlm } from "./helpers.js";

const PAGES = "https://nesrey.github.io";
const config = loadConfig({ ANTHROPIC_API_KEY: "test", ALLOWED_ORIGINS: PAGES });
const app = createApp(
  {
    config,
    scenarios: new Map(loadScenariosFromDisk().map((s) => [s.id, s])),
    llm: new MockLlm([]),
    budget: new TokenBudget(config.sessionTokenCap, config.feedbackReserve),
  },
  { webDir: "." },
);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

test("cors: allowed origin can read /scenarios", async () => {
  const r = await fetch(`${base}/scenarios`, { headers: { Origin: PAGES } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), PAGES);
  assert.match(r.headers.get("vary") ?? "", /Origin/);
});

test("cors: preflight for /session/turn allows the device header", async () => {
  const r = await fetch(`${base}/session/turn`, {
    method: "OPTIONS",
    headers: {
      Origin: PAGES,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-device-id",
    },
  });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), PAGES);
  assert.match(r.headers.get("access-control-allow-headers") ?? "", /X-Device-Id/);
});

test("cors: other origins get no CORS headers", async () => {
  const r = await fetch(`${base}/scenarios`, { headers: { Origin: "https://evil.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
  const pre = await fetch(`${base}/session/turn`, {
    method: "OPTIONS",
    headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" },
  });
  assert.equal(pre.headers.get("access-control-allow-origin"), null);
});

test("cors: error responses still carry the header so the page can read the code", async () => {
  const r = await fetch(`${base}/session/turn`, {
    method: "POST",
    headers: { Origin: PAGES, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("access-control-allow-origin"), PAGES);
});

test("config: ALLOWED_ORIGINS parsing", () => {
  assert.deepEqual(loadConfig({ ANTHROPIC_API_KEY: "k" }).allowedOrigins, []);
  assert.deepEqual(
    loadConfig({ ANTHROPIC_API_KEY: "k", ALLOWED_ORIGINS: " https://a.github.io/ , http://localhost:8080" }).allowedOrigins,
    ["https://a.github.io", "http://localhost:8080"],
  );
  assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", ALLOWED_ORIGINS: "nesrey.github.io" }), /ALLOWED_ORIGINS/);
  assert.throws(
    () => loadConfig({ ANTHROPIC_API_KEY: "k", ALLOWED_ORIGINS: "https://nesrey.github.io/CallReadyHN" }),
    /ALLOWED_ORIGINS/,
  );
});
