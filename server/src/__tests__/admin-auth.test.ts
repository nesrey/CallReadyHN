// Admin access: the token's email must be in ADMIN_EMAILS and Supabase's own sign-in record must agree.
// ADMIN_AUTH_MODE=report logs a disagreement and lets the admin in; enforce refuses. In-memory database only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { adminProblem, isAdmin } from "../account.js";
import { createApp } from "../app.js";
import type { Auth, AuthUser } from "../auth.js";
import { loadConfig, type AdminAuthMode } from "../config.js";
import type { AuthAccount } from "../db/store.js";
import { ApiError } from "../errors.js";
import type { Deps } from "../handlers.js";
import { ScenarioCatalog } from "../scenarios/catalog.js";
import { MockLlm, addAuthUser, freshStore } from "./helpers.js";

const ADMINS = "boss@example.com";
const BOSS: AuthUser = { userId: "99999999-9999-4999-8999-999999999999", email: "boss@example.com" };
const ANA: AuthUser = { userId: "11111111-1111-4111-8111-111111111111", email: "ana@example.com" };
const ok: AuthAccount = { email: "boss@example.com", emailConfirmed: true, banned: false, deleted: false, anonymous: false };

/** Capture console.warn while `fn` runs. */
async function warnings<T>(fn: () => Promise<T>): Promise<{ out: T; logs: string[] }> {
  const logs: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { logs.push(a.join(" ")); };
  try {
    return { out: await fn(), logs };
  } finally {
    console.warn = orig;
  }
}

async function depsFor(mode: AdminAuthMode) {
  const store = await freshStore();
  const catalog = new ScenarioCatalog(store);
  await catalog.refresh();
  const config = loadConfig({ ANTHROPIC_API_KEY: "test", ADMIN_EMAILS: ADMINS, ADMIN_AUTH_MODE: mode });
  const deps: Deps = { config, catalog, store, llm: new MockLlm([]) };
  return { deps, store };
}

test("adminProblem: only a confirmed, current, active, non-anonymous admin record passes", () => {
  const list = [ADMINS];
  assert.equal(adminProblem(ok, "boss@example.com", list), null);
  assert.equal(adminProblem(null, "boss@example.com", list), "no sign-in record");
  assert.equal(adminProblem({ ...ok, deleted: true }, "boss@example.com", list), "account deleted");
  assert.equal(adminProblem({ ...ok, anonymous: true }, "boss@example.com", list), "anonymous account");
  assert.equal(adminProblem({ ...ok, banned: true }, "boss@example.com", list), "account banned");
  assert.equal(adminProblem({ ...ok, emailConfirmed: false }, "boss@example.com", list), "email not confirmed");
  assert.equal(adminProblem({ ...ok, email: "someone@else.com" }, "boss@example.com", list), "sign-in email is not an admin email");
  assert.equal(adminProblem({ ...ok, email: null }, "boss@example.com", list), "sign-in email is not an admin email");
  const two = [ADMINS, "other-admin@example.com"];
  assert.match(adminProblem({ ...ok, email: "other-admin@example.com" }, "boss@example.com", two)!, /token email differs/);
});

test("config: ADMIN_AUTH_MODE defaults to report; only report or enforce", () => {
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k" }).adminAuthMode, "report");
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k", ADMIN_AUTH_MODE: " Enforce " }).adminAuthMode, "enforce");
  assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", ADMIN_AUTH_MODE: "off" }), /ADMIN_AUTH_MODE/);
});

test("enforce: a verified admin is let in; every bad sign-in record is refused and logged without the email", async () => {
  const { deps, store } = await depsFor("enforce");
  await addAuthUser(store, { id: BOSS.userId, email: BOSS.email });
  assert.equal((await warnings(() => isAdmin(deps, BOSS))).out, true);

  const cases: Array<[string, Parameters<typeof addAuthUser>[1]]> = [
    ["email not confirmed", { id: BOSS.userId, email: BOSS.email, confirmed: false }],
    ["account banned", { id: BOSS.userId, email: BOSS.email, bannedUntil: new Date(Date.now() + 3600_000) }],
    ["account deleted", { id: BOSS.userId, email: BOSS.email, deleted: true }],
    ["sign-in email is not an admin email", { id: BOSS.userId, email: "new-address@example.com" }],
  ];
  for (const [why, row] of cases) {
    await addAuthUser(store, row);
    const { out, logs } = await warnings(() => isAdmin(deps, BOSS));
    assert.equal(out, false, why);
    assert.equal(logs.length, 1, why);
    assert.match(logs[0]!, new RegExp(`admin_auth refused: user ${BOSS.userId}: ${why}`));
    assert.ok(!logs[0]!.includes("boss@"), "the log never contains the email");
  }

  await addAuthUser(store, { id: BOSS.userId, email: BOSS.email, bannedUntil: new Date(Date.now() - 3600_000) });
  assert.equal(await isAdmin(deps, BOSS), true, "a ban that has ended no longer counts");

  const ghost: AuthUser = { userId: "88888888-8888-4888-8888-888888888888", email: BOSS.email };
  assert.equal((await warnings(() => isAdmin(deps, ghost))).out, false, "a token for a user Supabase has no record of");
});

test("ordinary users are never admins, and never cost a sign-in lookup", async () => {
  const { deps, store } = await depsFor("enforce");
  let lookups = 0;
  const counting = { ...deps, store: Object.assign(Object.create(store), { getAuthAccount: async () => { lookups++; return ok; } }) };
  assert.equal(await isAdmin(counting, ANA), false);
  assert.equal(lookups, 0);
});

test("report: a bad record still gets in but is logged; enforce fails closed if the record can't be read", async () => {
  const { deps, store } = await depsFor("report");
  await addAuthUser(store, { id: BOSS.userId, email: BOSS.email, confirmed: false });
  const r = await warnings(() => isAdmin(deps, BOSS));
  assert.equal(r.out, true);
  assert.match(r.logs[0]!, /admin_auth would refuse: .*email not confirmed/);

  const broken = Object.assign(Object.create(store), { getAuthAccount: async () => { throw new Error("permission denied for table users"); } });
  const inReport = await warnings(() => isAdmin({ ...deps, store: broken }, BOSS));
  assert.equal(inReport.out, true);
  assert.match(inReport.logs[0]!, /could not be read \(permission denied/);
  const enforce = { ...deps, store: broken, config: { ...deps.config, adminAuthMode: "enforce" as const } };
  assert.equal((await warnings(() => isAdmin(enforce, BOSS))).out, false);
});

// ---- Over HTTP, in enforce mode
const TOKENS: Record<string, AuthUser> = {
  "boss-token": BOSS,
  "ana-token": ANA,
  "unconfirmed-admin-token": { userId: "77777777-7777-4777-8777-777777777777", email: "boss@example.com" },
};
const fakeAuth: Auth = {
  async verify(token) {
    if (token === "expired-token") throw new ApiError(401, "unauthorized", "Sign in again.");
    const u = TOKENS[token];
    if (!u) throw new ApiError(401, "unauthorized", "Sign in again.");
    return u;
  },
};
const http = await depsFor("enforce");
await addAuthUser(http.store, { id: BOSS.userId, email: BOSS.email });
await addAuthUser(http.store, { id: ANA.userId, email: ANA.email });
await addAuthUser(http.store, { id: TOKENS["unconfirmed-admin-token"]!.userId, email: null, confirmed: false });
const server = createApp(
  { ...http.deps, auth: fakeAuth, publicConfig: { supabaseUrl: "https://abc.supabase.co", supabaseKey: "sb_publishable_x" } },
  { siteDir: fileURLToPath(new URL("../../..", import.meta.url)) },
).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());
const get = async (path: string, token: string) => {
  const r = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, data: await r.json() };
};

test("http (enforce): verified admin, unconfirmed admin email, ordinary user, expired session", async () => {
  assert.equal((await get("/admin/users", "boss-token")).status, 200);
  assert.equal((await get("/me", "boss-token")).data.isAdmin, true);

  const { out } = await warnings(async () => [(await get("/admin/users", "unconfirmed-admin-token")).status, (await get("/me", "unconfirmed-admin-token")).data.isAdmin]);
  assert.deepEqual(out, [403, false], "a token showing the admin email is not enough");

  assert.equal((await get("/admin/settings", "ana-token")).status, 403);
  assert.equal((await get("/me", "ana-token")).data.isAdmin, false);
  for (const p of ["/admin/users", "/admin/overview", "/admin/settings"]) assert.equal((await get(p, "expired-token")).status, 401, p);
});

test("http: admin requests are rate-limited like the rest of the account routes", async () => {
  let last = 0;
  for (let i = 0; i < 245 && last !== 429; i++) last = (await get("/admin/settings", "boss-token")).status;
  assert.equal(last, 429);
});
