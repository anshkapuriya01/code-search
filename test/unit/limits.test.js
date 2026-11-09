import { test } from "node:test";
import assert from "node:assert/strict";
import { enforceDailyLimits, enforceRateLimit, anonymousRetryAfter, secondsUntilUtcMidnight, utcDay } from "../../src/limits.js";
import { interpretQuery, MODELS } from "../../src/ai.js";
import { getReadme, MAX_README_CHARS } from "../../src/readme.js";
import { searchRepositories } from "../../src/search.js";
import { readStream, readBody } from "../../src/http.js";
import { runMaintenance } from "../../src/maintenance.js";
import { buildQuery, parseQuery, parseSearchParams } from "../../public/lib/query.js";

const ADMIN = 99;

function env({ mine = 0, site = 0, neurons = 0, userNeurons = 0, limits = {} } = {}) {
  const models = [];
  return {
    models,
    ADMIN_GITHUB_ID: String(ADMIN),
    USER_DAILY_REQUESTS: "10",
    SITE_DAILY_REQUESTS: "100",
    ...limits,
    AI: { run: async (id) => (models.push(id), { response: { key_terms: ["alpha", "beta"], descriptive: [], synonyms: {}, context: [] }, usage: { prompt_tokens: 100, completion_tokens: 10 } }) },
    DB: {
      prepare: (sql) => ({
        bind: () => ({
          first: async () => {
            if (/SUM\(requests\)/.test(sql)) return { n: site };
            if (/SELECT requests/.test(sql)) return { requests: mine };
            if (/FROM ai_usage/.test(sql)) return { neurons, calls: 0, failures: 0 };
            if (/SELECT neurons FROM user_daily/.test(sql)) return { neurons: userNeurons };
            return null;
          },
          run: async () => ({ meta: {} }),
        }),
      }),
    },
  };
}

// The day cache is per isolate, so each test uses its own day.
const dayOf = (n) => Date.UTC(2031, 0, n, 12);
const blocked = (code) => (err) => err.status === 429 && err.code === code && err.ownLimit === true && err.extra.retryAfter > 0;

test("the daily allowance stops an account, one over at a time, and resets the next UTC day", async () => {
  const e = env({ mine: 8 });
  const user = { id: 1 };
  await enforceDailyLimits(e, user, dayOf(1));
  await enforceDailyLimits(e, user, dayOf(1));
  await assert.rejects(enforceDailyLimits(e, user, dayOf(1)), blocked("daily_limit"));
  await enforceDailyLimits(env(), user, dayOf(2));
});

test("one account's allowance does not affect another account", async () => {
  await assert.rejects(enforceDailyLimits(env({ mine: 10 }), { id: 2 }, dayOf(3)), blocked("daily_limit"));
  await enforceDailyLimits(env({ mine: 0 }), { id: 3 }, dayOf(3));
});

test("the site ceiling stops ordinary accounts", async () => {
  await assert.rejects(enforceDailyLimits(env({ site: 100 }), { id: 4 }, dayOf(4)), blocked("site_daily_limit"));
});

test("the admin account has no minute, daily or site limit", async () => {
  const e = env({ mine: 1_000_000, site: 1_000_000 });
  e.RATE_LIMITER = { limit: async () => ({ success: false }) };
  for (let i = 0; i < 500; i++) {
    await enforceRateLimit(e, { id: ADMIN });
    await enforceDailyLimits(e, { id: ADMIN }, dayOf(5));
  }
});

test("the minute limit applies to everyone else, and to the account rather than the key", async () => {
  const keys = [];
  const e = env();
  e.RATE_LIMITER = { limit: async ({ key }) => (keys.push(key), { success: false }) };
  await assert.rejects(enforceRateLimit(e, { id: 7 }), blocked("too_many_requests"));
  assert.deepEqual(keys, ["u:7"]);
});

test("if daily usage cannot be read, requests continue under the minute limit", async () => {
  const e = env();
  e.DB.prepare = () => {
    throw new Error("D1 down");
  };
  const original = console.error;
  console.error = () => {};
  await enforceDailyLimits(e, { id: 8 }, dayOf(6));
  console.error = original;
});

test("anonymous limits are per address, and the address is only a limiter key", async () => {
  const keys = [];
  const e = { ANON_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: key === "ip:1.1.1.1" }) } };
  const from = (ip) => new Request("https://x.test/", { headers: ip ? { "CF-Connecting-IP": ip } : {} });
  assert.equal(await anonymousRetryAfter(e, from("1.1.1.1")), 0);
  assert.equal(await anonymousRetryAfter(e, from("2.2.2.2")), 60);
  assert.equal(await anonymousRetryAfter(e, from(null)), 0);
  assert.deepEqual(keys, ["ip:1.1.1.1", "ip:2.2.2.2"]);
});

test("secondsUntilUtcMidnight and utcDay use UTC days", () => {
  assert.equal(secondsUntilUtcMidnight(Date.UTC(2031, 0, 1, 23, 59, 30)), 30);
  assert.equal(utcDay(Date.UTC(2031, 0, 1, 23, 59)), "2031-01-01");
});

const opts = (q) => parseSearchParams(new URLSearchParams({ q })).value;

test("an account over its AI allowance uses rules while others keep AI", async () => {
  const over = env({ userNeurons: 500 });
  const r = await interpretQuery(opts("alpha beta one"), { env: over, user: { id: 20 } });
  assert.equal(r.aiStatus, "user_budget_exhausted");
  assert.equal(over.models.length, 0);
  const fine = env({ userNeurons: 10 });
  assert.equal((await interpretQuery(opts("alpha beta one"), { env: fine, user: { id: 21 } })).aiStatus, "ai");
});

test("the admin account ignores both AI budgets and always gets the primary model", async () => {
  const e = env({ neurons: 999_999, userNeurons: 999_999 });
  const r = await interpretQuery(opts("alpha beta two"), { env: e, user: { id: ADMIN } });
  assert.equal(r.aiStatus, "ai");
  assert.deepEqual(e.models, [MODELS.primary.id]);
});

test("a plan remembered for one account is not used or revealed for another", async () => {
  const e = env();
  await interpretQuery(opts("alpha beta three"), { env: e, user: { id: 30 } });
  assert.equal((await interpretQuery(opts("alpha beta three"), { env: e, user: { id: 30 } })).aiStatus, "ai_cached");
  assert.equal((await interpretQuery(opts("alpha beta three"), { env: e, user: { id: 31 } })).aiStatus, "ai", "another account does a fresh lookup");
  assert.equal(e.models.length, 2);
});

test("an unusable AI answer is not remembered", async () => {
  const e = env();
  let good = false;
  e.AI.run = async () => ({ response: good ? { key_terms: ["alpha", "beta"] } : "nonsense", usage: { prompt_tokens: 1, completion_tokens: 1 } });
  assert.equal((await interpretQuery(opts("alpha beta four"), { env: e, user: { id: 32 } })).aiStatus, "ai_invalid");
  good = true;
  assert.equal((await interpretQuery(opts("alpha beta four"), { env: e, user: { id: 32 } })).aiStatus, "ai");
});

// ---------- Nothing crosses between accounts ----------

function fakeFetch(handler) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const token = init.headers.Authorization.replace("Bearer ", "");
    seen.push(token);
    return handler(token, String(url));
  };
  return { seen, restore: () => (globalThis.fetch = original) };
}
const reposFor = (name) => new Response(JSON.stringify({ total_count: 1, incomplete_results: false, items: [{ id: 1, full_name: `${name}/kanban`, description: "kanban", stargazers_count: 500 }] }));

test("a cached search belongs to one account", async () => {
  const f = fakeFetch((token) => reposFor(token));
  try {
    const search = (userId, token) => searchRepositories(opts("kanban private test"), { token, env: {}, origin: null, userId });
    const a = await search(40, "tok-a");
    const b = await search(41, "tok-b");
    assert.equal(a.items[0].name, "tok-a/kanban");
    assert.equal(b.items[0].name, "tok-b/kanban", "not the first user's cached answer");
    assert.equal(b.cached, false);
    assert.equal((await search(40, "tok-a")).cached, true);
  } finally {
    f.restore();
  }
});

test("simultaneous identical searches each get their own GitHub answer or error", async () => {
  const f = fakeFetch(async (token) => {
    await new Promise((r) => setTimeout(r, 20));
    return token === "bad" ? new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }) : reposFor(token);
  });
  try {
    const search = (userId, token) => searchRepositories(opts("kanban simultaneous test"), { token, env: {}, origin: null, userId });
    const [bad, good] = await Promise.allSettled([search(50, "bad"), search(51, "good")]);
    assert.equal(bad.status, "rejected");
    assert.equal(good.status, "fulfilled", "the valid user is not told to sign in again");
    assert.equal(good.value.items[0].name, "good/kanban");
  } finally {
    f.restore();
  }
});

test("a partial answer from a failed widening is returned but not cached", async () => {
  let n = 0;
  const f = fakeFetch(() => (n++ === 0 ? reposFor("first") : new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403, headers: { "x-ratelimit-remaining": "0" } })));
  const original = console.error;
  console.error = () => {};
  try {
    const search = () => searchRepositories(opts("lightweight kanban partial test"), { token: "t", env: {}, origin: null, userId: 60 });
    assert.equal((await search()).incomplete, true);
    n = 0;
    assert.equal((await search()).cached, false);
  } finally {
    console.error = original;
    f.restore();
  }
});

test("a README is read only up to the cap and cached per account", async () => {
  let pulled = 0;
  const big = () =>
    new ReadableStream({
      pull(c) {
        pulled += 65536;
        if (pulled > 40_000_000) return c.close();
        c.enqueue(new Uint8Array(65536).fill(120));
      },
    });
  const f = fakeFetch(() => new Response(big()));
  try {
    const r = await getReadme({ owner: "big", name: "file" }, 200, { token: "t", env: {}, userId: 70 });
    assert.equal(r.text.length, 200);
    assert.equal(r.truncated, true);
    assert.ok(pulled < 1_000_000, `read ${pulled} bytes`);
    const most = await getReadme({ owner: "big", name: "file" }, MAX_README_CHARS, { token: "t", env: {}, userId: 70 });
    assert.equal(most.text.length, MAX_README_CHARS);
    assert.equal(f.seen.length, 1, "second read is cached");
    await getReadme({ owner: "big", name: "file" }, 200, { token: "t2", env: {}, userId: 71 });
    assert.equal(f.seen.length, 2, "another account fetches its own copy");
  } finally {
    f.restore();
  }
});

test("a secondary GitHub limit on a README is a 429, not a 502", async () => {
  const f = fakeFetch(() => new Response("You have exceeded a secondary rate limit", { status: 403, headers: { "retry-after": "33" } }));
  try {
    await assert.rejects(getReadme({ owner: "a", name: "limited" }, 200, { token: "t", env: {}, userId: 72 }), (e) => e.status === 429 && e.extra.retryAfter === 33);
  } finally {
    f.restore();
  }
});

test("bodies over the limit are refused without being read", async () => {
  let pulled = 0;
  const stream = () =>
    new ReadableStream({
      pull(c) {
        pulled += 1024;
        if (pulled > 1_000_000) return c.close();
        c.enqueue(new Uint8Array(1024));
      },
    });
  assert.equal((await readStream(stream(), 2048)).cut, true);
  assert.ok(pulled < 20_000);
  const declared = new Request("https://x.test/", { method: "POST", body: "x", headers: { "Content-Length": "999999" } });
  assert.equal(await readBody(declared, 100), null);
  assert.equal(await readBody(new Request("https://x.test/", { method: "POST", body: "hello" }), 100), "hello");
  assert.equal(await readBody(new Request("https://x.test/", { method: "POST", body: "x".repeat(101) }), 100), null);
  assert.equal(await readBody(new Request("https://x.test/"), 100), "");
});

test("typed text cannot become a GitHub qualifier or swallow the filters", () => {
  const f = { minStars: 100, language: null, includeArchived: false };
  const q = (s) => buildQuery(parseQuery(s), f, "strict");
  assert.equal(q('"stars:>0" kanban'), '"stars:>0" kanban stars:>=100 archived:false');
  assert.equal(q('"-foo"'), '"-foo" stars:>=100 archived:false');
  assert.equal(q('kanban topic:"foo'), "kanban topic:foo stars:>=100 archived:false");
  assert.equal(q('kanban topic:"two words"'), 'kanban topic:"two words" stars:>=100 archived:false');
  assert.equal(q("self-hosted c++"), "self-hosted c++ stars:>=100 archived:false");
});

test("maintenance runs every clean-up step even if one fails", async () => {
  const seen = [];
  const e = {
    DB: {
      prepare: (sql) => ({
        bind: (...args) => ({
          run: async () => {
            seen.push({ sql, args });
            if (/FROM sessions/.test(sql)) throw new Error("boom");
            return { meta: {} };
          },
        }),
      }),
    },
  };
  const original = console.error;
  console.error = () => {};
  const now = Date.UTC(2031, 5, 1);
  await runMaintenance(e, now);
  console.error = original;
  const has = (re) => seen.some((s) => re.test(s.sql));
  for (const re of [/DELETE FROM api_calls WHERE ts/, /SELECT MAX\(id\)/, /PARTITION BY user_id/, /DELETE FROM key_usage/, /DELETE FROM sessions/, /DELETE FROM user_daily/, /DELETE FROM ai_usage/]) assert.ok(has(re), String(re));
  assert.equal(seen.find((s) => /WHERE ts/.test(s.sql)).args[0], now - 90 * 86_400_000);
});
