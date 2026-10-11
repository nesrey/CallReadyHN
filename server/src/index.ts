import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createAnthropicClient } from "./llm/client.js";
import { TokenBudget } from "./limits.js";
import { loadScenariosFromDisk } from "./scenarios/load.js";

// Load server/.env if present (Node 20.12+). Real environment variables win.
try {
  process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch {
  /* no .env file; fall back to the real environment */
}

try {
  const config = loadConfig(process.env);
  const scenarios = loadScenariosFromDisk();
  const deps = {
    config,
    scenarios: new Map(scenarios.map((s) => [s.id, s])),
    llm: createAnthropicClient({ apiKey: config.apiKey, model: config.model }),
    budget: new TokenBudget(config.sessionTokenCap, config.feedbackReserve),
  };
  const webDir = fileURLToPath(new URL("../../web", import.meta.url));
  const app = createApp(deps, { webDir });

  app.listen(config.port, config.host, () => {
    console.log(`CallReady running at http://${config.host}:${config.port}`);
    console.log(`Model: ${config.model} | scenarios: ${scenarios.length}`);
  });
} catch (e) {
  console.error(`Startup failed: ${(e as Error).message}`);
  process.exit(1);
}
