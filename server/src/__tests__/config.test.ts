import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAccountConfig, loadConfig } from "../config.js";

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

test("config: admins and time zone", () => {
  const c = loadConfig({ ANTHROPIC_API_KEY: "k" });
  assert.deepEqual(c.adminEmails, [], "no admins unless ADMIN_EMAILS is set");
  assert.equal(c.timeZone, "America/Tegucigalpa");
  const d = loadConfig({ ANTHROPIC_API_KEY: "k", ADMIN_EMAILS: " A@X.com, b@y.com ,", TIMEZONE: "America/New_York" });
  assert.deepEqual(d.adminEmails, ["a@x.com", "b@y.com"]);
  assert.equal(d.timeZone, "America/New_York");
  assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", TIMEZONE: "Mars/Base" }), /TIMEZONE/);
});

test("config: transcripts are recorded by the server unless the emergency mode is set", () => {
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k" }).transcriptMode, "server");
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k", TRANSCRIPT_MODE: " Client " }).transcriptMode, "client");
  assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", TRANSCRIPT_MODE: "browser" }), /TRANSCRIPT_MODE/);
  assert.equal(loadConfig({ ANTHROPIC_API_KEY: "k" }).leaseSeconds, 90);
});

test("config: accounts need Supabase and the database", () => {
  const env = {
    SUPABASE_URL: "https://abcd1234.supabase.co/",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_x",
    DATABASE_URL: "postgresql://postgres.abcd1234:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
  };
  const a = loadAccountConfig(env);
  assert.equal(a.supabaseUrl, "https://abcd1234.supabase.co");
  assert.equal(a.supabaseKey, "sb_publishable_x");
  assert.equal(a.supabaseJwtSecret, "");
  assert.equal(loadAccountConfig({ ...env, SUPABASE_PUBLISHABLE_KEY: "", SUPABASE_ANON_KEY: "eyJ.legacy" }).supabaseKey, "eyJ.legacy");
  assert.throws(() => loadAccountConfig({ ...env, DATABASE_URL: "" }), /DATABASE_URL is missing/);
  assert.throws(() => loadAccountConfig({ ...env, SUPABASE_PUBLISHABLE_KEY: "" }), /SUPABASE_PUBLISHABLE_KEY/);
  assert.throws(() => loadAccountConfig({ ...env, SUPABASE_URL: "https://evil.example.com" }), /SUPABASE_URL/);
});
