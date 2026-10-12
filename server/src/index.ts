import { fileURLToPath } from "node:url";
import pg from "pg";
import { createApp } from "./app.js";
import { createSupabaseAuth } from "./auth.js";
import { loadAccountConfig, loadConfig } from "./config.js";
import { PgStore } from "./db/pgStore.js";
import { createAnthropicClient } from "./llm/client.js";
import { createGeminiClient } from "./llm/gemini.js";
import { ScenarioCatalog } from "./scenarios/catalog.js";
import { loadScenariosFromDisk } from "./scenarios/load.js";

// Load server/.env if present (Node 20.12+). Real environment variables win.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* no .env file; fall back to the real environment */
}

/**
 * SSL is always on. With DATABASE_SSL_CA the server certificate is verified; without it the connection is still
 * encrypted but not verified. sslmode in the URL is removed because node-postgres lets it override these options.
 */
function createPool(databaseUrl: string, ca: string): pg.Pool {
  const url = new URL(databaseUrl);
  for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(k);
  if (!ca) console.warn("DATABASE_SSL_CA is not set: the database connection is encrypted but its certificate is not verified.");
  return new pg.Pool({
    connectionString: url.toString(),
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}

async function main() {
  const config = loadConfig(process.env);
  const accounts = loadAccountConfig(process.env);

  const pool = createPool(accounts.databaseUrl, accounts.databaseSslCa);
  pool.on("error", (e) => console.error("Database pool error:", e.message));
  const store = new PgStore(pool);
  await store.migrate();
  const added = await store.seedScenarios(loadScenariosFromDisk());
  const catalog = new ScenarioCatalog(store);
  await catalog.refresh();

  const app = createApp(
    {
      config,
      catalog,
      store,
      llm: (config.provider === "gemini" ? createGeminiClient : createAnthropicClient)({
        apiKey: config.apiKey,
        model: config.model,
      }),
      auth: createSupabaseAuth({ supabaseUrl: accounts.supabaseUrl, jwtSecret: accounts.supabaseJwtSecret }),
      publicConfig: { supabaseUrl: accounts.supabaseUrl, supabaseKey: accounts.supabaseKey },
    },
    { siteDir: fileURLToPath(new URL("../..", import.meta.url)) },
  );

  app.listen(config.port, config.host, () => {
    console.log(`CallReady running at http://${config.host}:${config.port}`);
    console.log(`AI: ${config.provider} / ${config.model} | scenarios: ${catalog.list().length} (${added} new from the seed file)`);
    console.log(`Admins: ${config.adminEmails.join(", ") || "(none)"} | time zone: ${config.timeZone}`);
  });
}

main().catch((e) => {
  console.error(`Startup failed: ${(e as Error).message}`);
  process.exit(1);
});
