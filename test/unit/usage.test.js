import { test } from "node:test";
import assert from "node:assert/strict";
import { recordCall, usageFor, parseDays, outcomeOf } from "../../src/usage.js";

function fakeDb(rows = []) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          calls.push({ sql, args });
          return {
            run: async () => ({ meta: { changes: 1 } }),
            all: async () => ({ results: rows }),
          };
        },
      };
    },
  };
}

test("recordCall upserts one hourly row in the background", async () => {
  const DB = fakeDb();
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  recordCall({ DB }, ctx, { user: { id: 7 }, apiKey: { keyId: "k1" } }, "mcp_search", "ok", true);
  await Promise.all(pending);
  assert.equal(DB.calls.length, 1);
  const [userId, keyId, hour, endpoint, ok, errors, limited, cached] = DB.calls[0].args;
  assert.deepEqual([userId, keyId, endpoint, ok, errors, limited, cached], [7, "k1", "mcp_search", 1, 0, 0, 1]);
  assert.equal(hour % 3_600_000, 0);
  assert.match(DB.calls[0].sql, /ON CONFLICT/);
});

test("recordCall counts dashboard calls under 'web' and classifies 429 as limited", async () => {
  const DB = fakeDb();
  const pending = [];
  recordCall({ DB }, { waitUntil: (p) => pending.push(p) }, { user: { id: 7 }, apiKey: null }, "rest_search", outcomeOf({ status: 429 }));
  await Promise.all(pending);
  const a = DB.calls[0].args;
  assert.equal(a[1], "web");
  assert.deepEqual(a.slice(4), [0, 0, 1, 0]);
  assert.equal(outcomeOf({ status: 502 }), "error");
});

test("recordCall ignores unknown endpoints and missing bindings", () => {
  const DB = fakeDb();
  recordCall({ DB }, { waitUntil() {} }, { user: { id: 1 } }, "nope", "ok");
  recordCall({}, { waitUntil() {} }, { user: { id: 1 } }, "rest_search", "ok");
  recordCall({ DB }, null, { user: { id: 1 } }, "rest_search", "ok");
  assert.equal(DB.calls.length, 0);
});

test("parseDays accepts 1, 7, 30, 90 only", () => {
  assert.equal(parseDays(undefined), 7);
  assert.equal(parseDays("30"), 30);
  assert.equal(parseDays("5"), null);
  assert.equal(parseDays("abc"), null);
});

test("usageFor prunes old rows, maps rows and names revoked keys", async () => {
  const DB = fakeDb([
    { key_id: "k1", hour: 1, endpoint: "rest_search", calls: 3, ok: 2, errors: 0, limited: 1, cached: 1 },
    { key_id: "gone", hour: 2, endpoint: "mcp_readme", calls: 1, ok: 1, errors: 0, limited: 0, cached: 0 },
    { key_id: "web", hour: 2, endpoint: "rest_search", calls: 2, ok: 2, errors: 0, limited: 0, cached: 0 },
  ]);
  const out = await usageFor({ DB }, 7, 7, [{ id: "k1", name: "laptop", prefix: "cs_abc" }]);
  assert.match(DB.calls[0].sql, /^DELETE FROM key_usage/);
  assert.equal(out.days, 7);
  assert.deepEqual(out.keys.map((k) => [k.id, k.revoked]), [["k1", false], ["gone", true]]);
  assert.equal(out.rows.length, 3);
  assert.deepEqual(out.rows[0], { keyId: "k1", hour: 1, endpoint: "rest_search", calls: 3, ok: 2, errors: 0, limited: 1, cached: 1 });
});

test("a missing usage table is created on demand and the write retried", async () => {
  const seen = [];
  let tableExists = false;
  const DB = {
    prepare(sql) {
      const stmt = {
        bind: () => stmt,
        async run() {
          seen.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
          if (!tableExists) throw new Error("D1_ERROR: no such table: key_usage: SQLITE_ERROR");
          return { meta: {} };
        },
        sql,
      };
      return stmt;
    },
    async batch(stmts) {
      seen.push(`batch:${stmts.length}`);
      tableExists = true;
    },
  };
  const pending = [];
  recordCall({ DB }, { waitUntil: (p) => pending.push(p) }, { user: { id: 1 }, apiKey: null }, "rest_search", "ok");
  await Promise.all(pending);
  assert.deepEqual(seen, ["INSERT INTO", "batch:2", "INSERT INTO"]);
});
