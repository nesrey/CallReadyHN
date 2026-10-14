import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeDatabase, productionRefIn } from "../dbGuard.js";

const PROD_POOLER = "postgresql://postgres.idjtedvobmjpfhxzjife:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
const PROD_DIRECT = "postgresql://postgres:pw@db.idjtedvobmjpfhxzjife.supabase.co:5432/postgres";
const PROD_ENCODED = "postgresql://postgres%2Eidjtedvobmjpfhxzjife:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres";
const SCRATCH = "postgresql://postgres.abcd1234scratch:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres";
const LOCAL = "postgresql://postgres:pw@localhost:5432/callready";

test("db guard: recognises the production project in every connection form", () => {
  for (const url of [PROD_POOLER, PROD_DIRECT, PROD_ENCODED, PROD_POOLER.toUpperCase()]) {
    assert.equal(productionRefIn(url), "idjtedvobmjpfhxzjife", url);
  }
  assert.equal(productionRefIn(SCRATCH), null);
  assert.equal(productionRefIn(LOCAL), null);
});

test("db guard: only the Render service may start against production", () => {
  assert.throws(() => assertSafeDatabase(PROD_POOLER, {}), /production database/);
  assert.throws(() => assertSafeDatabase(PROD_DIRECT, { RENDER: "false" }), /production database/);
  assert.doesNotThrow(() => assertSafeDatabase(PROD_POOLER, { RENDER: "true" }));
  assert.doesNotThrow(() => assertSafeDatabase(SCRATCH, {}));
  assert.doesNotThrow(() => assertSafeDatabase(LOCAL, {}));
});
