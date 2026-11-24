// Trending library: hand-picked repositories grouped by use case ("Web scraping", "Self-hosted analytics").
// The admin adds them in the console. When a search matches a use case's keywords, its repositories are shown
// first, marked trending, ahead of GitHub's results. A snapshot of each repository (stars, description, ...)
// is stored, so pinning costs no GitHub calls; the daily cron and the console's Refresh button update it.

import { canonicalize, simplifyRepo, stem } from "../public/lib/query.js";
import { githubApiBase, githubTimeout, USER_AGENT } from "./config.js";
import { GitHubError, isGitHubRateLimit } from "./search.js";
import { parseRepo } from "./readme.js";
import { TtlCache } from "./memo.js";
import { withAppTables } from "./schema.js";

export const MAX_ENTRIES = 500;
export const MAX_PINNED = 10; // trending results shown ahead of the rest, at most
export const MAX_KEYWORDS = 30;
export const MAX_KEYWORD_LENGTH = 50;
export const MAX_USE_CASE_LENGTH = 60;
const LIBRARY_TTL_MS = 30_000;
const cache = new TtlCache(1);

export class TrendingError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

// ---------- Matching (pure) ----------

/** Lower-cased words, with known phrases rewritten the same way search does ("self hosted" -> "self-hosted"). */
function words(text) {
  return canonicalize(text)
    .replace(/[^\p{L}\p{N}+#.]+/gu, " ")
    .replace(/(^|\s)\.+|\.+(?=\s|$)/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

const stemmed = (text) => ` ${words(text).map(stem).join(" ")} `;

/** Splits keywords given as an array or as comma/newline separated text. Lower-cased, trimmed, unique. */
export function parseKeywords(input) {
  const list = Array.isArray(input) ? input : String(input ?? "").split(/[,\n]/);
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const k = raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (k && k.length <= MAX_KEYWORD_LENGTH && !out.includes(k)) out.push(k);
  }
  return out.slice(0, MAX_KEYWORDS);
}

/** Every word the search understood: the user's own text, the key terms, descriptive words and AI synonyms. */
function searchText({ input, parsed }) {
  const synonyms = Object.values(parsed?.synonyms ?? {}).flat();
  return stemmed([input, ...(parsed?.keywords ?? []), ...synonyms, ...(parsed?.altSearches ?? []).flat()].join(" "));
}

/**
 * The library entries a search should show first, best match first. An entry matches when its use case name or
 * one of its keywords appears in the search as a whole word or phrase ("scraper" also matches "scrapers").
 * Filters still apply: a language filter and archived projects (unless include_archived) are respected.
 */
export function matchTrending(entries, { input, parsed, language, includeArchived }) {
  const haystack = searchText({ input, parsed });
  if (!haystack.trim()) return [];
  const lang = language ? String(language).toLowerCase() : null;
  const scored = [];
  for (const e of entries) {
    const d = e.data;
    if (!d?.name) continue;
    if (lang && String(d.language ?? "").toLowerCase() !== lang) continue;
    if (d.archived && !includeArchived) continue;
    let score = 0;
    for (const term of [e.useCase, ...e.keywords]) {
      const t = stemmed(term);
      if (t.trim() && haystack.includes(t)) score++;
    }
    if (score) scored.push({ e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.e.position - b.e.position || (b.e.data.stars ?? 0) - (a.e.data.stars ?? 0) || a.e.id - b.e.id);
  const seen = new Set();
  const out = [];
  for (const { e } of scored) {
    const key = e.data.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...e.data, trending: true, useCase: e.useCase });
    if (out.length >= MAX_PINNED) break;
  }
  return out;
}

// ---------- Storage ----------

function rowToEntry(r) {
  let keywords = [];
  let data = null;
  try {
    keywords = JSON.parse(r.keywords);
  } catch {
    // a broken row matches nothing
  }
  try {
    data = JSON.parse(r.data);
  } catch {
    // a broken row is skipped by matchTrending
  }
  return {
    id: r.id,
    useCase: r.use_case,
    repo: r.repo,
    keywords: Array.isArray(keywords) ? keywords : [],
    position: r.position,
    data,
    addedAt: r.added_at,
    addedBy: r.added_by,
    refreshedAt: r.refreshed_at,
  };
}

export async function listTrending(env) {
  const { results } = await withAppTables(env, () =>
    env.DB.prepare("SELECT * FROM trending_repos ORDER BY use_case COLLATE NOCASE, position, id").all(),
  );
  return results.map(rowToEntry);
}

/** The library for searches: cached for 30 seconds per isolate. */
export async function loadLibrary(env) {
  const hit = cache.get("all");
  if (hit) return hit;
  const entries = await listTrending(env);
  cache.set("all", entries, LIBRARY_TTL_MS);
  return entries;
}

export const forgetLibrary = () => cache.delete("all");

/** Trending repositories for one search. Never throws: a library problem must not break search. */
export async function trendingFor(env, opts) {
  if (!env?.DB) return [];
  try {
    return matchTrending(await loadLibrary(env), opts);
  } catch (err) {
    console.error("Trending library unavailable", String(err));
    return [];
  }
}

/** Checks and normalises what the console sent. Throws TrendingError with a message for the admin. */
export function validateEntry(body, { requireRepo = true } = {}) {
  const useCase = typeof body?.useCase === "string" ? body.useCase.replace(/\s+/g, " ").trim() : "";
  if (!useCase || useCase.length > MAX_USE_CASE_LENGTH) throw new TrendingError(`Use case must be 1 to ${MAX_USE_CASE_LENGTH} characters.`);
  const keywords = parseKeywords(body?.keywords);
  if (!keywords.length) throw new TrendingError("Add at least one keyword, for example: scraper, crawler.");
  const position = body?.position === undefined || body?.position === null || body?.position === "" ? 0 : Number(body.position);
  if (!Number.isInteger(position) || position < 0 || position > 999) throw new TrendingError("Order must be a whole number from 0 to 999.");
  const out = { useCase, keywords, position };
  if (requireRepo) {
    const repo = parseRepo(body?.repo);
    if (!repo) throw new TrendingError("Repository must look like owner/name or a github.com link.");
    out.repo = repo;
  }
  return out;
}

/** Adds a repository to a use case, or updates it if it is already there. Fetches its details from GitHub. */
export async function addTrending(env, entry, { token, login, now = Date.now() }) {
  const count = await withAppTables(env, () => env.DB.prepare("SELECT COUNT(*) AS n FROM trending_repos").first());
  const data = await fetchRepoSnapshot(entry.repo, token, env);
  const existing = await env.DB.prepare("SELECT id FROM trending_repos WHERE use_case = ?1 COLLATE NOCASE AND repo = ?2 COLLATE NOCASE")
    .bind(entry.useCase, data.name)
    .first();
  if (!existing && count.n >= MAX_ENTRIES) throw new TrendingError(`The library is full (${MAX_ENTRIES} entries). Remove some first.`);
  const keywords = JSON.stringify(entry.keywords);
  if (existing) {
    await env.DB.prepare("UPDATE trending_repos SET use_case = ?1, repo = ?2, keywords = ?3, position = ?4, data = ?5, refreshed_at = ?6 WHERE id = ?7")
      .bind(entry.useCase, data.name, keywords, entry.position, JSON.stringify(data), now, existing.id)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO trending_repos (use_case, repo, keywords, position, data, added_at, added_by, refreshed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?6)",
    )
      .bind(entry.useCase, data.name, keywords, entry.position, JSON.stringify(data), now, login ?? null)
      .run();
  }
  forgetLibrary();
  const row = await env.DB.prepare("SELECT * FROM trending_repos WHERE use_case = ?1 COLLATE NOCASE AND repo = ?2 COLLATE NOCASE").bind(entry.useCase, data.name).first();
  return { entry: rowToEntry(row), updated: Boolean(existing) };
}

/** Changes the use case, keywords or order of one entry. Returns null if it does not exist. */
export async function updateTrending(env, id, entry) {
  const clash = await withAppTables(env, () =>
    env.DB.prepare(
      "SELECT a.id FROM trending_repos a JOIN trending_repos b ON b.id = ?1 WHERE a.id != ?1 AND a.use_case = ?2 COLLATE NOCASE AND a.repo = b.repo COLLATE NOCASE",
    )
      .bind(id, entry.useCase)
      .first(),
  );
  if (clash) throw new TrendingError("That repository is already in this use case.");
  const res = await env.DB.prepare("UPDATE trending_repos SET use_case = ?1, keywords = ?2, position = ?3 WHERE id = ?4")
    .bind(entry.useCase, JSON.stringify(entry.keywords), entry.position, id)
    .run();
  if (!res.meta?.changes) return null;
  forgetLibrary();
  return rowToEntry(await env.DB.prepare("SELECT * FROM trending_repos WHERE id = ?1").bind(id).first());
}

export async function deleteTrending(env, id) {
  const res = await withAppTables(env, () => env.DB.prepare("DELETE FROM trending_repos WHERE id = ?1").bind(id).run());
  forgetLibrary();
  return Boolean(res.meta?.changes);
}

/**
 * Updates the stored details (stars, description, ...) of entries last refreshed before `olderThan`.
 * Each repository is fetched once even if it is in several use cases. Stops at the first rate limit.
 * Returns { refreshed, failed }.
 */
export async function refreshTrending(env, token, { olderThan = Infinity, limit = 100, now = Date.now() } = {}) {
  const { results } = await withAppTables(env, () =>
    env.DB.prepare("SELECT DISTINCT repo FROM trending_repos WHERE refreshed_at < ?1 ORDER BY refreshed_at LIMIT ?2")
      .bind(Number.isFinite(olderThan) ? olderThan : Number.MAX_SAFE_INTEGER, limit)
      .all(),
  );
  let refreshed = 0;
  const failed = [];
  for (const { repo } of results) {
    const parts = parseRepo(repo);
    try {
      const data = await fetchRepoSnapshot(parts, token, env);
      await env.DB.prepare("UPDATE trending_repos SET data = ?1, repo = ?2, refreshed_at = ?3 WHERE repo = ?4 COLLATE NOCASE")
        .bind(JSON.stringify(data), data.name, now, repo)
        .run();
      refreshed++;
    } catch (err) {
      failed.push({ repo, error: err.message });
      if (err instanceof GitHubError && (err.status === 429 || err.status === 401)) break;
    }
  }
  forgetLibrary();
  return { refreshed, failed };
}

// ---------- GitHub ----------

/** The repository's current details from GitHub, in the same shape as search results. */
export async function fetchRepoSnapshot(repo, token, env) {
  if (!repo) throw new TrendingError("Repository must look like owner/name.");
  const url = `${githubApiBase(env)}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
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
    body = await res.json().catch(() => null);
  } catch (err) {
    if (err?.name === "TimeoutError") throw new GitHubError(504, "GitHub took too long to answer. Please try again.", { code: "github_timeout" });
    throw new GitHubError(502, "Could not reach GitHub. Please try again.", { code: "github_unreachable" });
  }
  if (res.ok && body?.full_name) return simplifyRepo(body);
  if (res.status === 404) throw new TrendingError(`${repo.owner}/${repo.name} was not found on GitHub.`);
  if (res.status === 401) throw new GitHubError(401, "Your GitHub authorization expired. Please sign in again.", { code: "github_reauth" });
  if (isGitHubRateLimit(res, String(body?.message ?? ""))) throw new GitHubError(429, "GitHub's rate limit was reached. Try again in a minute.", { code: "rate_limited" });
  throw new GitHubError(502, `GitHub returned an error (${res.status}). Please try again.`, { code: "github_error" });
}
