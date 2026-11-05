// Runs repository searches against the GitHub API using the signed-in user's token.
//
// Strategy (usually 1 GitHub call, at most 4):
//  1. Strict: every keyword must match, star filter applied, GitHub sorts by stars.
//  2. If that finds fewer than STRICT_MIN_RESULTS and there are 2+ keywords, collect GitHub's most
//     relevant candidates for the key terms ("core": all key terms; "any": any key term), filter
//     them with selectRelaxed(), merge with the strict matches and rank everything by stars.

import { buildQuery, selectRelaxed, simplifyRepo, isLikelySpam, MAX_REACHABLE_RESULTS } from "../public/lib/query.js";
import { sha256Hex } from "./crypto.js";
import { githubApiBase, USER_AGENT } from "./config.js";

export const STRICT_MIN_RESULTS = 10;
export const BROAD_CANDIDATES = 50;
const CACHE_TTL_SECONDS = 600;
const MEMORY_CACHE_MAX = 200;

export class GitHubError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** Search with caching. Results contain only public data, so the cache is shared by all users. */
export async function searchRepositories(opts, { token, env, ctx, origin }) {
  const key = await sha256Hex(
    JSON.stringify([
      opts.parsed.keywords,
      opts.parsed.qualifiers,
      opts.minStars,
      opts.language,
      opts.includeArchived,
      opts.page,
      opts.perPage,
    ]),
  );

  const cached = await cacheGet(key, origin);
  if (cached) return { ...cached, cached: true, rateLimit: null };

  // Identical searches arriving at the same time share one set of GitHub calls.
  let pending = inflight.get(key);
  const leader = !pending;
  if (leader) {
    pending = runSearch(opts, token, env).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const { rateLimit, ...result } = await pending;
  if (leader) {
    const put = cachePut(key, origin, result);
    if (ctx?.waitUntil) ctx.waitUntil(put);
    else await put;
  }
  return { ...result, cached: !leader, rateLimit: leader ? rateLimit : null };
}

const inflight = new Map();

async function runSearch({ parsed, minStars, language, includeArchived, page, perPage }, token, env) {
  const filters = { minStars, language, includeArchived };
  const strictQuery = buildQuery(parsed, filters, "strict");
  const strict = await githubSearch(strictQuery, { sortByStars: true, page, perPage }, token, env);
  let rateLimit = strict.rateLimit;

  const strictResult = () => ({
    mode: "strict",
    matchLevel: "all_keywords",
    total: strict.total,
    page,
    perPage,
    hasMore: page * perPage < Math.min(strict.total, MAX_REACHABLE_RESULTS),
    incomplete: strict.incomplete,
    items: strict.items.map(simplifyRepo),
    rateLimit,
  });

  const keywordCount = parsed.keywords.length;
  if (keywordCount < 2 || strict.total >= STRICT_MIN_RESULTS) return strictResult();

  // Build both queries up front so an over-long query fails before any extra GitHub calls.
  const hasSoft = parsed.soft.length > 0;
  const coreQuery = hasSoft ? buildQuery(parsed, filters, "core") : null;
  const anyQuery = !hasSoft || parsed.core.length >= 3 ? buildQuery(parsed, filters, "any") : null;

  try {
    // All strict matches (fewer than STRICT_MIN_RESULTS) are needed for merging.
    let strictAll = strict.items;
    let incomplete = strict.incomplete;
    if (page !== 1 || strict.items.length < strict.total) {
      const again = await githubSearch(strictQuery, { sortByStars: true, page: 1, perPage: STRICT_MIN_RESULTS }, token, env);
      strictAll = again.items;
      rateLimit = again.rateLimit;
    }

    // "core" (all key terms) is fetched by stars: those are the projects we would rank first anyway.
    // "any" (any key term) uses GitHub's best-match order; sorted by stars it would only return
    // huge repos that happen to contain one of the words.
    const candidates = [];
    for (const [q, sortByStars] of [[coreQuery, true], [anyQuery, false]]) {
      if (!q) continue;
      const res = await githubSearch(q, { sortByStars, page: 1, perPage: BROAD_CANDIDATES }, token, env);
      candidates.push(...res.items);
      rateLimit = res.rateLimit;
      incomplete ||= res.incomplete;
    }

    const { level, items: ranked } = selectRelaxed(strictAll, candidates, parsed);
    const start = (page - 1) * perPage;

    return {
      mode: "broad",
      matchLevel: level,
      total: ranked.length,
      page,
      perPage,
      hasMore: start + perPage < ranked.length,
      incomplete,
      items: ranked.slice(start, start + perPage).map(simplifyRepo),
      rateLimit,
    };
  } catch (err) {
    // If widening fails (e.g. rate limit) but strict found something, return that instead of an error.
    if (err instanceof GitHubError && err.status !== 401 && strict.total > 0) return strictResult();
    throw err;
  }
}

async function githubSearch(q, { sortByStars, page, perPage }, token, env) {
  const url = new URL(`${githubApiBase(env)}/search/repositories`);
  url.searchParams.set("q", q);
  if (sortByStars) {
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
  }
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    console.error("GitHub search request failed", String(err));
    throw new GitHubError(502, "Could not reach GitHub. Please try again.", { code: "github_unreachable" });
  }

  const rateLimit = {
    limit: toNumber(res.headers.get("x-ratelimit-limit")),
    remaining: toNumber(res.headers.get("x-ratelimit-remaining")),
    reset: toNumber(res.headers.get("x-ratelimit-reset")),
  };
  const body = await res.json().catch(() => null);

  if (res.ok) {
    return {
      total: Number(body?.total_count) || 0,
      incomplete: Boolean(body?.incomplete_results),
      items: Array.isArray(body?.items) ? body.items.filter((r) => !isLikelySpam(r)) : [],
      rateLimit,
    };
  }

  if (res.status === 401) {
    throw new GitHubError(401, "Your GitHub authorization expired or was revoked. Please sign in again.", {
      code: "github_reauth",
    });
  }

  const message = String(body?.message ?? "");
  const retryAfterHeader = toNumber(res.headers.get("retry-after"));
  if (res.status === 429 || (res.status === 403 && (rateLimit.remaining === 0 || retryAfterHeader !== null || /rate limit/i.test(message)))) {
    const retryAfter =
      retryAfterHeader ?? (rateLimit.reset ? Math.max(1, rateLimit.reset - Math.floor(Date.now() / 1000)) : 60);
    throw new GitHubError(429, `GitHub's rate limit for your account was reached. Try again in ${retryAfter} seconds.`, {
      code: "rate_limited",
      retryAfter,
    });
  }

  if (res.status === 422) {
    const detail = body?.errors?.[0]?.message || message || "invalid query";
    throw new GitHubError(400, `GitHub could not run this search: ${detail}`, { code: "invalid_query" });
  }

  console.error("GitHub search error", res.status, message);
  throw new GitHubError(502, `GitHub returned an error (${res.status}). Please try again.`, { code: "github_error" });
}

function toNumber(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- Cache: per-isolate memory first, then Cloudflare's edge cache ----------

const memoryCache = new Map();

async function cacheGet(key, origin) {
  const hit = memoryCache.get(key);
  if (hit) {
    if (hit.expires > Date.now()) return hit.value;
    memoryCache.delete(key);
  }
  try {
    if (typeof caches === "undefined" || !origin) return null;
    const res = await caches.default.match(cacheRequest(key, origin));
    if (!res) return null;
    const value = await res.json();
    rememberInMemory(key, value);
    return value;
  } catch {
    return null;
  }
}

async function cachePut(key, origin, value) {
  rememberInMemory(key, value);
  try {
    if (typeof caches === "undefined" || !origin) return;
    await caches.default.put(
      cacheRequest(key, origin),
      new Response(JSON.stringify(value), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}` },
      }),
    );
  } catch {
    // The edge cache is best-effort.
  }
}

function rememberInMemory(key, value) {
  memoryCache.set(key, { value, expires: Date.now() + CACHE_TTL_SECONDS * 1000 });
  while (memoryCache.size > MEMORY_CACHE_MAX) memoryCache.delete(memoryCache.keys().next().value);
}

function cacheRequest(key, origin) {
  return new Request(`${origin}/__cache/search/${key}`);
}
