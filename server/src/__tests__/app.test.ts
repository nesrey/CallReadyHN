import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import { userFromClaims, type Auth, type AuthUser } from "../auth.js";
import { loadConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { ScenarioCatalog } from "../scenarios/catalog.js";
import { MockLlm, addAuthUser, exchanges, freshStore, goodFeedback } from "./helpers.js";

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
await addAuthUser(store, { id: USERS["boss-token"]!.userId, email: "boss@example.com" }); // the admin's confirmed sign-in record
const catalog = new ScenarioCatalog(store);
await catalog.refresh();
const llm = new MockLlm([]);
const app = createApp(
  {
    config, catalog, store, llm, auth: fakeAuth,
    publicConfig: { supabaseUrl: "https://abc.supabase.co", supabaseKey: "sb_publishable_x" },
  },
  { siteDir: fileURLToPath(new URL("../../..", import.meta.url)) },
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

test("site: the server serves the site pages only, never the rest of the repo", async () => {
  for (const p of ["/", "/privacy.html", "/app/", "/web/"]) assert.equal((await fetch(base + p)).status, 200, p);
  for (const p of ["/package.json", "/server/.env.example", "/README.md", "/app/../package.json"]) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test("public: /config and /scenarios need no sign-in", async () => {
  assert.deepEqual((await call("GET", "/config")).data, { supabaseUrl: "https://abc.supabase.co", supabaseKey: "sb_publishable_x" });
  assert.equal((await call("GET", "/scenarios")).data.scenarios.length, 13);
});

test("auth: everything personal needs a valid token", async () => {
  for (const [m, p] of [["GET", "/me"], ["GET", "/calls"], ["POST", "/session/turn"], ["GET", "/admin/users"]] as const) {
    const r = await call(m, p, { body: m === "POST" ? {} : undefined });
    assert.equal(r.status, 401, `${m} ${p}`);
    assert.equal(r.data.error.code, "unauthorized");
  }
  assert.equal((await call("GET", "/me", { token: "forged" })).status, 401);
});

test("me: profile is created on first sign-in; role and interests are validated", async () => {
  const me = (await call("GET", "/me", { token: "ana-token" })).data;
  assert.equal(me.email, "ana@example.com");
  assert.equal(me.role, null);
  assert.deepEqual(me.interests, []);
  assert.equal(me.isPro, false);
  assert.equal(me.isAdmin, false);
  assert.equal(me.freeDailyLimit, 2);
  assert.equal(me.callsToday, 0);
  assert.equal((await call("PUT", "/me", { token: "ana-token", body: { role: "boss", interests: [] } })).status, 400);
  assert.equal((await call("PUT", "/me", { token: "ana-token", body: { role: "agent", interests: ["retail"] } })).status, 400);
  const saved = (await call("PUT", "/me", { token: "ana-token", body: { role: "agent", interests: ["tech", "tech", "collections"] } })).data;
  assert.equal(saved.role, "agent");
  assert.deepEqual(saved.interests, ["tech", "collections"]);
});

test("public scenarios show the desk panel but not the caller-only facts", async () => {
  const list = (await call("GET", "/scenarios")).data.scenarios;
  const wifi = list.find((x: { id: string }) => x.id === "tech-wifi-down");
  assert.ok(wifi.policies.length > 0);
  assert.ok(wifi.account.length > 0);
  assert.equal(wifi.hiddenFacts, undefined);
  assert.ok(!JSON.stringify(list).includes("loose"));
});

test("flow: a call, its scorecard, then history and the review with transcript", async () => {
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const history = exchanges(0);
  for (let i = 1; i <= 3; i++) {
    llm.push(JSON.stringify({ line: `Caller line ${i}: my internet is down.`, end: false }));
    const t = await call("POST", "/session/turn", { token: "ana-token", body: { sessionId: id, scenarioId: "tech-wifi-down", history } });
    assert.equal(t.status, 200, JSON.stringify(t.data));
    if (i === 1) assert.equal((await call("GET", "/me", { token: "ana-token" })).data.callsToday, 1);
    history.push({ role: "customer", text: t.data.line }, { role: "agent", text: `Agent answer number ${i} thank you.` });
  }

  // The page's copy ends with a line the caller never answered; only the server's turns are scored and saved.
  llm.push(goodFeedback);
  const f = await call("POST", "/session/feedback", { token: "ana-token", body: { sessionId: id, scenarioId: "tech-wifi-down", history } });
  assert.equal(f.status, 200, JSON.stringify(f.data));
  assert.equal(f.data.callId, id);
  assert.equal(f.data.qaScore, 60);
  assert.equal(f.data.transcript.length, history.length - 1);

  const list = (await call("GET", "/calls", { token: "ana-token" })).data.calls;
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Internet not working");
  assert.equal(list[0].qaScore, 60);
  const skills = (await call("GET", "/calls", { token: "ana-token" })).data.skills;
  assert.equal(skills.length, 8);
  assert.deepEqual(skills[0], { key: "opening", label: "Opening", avg: 6, n: 1 });
  const detail = (await call("GET", `/calls/${id}`, { token: "ana-token" })).data;
  assert.equal(detail.feedback.qaScore, 60);
  assert.equal(detail.feedback.criteria[0].label, "Opening");
  assert.deepEqual(detail.transcript, f.data.transcript);
  assert.equal((await call("GET", `/calls/${id}`, { token: "boss-token" })).status, 404, "not visible to others");

  // Another user can't send turns or score this call.
  const theirs = { sessionId: id, scenarioId: "tech-wifi-down", history };
  assert.equal((await call("POST", "/session/turn", { token: "boss-token", body: theirs })).status, 404);
  assert.equal((await call("POST", "/session/feedback", { token: "boss-token", body: theirs })).status, 404);
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

test("admin: overview has headline numbers, 14 days, recent calls, new users and top scenarios", async () => {
  assert.equal((await call("GET", "/admin/overview", { token: "ana-token" })).status, 403);
  const o = (await call("GET", "/admin/overview", { token: "boss-token" })).data;
  assert.equal(o.totals.users, 2);
  assert.equal(o.totals.newUsers7d, 2);
  assert.equal(o.totals.callsToday, 1);
  assert.equal(o.totals.calls7d, 1);
  assert.equal(o.totals.avgQa7d, 60);
  assert.ok(o.totals.tokens7d > 0);
  assert.equal(o.byDay.length, 14);
  assert.equal(o.recentCalls.length, 1);
  assert.equal(o.recentCalls[0].email, "ana@example.com");
  assert.equal(o.recentCalls[0].title, "Internet not working");
  assert.equal(o.recentCalls[0].qaScore, 60);
  assert.deepEqual(o.newUsers.map((u: { email: string }) => u.email).sort(), ["ana@example.com", "boss@example.com"]);
  assert.deepEqual(o.topScenarios, [{ title: "Internet not working", callType: "tech", calls: 1 }]);
});

test("admin: scenarios are validated, saved, and toggled", async () => {
  const list = (await call("GET", "/admin/scenarios", { token: "boss-token" })).data.scenarios;
  const s = list.find((x: { id: string }) => x.id === "tech-wifi-down");
  assert.equal(s.enabled, true);
  assert.ok(Array.isArray(s.hiddenFacts), "admins see the caller-only facts");
  const { enabled: _e, ...plain } = s;

  const broken = await call("PUT", "/admin/scenarios/tech-wifi-down", { token: "boss-token", body: { scenario: { ...plain, temperament: "angry" }, enabled: true } });
  assert.equal(broken.status, 400);
  assert.match(broken.data.error.message, /temperament/);
  const renamed = await call("PUT", "/admin/scenarios/tech-wifi-down", { token: "boss-token", body: { scenario: { ...plain, id: "other" }, enabled: true } });
  assert.equal(renamed.status, 400);

  const ok = await call("PUT", "/admin/scenarios/tech-wifi-down", { token: "boss-token", body: { scenario: { ...plain, summary: "New summary." }, enabled: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const pub = (await call("GET", "/scenarios")).data.scenarios;
  assert.equal(pub.find((x: { id: string }) => x.id === "tech-wifi-down").summary, "New summary.");

  const added = await call("PUT", "/admin/scenarios/new-scenario", { token: "boss-token", body: { scenario: { ...plain, id: "new-scenario" }, enabled: false } });
  assert.equal(added.status, 200);
  assert.equal((await call("GET", "/scenarios")).data.scenarios.length, 13, "disabled scenarios stay hidden");
  await call("POST", "/admin/scenarios/new-scenario/enabled", { token: "boss-token", body: { enabled: true } });
  assert.equal((await call("GET", "/scenarios")).data.scenarios.length, 14);
});

test("admin: settings are validated and change the free limit", async () => {
  assert.equal((await call("PUT", "/admin/settings", { token: "boss-token", body: { freeDailyLimit: -1, proInstructions: "x" } })).status, 400);
  assert.equal((await call("PUT", "/admin/settings", { token: "boss-token", body: { freeDailyLimit: 3, proInstructions: "" } })).status, 400);
  const s = await call("PUT", "/admin/settings", { token: "boss-token", body: { freeDailyLimit: 5, proInstructions: "Pay by bank transfer." } });
  assert.equal(s.status, 200);
  const me = (await call("GET", "/me", { token: "ana-token" })).data;
  assert.equal(me.freeDailyLimit, 5);
  assert.equal(me.proInstructions, "Pay by bank transfer.");
});
test("auth: claims must be an authenticated user with an email", () => {
  assert.deepEqual(userFromClaims({ sub: "u1", email: " Ana@Example.com ", role: "authenticated" }), { userId: "u1", email: "ana@example.com" });
  assert.throws(() => userFromClaims({ sub: "u1", email: "a@b.c", role: "anon" }), ApiError);
  assert.throws(() => userFromClaims({ sub: "u1", role: "authenticated" }), ApiError);
});

test("http: a busy call answers 409 turn_in_progress with Retry-After; an invented turn gets 409 turn_conflict", async () => {
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const ana = USERS["ana-token"]!.userId;
  const history = exchanges(0);
  llm.push(JSON.stringify({ line: "Hello?", end: false }));
  const first = await call("POST", "/session/turn", { token: "ana-token", body: { sessionId: id, scenarioId: "tech-wifi-down", history } });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  history.push({ role: "customer", text: "Hello?" }, { role: "agent", text: "How can I help?" });

  const holder = "00000000-0000-4000-8000-0000000000aa";
  assert.ok(await store.acquireLease(id, ana, holder, 90));
  const busy = await call("POST", "/session/turn", { token: "ana-token", origin: PAGES, body: { sessionId: id, scenarioId: "tech-wifi-down", history } });
  assert.equal(busy.status, 409);
  assert.equal(busy.data.error.code, "turn_in_progress");
  assert.equal(busy.headers.get("retry-after"), "3");
  assert.match(busy.headers.get("access-control-expose-headers") ?? "", /Retry-After/, "the page can read it");
  await store.releaseLease(id, ana, holder, 0);

  const invented = [...history, { role: "customer", text: "Invented." }, { role: "agent", text: "Sure." }];
  const forged = await call("POST", "/session/turn", { token: "ana-token", body: { sessionId: id, scenarioId: "tech-wifi-down", history: invented } });
  assert.equal(forged.status, 409);
  assert.equal(forged.data.error.code, "turn_conflict");
  assert.equal(forged.headers.get("retry-after"), null);
});
