import { test } from "node:test";
import assert from "node:assert/strict";
import { startAudit, auditCaller, auditSearch, auditReadme, auditError, finishAudit, outcomeFor, pruneCalls, MAX_RESPONSE_BYTES, MAX_ROWS } from "../../src/audit.js";
import { isAdmin } from "../../src/config.js";

const request = () => new Request("https://x.test/v1/search?q=a", { headers: { "User-Agent": "agent/1", Authorization: "Bearer codesearch_secret" } });

function harness() {
  const inserted = [];
  const waits = [];
  const env = {
    DB: {
      prepare: (sql) => ({ bind: (...a) => ({ sql, args: a }) }),
      batch: async (statements) => statements.map((s) => (/INTO api_calls/.test(s.sql) && inserted.push(s.args), { meta: { last_row_id: 1 } })),
    },
  };
  return { env, inserted, waits, ctx: { waitUntil: (p) => waits.push(p) } };
}

const body = (items) => ({
  query: { interpretedBy: "ai", aiStatus: "ai", keyTerms: ["a"], descriptiveWords: [], synonyms: {}, context: [], qualifiers: [], ignored: [] },
  total: items.length,
  page: 1,
  perPage: 50,
  hasMore: false,
  incomplete: false,
  cached: true,
  matchLevel: "key_terms",
  mode: "strict",
  items,
});
const item = (i) => ({ name: `owner/repo${i}`, stars: i, language: "Go", license: "MIT", description: "d".repeat(500), url: "https://github.com/x" });

test("calls without a signed-in user are not stored", async () => {
  const h = harness();
  const a = startAudit(request(), new URL("https://x.test/v1/search"), "r1");
  a.action = "rest_search";
  finishAudit(h.env, h.ctx, a, 401, 5);
  assert.equal(h.waits.length, 0);
});

test("a search stores who, what was asked and what came back, and never the credentials", async () => {
  const h = harness();
  const a = startAudit(request(), new URL("https://x.test/v1/search"), "r2");
  a.action = "rest_search";
  a.query = "kanban";
  a.input = { q: "kanban" };
  auditCaller(a, { user: { id: 7, login: "ann", token_enc: "ENC" }, apiKey: { keyId: "k1", name: "laptop" } });
  auditSearch(a, body([item(1), item(2)]));
  finishAudit(h.env, h.ctx, a, 200, 12);
  await Promise.all(h.waits);
  const row = h.inserted[0];
  assert.deepEqual(row.slice(2, 8), [7, "ann", "k1", "laptop", "rest", "rest_search"]);
  assert.equal(row[15], "kanban");
  const stored = JSON.parse(row[21]);
  assert.deepEqual(stored.items.map((i) => i.name), ["owner/repo1", "owner/repo2"]);
  assert.equal(stored.items[0].description.length, 120);
  assert.equal(stored.understood.by, "ai");
  const everything = JSON.stringify(row);
  assert.ok(!everything.includes("codesearch_secret") && !everything.includes("ENC"));
});

test("very long result pages stay within the size limit and valid JSON", () => {
  const a = startAudit(request(), new URL("https://x.test/v1/search"), "r3");
  const unicode = Array.from({ length: 50 }, (_, i) => ({ ...item(i), description: "語".repeat(120) }));
  auditSearch(a, body(unicode));
  const text = JSON.stringify(a.output);
  assert.ok(new TextEncoder().encode(text).length <= MAX_RESPONSE_BYTES);
  assert.ok(a.output.itemsLogged.endsWith("of 50"));
  assert.ok(a.output.items.length > 0);
});

test("a README stores its repository, size and only the start of the text", () => {
  const a = startAudit(request(), new URL("https://x.test/x"), "r4");
  auditReadme(a, { repo: "a/b", url: "u", text: "x".repeat(5000), truncated: true, totalChars: 9000 });
  assert.equal(a.resultCount, 9000);
  assert.equal(a.output.preview.length, 1000);
  assert.equal(a.output.returnedChars, 5000);
});

test("outcomes: ok, error, rate-limited, and tool errors that return HTTP 200", () => {
  const a = startAudit(request(), new URL("https://x.test/x"), "r5");
  assert.equal(outcomeFor(a, 200), "ok");
  assert.equal(outcomeFor(a, 500), "error");
  assert.equal(outcomeFor(a, 429), "limited");
  auditError(a, { message: "bad", status: 400, code: "invalid_params" });
  assert.equal(outcomeFor(a, 200), "error");
  auditError(a, { message: "slow down", status: 429, extra: { code: "rate_limited" } });
  assert.equal(outcomeFor(a, 200), "limited");
});

test("a failing log write does not reject", async () => {
  const h = harness();
  h.env.DB.prepare = () => {
    throw new Error("D1 down");
  };
  const a = startAudit(request(), new URL("https://x.test/x"), "r6");
  a.action = "x";
  auditCaller(a, { user: { id: 1, login: "a" }, apiKey: null });
  const original = console.error;
  console.error = () => {};
  finishAudit(h.env, h.ctx, a, 200, 1);
  await Promise.all(h.waits);
  console.error = original;
});

test("pruneCalls keeps the newest rows up to the cap", async () => {
  let bound;
  const env = { DB: { prepare: () => ({ bind: (...a) => ((bound = a), { run: async () => ({}) }) }) } };
  await pruneCalls(env, MAX_ROWS + 100, 100 * 86_400_000);
  assert.deepEqual(bound, [100, 500, 10 * 86_400_000]);
});

test("isAdmin is true for exactly one numeric GitHub id", () => {
  const env = { ADMIN_GITHUB_ID: "12" };
  assert.equal(isAdmin(env, { id: 12 }), true);
  assert.equal(isAdmin(env, { id: 1 }), false);
  assert.equal(isAdmin(env, null), false);
  assert.equal(isAdmin({}, { id: 12 }), false);
  for (const bad of ["5, 12", "5,12", "", "abc", "12 13"]) assert.equal(isAdmin({ ADMIN_GITHUB_ID: bad }, { id: 12 }), false, bad);
  assert.equal(isAdmin({ ADMIN_GITHUB_IDS: "12" }, { id: 12 }), false, "the old list setting grants nothing");
});

test("every logged column is capped in bytes, whatever the input contains", async () => {
  const h = harness();
  const a = startAudit(new Request("https://x.test/x", { headers: { "User-Agent": "x".repeat(900) } }), new URL("https://x.test/x"), "r7");
  a.action = "rest_search";
  a.query = "語".repeat(500);
  a.input = { junk: '"語'.repeat(1500) };
  a.error = { code: "e", message: "語".repeat(900) };
  auditCaller(a, { user: { id: 1, login: "a" }, apiKey: null });
  auditSearch(a, body(Array.from({ length: 50 }, (_, i) => ({ ...item(i), description: "語".repeat(120) }))));
  finishAudit(h.env, h.ctx, a, 200, 1);
  await Promise.all(h.waits);
  const row = h.inserted[0];
  const size = (v) => new TextEncoder().encode(v ?? "").length;
  assert.ok(size(row[12]) <= 300 && size(row[15]) <= 600 && size(row[18]) <= 200 && size(row[20]) <= 1000 && size(row[21]) <= MAX_RESPONSE_BYTES, JSON.stringify(row.map((c) => size(String(c)))));
  assert.doesNotThrow(() => (JSON.parse(row[20]), JSON.parse(row[21])));
  const largest = row.reduce((sum, c) => sum + size(typeof c === "string" ? c : ""), 0);
  assert.ok(largest * MAX_ROWS < 300 * 1024 * 1024, `largest row ${largest} bytes`);
});

test("a call blocked by our own limits writes nothing, and uncounted reads add no total", async () => {
  const h = harness();
  const a = startAudit(request(), new URL("https://x.test/x"), "r8");
  a.action = "x";
  auditCaller(a, { user: { id: 1, login: "a" }, apiKey: null });
  auditError(a, Object.assign(new Error("slow"), { ownLimit: true, status: 429 }));
  finishAudit(h.env, h.ctx, a, 429, 1);
  assert.equal(h.waits.length, 0);
  const b = startAudit(request(), new URL("https://x.test/x"), "r9");
  b.action = "GET /api/keys";
  auditCaller(b, { user: { id: 1, login: "a" }, apiKey: null });
  b.skip = true;
  b.uncounted = true;
  finishAudit(h.env, h.ctx, b, 200, 1);
  assert.equal(h.waits.length, 0);
});
