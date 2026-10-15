// Past results keep their original score: the stored score is shown, never recomputed with today's weights, and each
// call keeps the rubric version (labels and weights) it was scored with. In-memory database, fake model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { getMyCall, listMyCalls } from "../account.js";
import { adminListUsers, adminUsage } from "../admin.js";
import type { AuthUser } from "../auth.js";
import { loadConfig } from "../config.js";
import { PgStore } from "../db/pgStore.js";
import { handleFeedback, handleTurn, presentFeedback, type Deps } from "../handlers.js";
import { parseFeedbackOutput } from "../llm/parse.js";
import { CUSTOMER_RUBRIC, RUBRIC_VERSION, qaScore, rubricFor } from "../llm/rubric.js";
import { ScenarioCatalog } from "../scenarios/catalog.js";
import { loadScenariosFromDisk } from "../scenarios/load.js";
import type { Message } from "../types.js";
import { MockLlm, goodFeedback } from "./helpers.js";

const ANA: AuthUser = { userId: "11111111-1111-4111-8111-111111111111", email: "ana@example.com" };
const CALL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FREE = "service-late-fee";

/** A scored call (QA 60 under the current rubric), on a database the test can also edit directly. */
async function scoredCall() {
  const db = new PGlite();
  const store = new PgStore(db);
  await store.migrate();
  await store.seedScenarios(loadScenariosFromDisk());
  await store.touchProfile(ANA.userId, ANA.email);
  await store.setPro(ANA.userId, true, null);
  const catalog = new ScenarioCatalog(store);
  await catalog.refresh();
  const llm = new MockLlm([]);
  const deps: Deps = { config: loadConfig({ ANTHROPIC_API_KEY: "test" }), catalog, store, llm };
  const h: Message[] = [{ role: "agent", text: "Thank you for calling, my name is Ana. How can I help?" }];
  for (let i = 1; i <= 3; i++) {
    llm.push(JSON.stringify({ line: `Caller line ${i}.`, end: false }));
    const out = await handleTurn(deps, ANA, { sessionId: CALL, scenarioId: FREE, history: h });
    h.push({ role: "customer", text: out.line }, { role: "agent", text: `Agent answer number ${i}, let me help.` });
  }
  llm.push(goodFeedback);
  const first = await handleFeedback(deps, ANA, { sessionId: CALL, scenarioId: FREE });
  return { db, store, deps, llm, first };
}

test("rubric versions: the current version is stored with each scorecard; versions can't be edited in place", async () => {
  const { db, store, first } = await scoredCall();
  assert.equal(first.qaScore, 60);
  assert.equal((await store.getCallDetail(ANA.userId, CALL))!.rubricVersion, RUBRIC_VERSION);
  assert.equal(((await db.query("select rubric_version from callready_v2.calls where id = $1", [CALL])).rows[0] as { rubric_version: number }).rubric_version, RUBRIC_VERSION);
  assert.ok(Object.isFrozen(rubricFor("service", 1)) && Object.isFrozen(rubricFor("service", 1)[0]), "a version's weights can't change");
  assert.equal(rubricFor("interview", 1).length, 6);
  assert.equal(rubricFor("service", 999), rubricFor("service"), "an unknown version falls back to the current one");
});

test("a stored score is shown as stored, never recomputed: results page, asking again, history and admin", async () => {
  const { db, deps, llm } = await scoredCall();
  // The same scorecard scored under other weights would have given 73: emulate that call by storing 73.
  await db.query("update callready_v2.calls set qa_score = 73 where id = $1", [CALL]);
  assert.equal((await getMyCall(deps, ANA, CALL)).feedback.qaScore, 73, "results page");
  const again = await handleFeedback(deps, ANA, { sessionId: CALL, scenarioId: FREE });
  assert.equal(again.qaScore, 73, "asking for the scorecard again");
  assert.equal(llm.calls.length, 4, "and no new grading");
  assert.equal((await listMyCalls(deps, ANA)).calls[0]!.qaScore, 73, "history");
  assert.equal((await adminListUsers(deps, {})).users.find((u) => u.userId === ANA.userId)!.avgQa, 73, "admin users");
  assert.equal((await adminUsage(deps, { days: "7" })).totals.avgQa, 73, "admin usage");
});

test("existing calls are version 1 after the migration, and show version 1's weights", async () => {
  const { db, store, deps } = await scoredCall();
  await db.query("update callready_v2.calls set rubric_version = 1 where id = $1", [CALL]);
  await store.migrate(); // startup runs the script again: nothing changes
  const shown = (await getMyCall(deps, ANA, CALL)).feedback;
  assert.deepEqual(shown.criteria.map((c) => [c.key, c.weight]), rubricFor("service", 1).map((c) => [c.key, c.weight]));
  assert.equal(shown.qaScore, 60);

  // A row from before the column existed gets 1 (the only rubric there ever was before it).
  await db.query("alter table callready_v2.calls drop column rubric_version");
  await store.migrate();
  assert.equal((await store.getCallDetail(ANA.userId, CALL))!.rubricVersion, 1);
});

test("presentFeedback: a new scorecard is computed from the rubric; a saved one keeps its stored score", () => {
  const f = parseFeedbackOutput(goodFeedback, CUSTOMER_RUBRIC);
  const computed = qaScore(Object.fromEntries(f.criteria.map((c) => [c.key, c.score])), CUSTOMER_RUBRIC);
  assert.equal(presentFeedback(f, CUSTOMER_RUBRIC).qaScore, computed);
  assert.equal(presentFeedback(f, CUSTOMER_RUBRIC, 88).qaScore, 88);
  assert.equal(presentFeedback(f, CUSTOMER_RUBRIC, 0).qaScore, 0, "a stored 0 is kept too");
});
