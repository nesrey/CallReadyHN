import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp } from "../app.js";
import { userFromClaims, type Auth, type AuthUser } from "../auth.js";
import { loadConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { ScenarioCatalog } from "../scenarios/catalog.js";
import { MockLlm, exchanges, freshStore, goodFeedback } from "./helpers.js";

const PAGES = "https://callreadyhn.com";
const config = loadConfig({ ANTHROPIC_API_KEY: "test", ALLOWED_ORIGINS: PAGES, ADMIN_EMAILS: "Boss@Example.com" });
const USERS: Record<string, AuthUser> = {
  "ana-token": { userId: "11111111-1111-4111-8111-111111111111", email: "ana@example.com" },
  "boss-token": { userId: "99999999-9999-4999-8999-999999999999", email: "boss@example.com" },
};
const fakeAuth: Auth = {
  async verify(token) {
    const u = USERS[token];
    if (!u) throw new ApiError(401, "unauthorized", "Sign in again.");
    return u;
  },
};

const store = await freshStore();
const catalog = new ScenarioCatalog(store);
await catalog.refresh();
const llm = new MockLlm([]);
const app = createApp(
  {
    config, catalog, store, llm, auth: fakeAuth,
    publicConfig: { supabaseUrl: "https://abc.supabase.co", supabaseKey: "sb_publishable_x" },
  },
  { webDir: "." },
);
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

async function call(method: string, path: string, opts: { token?: string; body?: unknown; origin?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.origin) headers.Origin = opts.origin;
  const r = await fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, data: text ? JSON.parse(text) : null };
}

test("cors: the site can read the API and send the sign-in header; other origins cannot", async () => {
  const r = await call("GET", "/scenarios", { origin: PAGES });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), PAGES);

  const pre = await fetch(`${base}/me`, {
    method: "OPTIONS",
    headers: { Origin: PAGES, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "authorization,content-type" },
  });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /Authorization/);
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /PUT/);

  const evil = await call("GET", "/scenarios", { origin: "https://evil.example" });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
});

test("public: /config and /scenarios need no sign-in", async () => {
  assert.deepEqual((await call("GET", "/config")).data, { supabaseUrl: "https://abc.supabase.co", supabaseKey: "sb_publishable_x" });
  assert.equal((await call("GET", "/scenarios")).data.scenarios.length, 6);
});

test("auth: everything personal needs a valid token", async () => {
  for (const [m, p] of [["GET", "/me"], ["GET", "/calls"], ["POST", "/session/turn"], ["GET", "/admin/users"]] as const) {
    const r = await call(m, p, { body: m === "POST" ? {} : undefined });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.data.error.code, "unauthorized");
  }
  assert.equal((await call("GET", "/me", { token: "forged" })).status, 401);
});

test("me: profile is created on first sign-in; goal and level are validated", async () => {
  const me = (await call("GET", "/me", { token: "ana-token" })).data;
  assert.equal(me.email, "ana@example.com");
  assert.equal(me.goal, null);
  assert.equal(me.isPro, false);
  assert.equal(me.isAdmin, false);
  assert.equal(me.freeDailyLimit, 2);
  assert.equal(me.callsToday, 0);
  assert.equal((await call("PUT", "/me", { token: "ana-token", body: { goal: "job", level: "C1" } })).status, 400);
  const saved = (await call("PUT", "/me", { token: "ana-token", body: { goal: "job", level: "B1" } })).data;
  assert.equal(saved.level, "B1");
});

test("flow: a call, its feedback, then history and detail", async () => {
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  llm.push(JSON.stringify({ line: "Hi, I have a problem.", end: false }), goodFeedback);
  const t = await call("POST", "/session/turn", { token: "ana-token", body: { sessionId: id, scenarioId: "order-status", history: [] } });
  assert.equal(t.status, 200);
  assert.equal((await call("GET", "/me", { token: "ana-token" })).data.callsToday, 1);

  const history = [{ role: "customer", text: "Hi, I have a problem." }, ...exchanges(2).slice(1)];
  const f = await call("POST", "/session/feedback", { token: "ana-token", body: { sessionId: id, scenarioId: "order-status", history } });
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.equal(f.data.callId, id);

  const list = (await call("GET", "/calls", { token: "ana-token" })).data.calls;
  assert.equal(list.length, 1);
  assert.equal(list[0].titleEs, "Estado de un pedido");
  const detail = (await call("GET", `/calls/${id}`, { token: "ana-token" })).data;
  assert.equal(detail.feedback.corrections.length, 3);
  assert.equal((await call("GET", `/calls/${id}`, { token: "boss-token" })).status, 404, "not visible to others");
});

test("admin: only listed emails; users, Pro, usage", async () => {
  assert.equal((await call("GET", "/admin/users", { token: "ana-token" })).status, 403);
  const me = (await call("GET", "/me", { token: "boss-token" })).data;
  assert.equal(me.isAdmin, true, "admin emails match case-insensitively");

  const users = (await call("GET", "/admin/users?q=ana", { token: "boss-token" })).data;
  assert.equal(users.total, 1);
  assert.equal(users.users[0].calls, 1);

  const ana = USERS["ana-token"]!.userId;
  assert.equal((await call("POST", `/admin/users/${ana}/pro`, { token: "boss-token", body: { isPro: true, proUntil: "2020-01-01" } })).status, 400);
  const pro = await call("POST", `/admin/users/${ana}/pro`, { token: "boss-token", body: { isPro: true, proUntil: "2099-12-31" } });
  assert.equal(pro.status, 200);
  assert.equal(pro.data.proUntil, "2100-01-01T06:00:00.000Z", "through the end of that Honduras day");
  assert.equal((await call("GET", "/me", { token: "ana-token" })).data.isPro, true);
  await call("POST", `/admin/users/${ana}/pro`, { token: "boss-token", body: { isPro: false } });
  assert.equal((await call("GET", "/me", { token: "ana-token" })).data.isPro, false);

  const usage = (await call("GET", "/admin/usage?days=7", { token: "boss-token" })).data;
  assert.equal(usage.byDay.length, 7);
  assert.equal(usage.totals.calls, 1);
  assert.ok(usage.totals.tokens > 0);
});

test("admin: scenarios are validated, saved, and toggled", async () => {
  const list = (await call("GET", "/admin/scenarios", { token: "boss-token" })).data.scenarios;
  const s = list.find((x: { id: string }) => x.id === "order-status");
  assert.equal(s.enabled, true);
  const { enabled: _e, ...plain } = s;

  const broken = await call("PUT", "/admin/scenarios/order-status", { token: "boss-token", body: { scenario: { ...plain, difficulty: "C1" }, enabled: true } });
  assert.equal(broken.status, 400);
  assert.match(broken.data.error.message, /difficulty/);
  const renamed = await call("PUT", "/admin/scenarios/order-status", { token: "boss-token", body: { scenario: { ...plain, id: "other" }, enabled: true } });
  assert.equal(renamed.status, 400);

  const ok = await call("PUT", "/admin/scenarios/order-status", { token: "boss-token", body: { scenario: { ...plain, summaryEs: "Nuevo resumen." }, enabled: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const pub = (await call("GET", "/scenarios")).data.scenarios;
  assert.equal(pub.find((x: { id: string }) => x.id === "order-status").summaryEs, "Nuevo resumen.");

  const added = await call("PUT", "/admin/scenarios/new-scenario", { token: "boss-token", body: { scenario: { ...plain, id: "new-scenario" }, enabled: false } });
  assert.equal(added.status, 200);
  assert.equal((await call("GET", "/scenarios")).data.scenarios.length, 6, "disabled scenarios stay hidden");
  await call("POST", "/admin/scenarios/new-scenario/enabled", { token: "boss-token", body: { enabled: true } });
  assert.equal((await call("GET", "/scenarios")).data.scenarios.length, 7);
});

test("admin: settings are validated and change the free limit", async () => {
  assert.equal((await call("PUT", "/admin/settings", { token: "boss-token", body: { freeDailyLimit: -1, proInstructionsEs: "x" } })).status, 400);
  assert.equal((await call("PUT", "/admin/settings", { token: "boss-token", body: { freeDailyLimit: 3, proInstructionsEs: "" } })).status, 400);
  const s = await call("PUT", "/admin/settings", { token: "boss-token", body: { freeDailyLimit: 5, proInstructionsEs: "Pague por transferencia." } });
  assert.equal(s.status, 200);
  const me = (await call("GET", "/me", { token: "ana-token" })).data;
  assert.equal(me.freeDailyLimit, 5);
  assert.equal(me.proInstructionsEs, "Pague por transferencia.");
});

test("auth: claims must be an authenticated user with an email", () => {
  assert.deepEqual(userFromClaims({ sub: "u1", email: " Ana@Example.com ", role: "authenticated" }), { userId: "u1", email: "ana@example.com" });
  assert.throws(() => userFromClaims({ sub: "u1", email: "a@b.c", role: "anon" }), ApiError);
  assert.throws(() => userFromClaims({ sub: "u1", role: "authenticated" }), ApiError);
});
