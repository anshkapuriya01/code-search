// Runs repository searches against the GitHub API using the signed-in user's token.
//
// Strategy (1 to 4 GitHub calls, each for up to 100 candidates sorted by stars):
//  1. strict: every keyword must match.
//  2. core:   only the key terms, when the request has descriptive words ("self-hosted", "python",
//             "library") and the strict search did not already fill the pool. Projects that are what
//             was asked for often never use the descriptive word ("mail server" vs "self-hosted").
//  3. alt:    the key terms with a related concept swapped in ("email" -> "mail server"); up to two.
//  4. any:    GitHub's best matches for any key term, only when fewer than STRICT_MIN_RESULTS fit.
// Candidates are then filtered and ordered by rankResults(): how well the name, topics and opening
// of the description match the request, then stars. The ranked list is cached and paged locally.

import { buildQuery, rankResults, simplifyRepo, isLikelySpam } from "../public/lib/query.js";
import { sha256Hex } from "./crypto.js";
import { githubApiBase, githubTimeout, USER_AGENT } from "./config.js";

export const STRICT_MIN_RESULTS = 10;
export const POOL_CANDIDATES = 100; // GitHub's maximum per_page
export const ALT_CANDIDATES = 50;
export const BROAD_CANDIDATES = 50;
export const MAX_RESULTS = 100; // ranked results kept per search (and paged through)
const CACHE_VERSION = 4; // bump when the cached shape or ranking changes
const CACHE_TTL_SECONDS = 600;
const MEMORY_CACHE_MAX = 60;
const WIDENING_DEADLINE_MS = 15_000; // no extra GitHub calls after this; what was found so far is returned

export class GitHubError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/** True when GitHub's answer means a rate limit, including its secondary limits. */
export function isGitHubRateLimit(res, message) {
  if (res.status === 429) return true;
  return res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after") || /rate limit/i.test(message));
}

/**
 * Search with caching. The cache is private to each account (a query such as user:@me means something different
 * for each person), and nothing in flight is shared, so one user's results or GitHub errors never reach another.
 */
export async function searchRepositories(opts, { token, env, ctx, origin, userId }) {
  const key = await sha256Hex(
    JSON.stringify([
      CACHE_VERSION,
      userId ?? null,
      opts.parsed.keywords,
      opts.parsed.core,
      opts.parsed.synonyms ?? null,
      opts.parsed.altSearches ?? null,
      opts.parsed.qualifiers,
      opts.minStars,
      opts.language,
      opts.includeArchived,
    ]),
  );

  let full = await cacheGet(key, origin);
  const cached = Boolean(full);
  let rateLimit = null;
  if (!full) {
    const { rateLimit: rl, ...result } = await runSearch(opts, token, env);
    full = result;
    rateLimit = rl;
    if (!result.incomplete) {
      const put = cachePut(key, origin, result); // a partial answer is not worth keeping for ten minutes
      if (ctx?.waitUntil) ctx.waitUntil(put);
      else await put;
    }
  }

  const { page, perPage } = opts;
  const start = (page - 1) * perPage;
  return {
    mode: full.mode,
    matchLevel: full.matchLevel,
    total: full.items.length,
    page,
    perPage,
    hasMore: start + perPage < full.items.length,
    incomplete: full.incomplete,
    items: full.items.slice(start, start + perPage),
    cached,
    rateLimit,
  };
}

/** Every GitHub query for a request. Throws QueryError if one is too long, before any GitHub call. */
export function buildQueries(parsed, filters) {
  const strict = buildQuery(parsed, filters, "strict");
  const core = parsed.soft.length ? buildQuery(parsed, filters, "core") : null;
  const seen = new Set([strict, core]);
  const alts = [];
  for (const altTerms of parsed.altSearches ?? []) {
    const q = buildQuery({ ...parsed, altTerms }, filters, "alt");
    if (!seen.has(q)) alts.push(q);
    seen.add(q);
  }
  const any = parsed.core.length >= 2 ? buildQuery(parsed, filters, "any") : null;
  return { strict, core, alts, any };
}

async function runSearch({ parsed, minStars, language, includeArchived }, token, env) {
  const filters = { minStars, language, includeArchived };
  const { strict: strictQuery, core: coreQuery, alts: altQueries, any: anyQuery } = buildQueries(parsed, filters);

  const strict = await githubSearch(strictQuery, { sortByStars: true, perPage: POOL_CANDIDATES }, token, env);
  let rateLimit = strict.rateLimit;
  let incomplete = strict.incomplete;
  let mode = "strict";
  const trusted = new Set(strict.items.map((r) => r.id));
  const candidates = [...strict.items];
  const scores = new Map(); // ranking runs twice over mostly the same repositories; score each only once
  const deadline = Date.now() + WIDENING_DEADLINE_MS;

  const fetchMore = async (q, sortByStars, perPage) => {
    if (Date.now() > deadline) throw new GitHubError(504, "GitHub took too long to answer. Please try again.", { code: "github_timeout" });
    const res = await githubSearch(q, { sortByStars, perPage }, token, env);
    candidates.push(...res.items);
    rateLimit = res.rateLimit;
    incomplete ||= res.incomplete;
    mode = "broad";
  };

  try {
    if (coreQuery && coreQuery !== strictQuery && strict.total < POOL_CANDIDATES) {
      await fetchMore(coreQuery, true, POOL_CANDIDATES);
    }
    for (const altQuery of altQueries) await fetchMore(altQuery, true, ALT_CANDIDATES);
    // "any" uses GitHub's best-match order; sorted by stars it would only return huge repos that
    // happen to contain one of the words.
    if (anyQuery && rankResults(candidates, parsed, { trusted, scores }).items.length < STRICT_MIN_RESULTS) {
      await fetchMore(anyQuery, false, BROAD_CANDIDATES);
    }
  } catch (err) {
    // If widening fails (e.g. rate limit) but something was found, return that instead of an error.
    if (!(err instanceof GitHubError) || err.status === 401 || !candidates.length) throw err;
    incomplete = true;
  }

  const { level, items } = rankResults(candidates, parsed, { trusted, scores });
  return {
    mode,
    matchLevel: level,
    incomplete,
    items: items.slice(0, MAX_RESULTS).map(simplifyRepo),
    rateLimit,
  };
}

async function githubSearch(q, { sortByStars, page = 1, perPage }, token, env) {
  const url = new URL(`${githubApiBase(env)}/search/repositories`);
  url.searchParams.set("q", q);
  if (sortByStars) {
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
  }
  url.searchParams.set("page", String(page));
  url.searchParams.set("per_page", String(perPage));

  let res;
  let body;
  try {
    res = await fetch(url, {
      signal: githubTimeout(),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${token}`,
      },
    });
    body = await res.json().catch((err) => {
      if (err?.name === "TimeoutError") throw err;
      return null;
    });
  } catch (err) {
    console.error("GitHub search request failed", String(err));
    if (err?.name === "TimeoutError") throw new GitHubError(504, "GitHub took too long to answer. Please try again.", { code: "github_timeout" });
    throw new GitHubError(502, "Could not reach GitHub. Please try again.", { code: "github_unreachable" });
  }

  const rateLimit = {
    limit: toNumber(res.headers.get("x-ratelimit-limit")),
    remaining: toNumber(res.headers.get("x-ratelimit-remaining")),
    reset: toNumber(res.headers.get("x-ratelimit-reset")),
  };

  if (res.ok) {
    if (!body) throw new GitHubError(502, "GitHub returned an unreadable answer. Please try again.", { code: "github_error" });
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
  if (isGitHubRateLimit(res, message)) {
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
