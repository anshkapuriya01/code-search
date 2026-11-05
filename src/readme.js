// Fetches a repository's README as plain text so an agent can judge a search result.

import { githubApiBase, USER_AGENT } from "./config.js";
import { GitHubError } from "./search.js";
import { TtlCache } from "./memo.js";

export const DEFAULT_README_CHARS = 6000;
export const MAX_README_CHARS = 20000;
const README_TTL_MS = 60 * 60 * 1000;
const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

const cache = new TtlCache(500); // full text per repo, public data
const inflight = new Map();

/** "owner/name" (also accepts a github.com URL). Returns { owner, name } or null. */
export function parseRepo(input) {
  let s = String(input ?? "").trim();
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+\/[^/?#]+)/i.exec(s);
  if (m) s = m[1];
  s = s.replace(/\.git$/i, "");
  const r = REPO_RE.exec(s);
  if (!r || r[2] === "." || r[2] === "..") return null;
  return { owner: r[1], name: r[2] };
}

export function parseMaxChars(raw) {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_README_CHARS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 200 || n > MAX_README_CHARS) return null;
  return n;
}

/** Returns { repo, text, truncated, totalChars, url }. */
export async function getReadme({ owner, name }, maxChars, { token, env }) {
  const key = `${owner}/${name}`.toLowerCase();
  let full = cache.get(key);
  if (full === undefined) {
    let p = inflight.get(key);
    if (!p) {
      p = fetchReadme(owner, name, token, env).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    full = await p;
    cache.set(key, full, README_TTL_MS);
  }
  const text = full.text.length > maxChars ? full.text.slice(0, maxChars) : full.text;
  return {
    repo: `${owner}/${name}`,
    url: full.url,
    text,
    truncated: full.text.length > maxChars,
    totalChars: full.text.length,
  };
}

async function fetchReadme(owner, name, token, env) {
  const url = `${githubApiBase(env)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`;
  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${token}`,
      },
    });
  } catch (err) {
    console.error("README request failed", String(err));
    throw new GitHubError(502, "Could not reach GitHub. Please try again.", { code: "github_unreachable" });
  }
  if (res.ok) {
    return { text: await res.text(), url: `https://github.com/${owner}/${name}#readme` };
  }
  if (res.status === 404) {
    throw new GitHubError(404, `No README found for ${owner}/${name} (or the repository does not exist).`, {
      code: "not_found",
    });
  }
  if (res.status === 401) {
    throw new GitHubError(401, "Your GitHub authorization expired or was revoked. Please sign in again.", {
      code: "github_reauth",
    });
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status === 429 || (res.status === 403 && remaining === "0")) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retryAfter = Number(res.headers.get("retry-after")) || (reset ? Math.max(1, reset - Math.floor(Date.now() / 1000)) : 60);
    throw new GitHubError(429, `GitHub's rate limit for your account was reached. Try again in ${retryAfter} seconds.`, {
      code: "rate_limited",
      retryAfter,
    });
  }
  console.error("README error", res.status);
  throw new GitHubError(502, `GitHub returned an error (${res.status}). Please try again.`, { code: "github_error" });
}
