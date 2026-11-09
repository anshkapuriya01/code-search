// Fetches a repository's README as plain text so an agent can judge a search result.

import { githubApiBase, githubTimeout, USER_AGENT } from "./config.js";
import { GitHubError, isGitHubRateLimit } from "./search.js";
import { readStream } from "./http.js";
import { TtlCache } from "./memo.js";

export const DEFAULT_README_CHARS = 6000;
export const MAX_README_CHARS = 20000;
export const MAX_README_BYTES = 128 * 1024; // never reads more than this from GitHub
const README_TTL_MS = 60 * 60 * 1000;
const REPO_RE = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

// Holds at most MAX_README_CHARS per entry, so 200 entries stay around 8 MB of the Worker's 128 MB.
const cache = new TtlCache(200);

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

/**
 * Returns { repo, text, truncated, totalChars, url }. Cached per account, so nothing one user fetched or failed
 * to fetch reaches another. totalChars is a lower bound for READMEs longer than GitHub bytes read.
 */
export async function getReadme({ owner, name }, maxChars, { token, env, userId }) {
  const key = `${userId}:${owner}/${name}`.toLowerCase();
  let full = cache.get(key);
  if (full === undefined) {
    full = await fetchReadme(owner, name, token, env);
    cache.set(key, full, README_TTL_MS);
  }
  return {
    repo: `${owner}/${name}`,
    url: full.url,
    text: full.text.slice(0, maxChars),
    truncated: full.cut || full.totalChars > maxChars,
    totalChars: full.totalChars,
  };
}

async function fetchReadme(owner, name, token, env) {
  const url = `${githubApiBase(env)}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`;
  let res;
  let body;
  try {
    res = await fetch(url, {
      signal: githubTimeout(),
      headers: {
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${token}`,
      },
    });
    body = await readStream(res.body, res.ok ? MAX_README_BYTES : 4096);
  } catch (err) {
    console.error("README request failed", String(err));
    if (err?.name === "TimeoutError") throw new GitHubError(504, "GitHub took too long to answer. Please try again.", { code: "github_timeout" });
    throw new GitHubError(502, "Could not reach GitHub. Please try again.", { code: "github_unreachable" });
  }
  if (res.ok) {
    return { text: body.text.slice(0, MAX_README_CHARS), totalChars: body.text.length, cut: body.cut, url: `https://github.com/${owner}/${name}#readme` };
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
  if (isGitHubRateLimit(res, body.text)) {
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
