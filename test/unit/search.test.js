import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { searchRepositories, GitHubError, BROAD_CANDIDATES, STRICT_MIN_RESULTS } from "../../src/search.js";
import { parseSearchParams } from "../../public/lib/query.js";

const realFetch = globalThis.fetch;
let calls;
let handler;

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, headers: init?.headers ?? {} });
    return handler(url, init);
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const repo = (id, stars, description, topics = []) => ({
  id,
  full_name: `owner/repo${id}`,
  html_url: `https://github.com/owner/repo${id}`,
  description,
  topics,
  stargazers_count: stars,
  forks_count: 1,
  language: "TypeScript",
  archived: false,
});

const ok = (items, total = items.length, headers = {}) =>
  new Response(JSON.stringify({ total_count: total, incomplete_results: false, items }), {
    status: 200,
    headers: { "content-type": "application/json", "x-ratelimit-limit": "30", "x-ratelimit-remaining": "29", ...headers },
  });

const opts = (qs) => {
  const r = parseSearchParams(new URLSearchParams(qs));
  assert.equal(r.ok, true, r.error);
  return r.value;
};
const run = (qs) => searchRepositories(opts(qs), { token: "tok", env: {}, origin: null });
const isBroad = (url) => url.searchParams.get("q").includes(" OR ");

test("strict mode: enough exact matches means one call sorted by stars", async () => {
  handler = () => ok([repo(1, 900, "kanban markdown"), repo(2, 500, "kanban markdown")], 1500);
  const r = await run("q=kanban markdown strict-case-1");
  assert.equal(calls.length, 1);
  const u = calls[0].url;
  assert.equal(u.pathname, "/search/repositories");
  assert.equal(u.searchParams.get("q"), "kanban markdown strict-case-1 stars:>=100 archived:false");
  assert.equal(u.searchParams.get("sort"), "stars");
  assert.equal(u.searchParams.get("order"), "desc");
  assert.equal(u.searchParams.get("per_page"), "20");
  assert.equal(calls[0].headers.Authorization, "Bearer tok");
  assert.equal(calls[0].headers["User-Agent"], "CodeSearch");
  assert.equal(r.mode, "strict");
  assert.equal(r.total, 1500);
  assert.equal(r.hasMore, true);
  assert.equal(r.cached, false);
  assert.equal(r.rateLimit.remaining, 29);
  assert.deepEqual(r.items.map((i) => i.stars), [900, 500]);
});

test("strict hasMore stops at GitHub's 1000-result cap", async () => {
  handler = () => ok([repo(1, 900, "x")], 5000);
  const r = await run("q=capcheck one&page=20&per_page=50");
  assert.equal(r.hasMore, false);
});

test("relaxed: descriptive words present -> fetches all key terms sorted by stars, then filters", async () => {
  const strictItems = [repo(1, 300, "lightweight kanban with markdown notes")];
  const coreItems = [
    repo(1, 300, "lightweight kanban with markdown notes"), // duplicate of the exact match
    repo(2, 9000, "Lightweight kanban board in markdown"), // key terms + descriptive word
    repo(3, 50000, "Kanban app", ["markdown"]), // key terms only (via topic)
    repo(4, 700, "markdown kanban, lightweight"), // key terms + descriptive word
    repo(5, 120, "markdown editor"), // missing "kanban" -> never shown
  ];
  handler = (url) => (url.searchParams.get("q").startsWith("lightweight") ? ok(strictItems, 1) : ok(coreItems, 40));
  const r = await run("q=lightweight kanban markdown");

  assert.equal(calls.length, 2, "2 key terms: no OR query needed");
  const coreCall = calls[1].url;
  assert.equal(coreCall.searchParams.get("q"), "kanban markdown stars:>=100 archived:false");
  assert.equal(coreCall.searchParams.get("sort"), "stars");
  assert.equal(coreCall.searchParams.get("per_page"), String(BROAD_CANDIDATES));
  assert.equal(r.mode, "broad");
  // Only 3 projects have a descriptive word too (< 5), so the rule loosens to key terms only.
  assert.equal(r.matchLevel, "key_terms");
  assert.deepEqual(r.items.map((i) => i.stars), [50000, 9000, 700, 300]);
  assert.equal(r.total, 4);
});

test("relaxed: no descriptive words -> OR query in best-match order, keeps projects with most key terms", async () => {
  const strictAll = [repo(10, 400, "alpha beta gamma"), repo(11, 200, "alpha beta gamma")];
  const anyItems = [
    repo(12, 1000, "alpha beta"),
    repo(13, 800, "beta gamma"),
    repo(14, 600, "alpha gamma"),
    repo(15, 90000, "alpha only"), // 1 of 3 -> dropped
  ];
  handler = (url) => {
    if (isBroad(url)) return ok(anyItems, 100);
    return Number(url.searchParams.get("page")) === 1 ? ok(strictAll, 2) : ok([], 2);
  };
  const r = await run("q=alpha beta gamma&page=2&per_page=2");

  assert.equal(calls.length, 3, "strict page 2, strict page 1 refetch, OR query");
  assert.equal(calls[1].url.searchParams.get("page"), "1");
  assert.equal(calls[1].url.searchParams.get("per_page"), String(STRICT_MIN_RESULTS));
  assert.equal(calls[2].url.searchParams.get("q"), "alpha OR beta OR gamma stars:>=100 archived:false");
  assert.equal(calls[2].url.searchParams.get("sort"), null, "best-match order");
  assert.equal(r.matchLevel, "most_key_terms");
  assert.equal(r.total, 5);
  assert.deepEqual(r.items.map((i) => i.stars), [600, 400], "page 2 of [1000, 800, 600, 400, 200]");
  assert.equal(r.hasMore, true);
});

test("relaxed: 3+ key terms and descriptive words -> both candidate queries", async () => {
  handler = () => ok([], 0);
  const r = await run("q=fast alpha beta gamma");
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url.searchParams.get("q"), "alpha beta gamma stars:>=100 archived:false");
  assert.equal(calls[1].url.searchParams.get("sort"), "stars");
  assert.equal(calls[2].url.searchParams.get("q"), "alpha OR beta OR gamma stars:>=100 archived:false");
  assert.equal(calls[2].url.searchParams.get("sort"), null);
  assert.equal(r.total, 0);
  assert.deepEqual(r.items, []);
});

test("keyword-stuffed spam repos are removed from every result set", async () => {
  handler = () => ok([repo(1, 99999, "spam ".repeat(400)), repo(2, 500, "real project")], 500);
  const r = await run("q=spam filter check");
  assert.deepEqual(r.items.map((i) => i.name), ["owner/repo2"]);
});

test("a single keyword never triggers the broad pass", async () => {
  handler = () => ok([repo(1, 150, "lonely")], 1);
  const r = await run("q=lonelyword");
  assert.equal(calls.length, 1);
  assert.equal(r.mode, "strict");
});

test("if the broad pass hits the rate limit, strict results are still returned", async () => {
  handler = (url) =>
    isBroad(url)
      ? new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) },
        })
      : ok([repo(1, 300, "fallback case")], 1);
  const r = await run("q=fallback case words");
  assert.equal(r.mode, "strict");
  assert.equal(r.items.length, 1);
});

test("rate limit with nothing to fall back on becomes a 429 with retryAfter", async () => {
  handler = () =>
    new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 42) },
    });
  await assert.rejects(run("q=limited query"), (err) => {
    assert.ok(err instanceof GitHubError);
    assert.equal(err.status, 429);
    assert.equal(err.extra.code, "rate_limited");
    assert.ok(err.extra.retryAfter >= 40 && err.extra.retryAfter <= 42);
    return true;
  });
});

test("secondary rate limit with Retry-After header", async () => {
  handler = () => new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit" }), { status: 403, headers: { "retry-after": "17" } });
  await assert.rejects(run("q=secondary"), (err) => err.status === 429 && err.extra.retryAfter === 17);
});

test("revoked GitHub token -> 401 asking to sign in again (no fallback)", async () => {
  handler = () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 });
  await assert.rejects(run("q=revoked token"), (err) => err.status === 401 && err.extra.code === "github_reauth");
});

test("GitHub validation error -> 400", async () => {
  handler = () =>
    new Response(JSON.stringify({ message: "Validation Failed", errors: [{ message: "bad qualifier" }] }), { status: 422 });
  await assert.rejects(run("q=validation"), (err) => err.status === 400 && /bad qualifier/.test(err.message));
});

test("other GitHub errors and network failures -> 502", async () => {
  handler = () => new Response("oops", { status: 500 });
  await assert.rejects(run("q=server error"), (err) => err.status === 502);
  handler = () => {
    throw new TypeError("network down");
  };
  await assert.rejects(run("q=network error"), (err) => err.status === 502 && err.extra.code === "github_unreachable");
});

test("identical searches are served from cache without calling GitHub", async () => {
  handler = () => ok([repo(1, 999, "cache me")], 50);
  const first = await run("q=cache me please");
  const second = await run("q=cache me please");
  assert.equal(calls.length, 1);
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(second.rateLimit, null);
  assert.deepEqual(second.items, first.items);
  await run("q=cache me please&min_stars=500");
  assert.equal(calls.length, 2, "different filters are cached separately");
});
