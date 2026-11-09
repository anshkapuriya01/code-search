// Shared by the REST API and the MCP server: authentication, rate limiting, running a search or
// README fetch for a user, and compact text formatting for language models.

import { decryptText, ConfigError } from "./crypto.js";
import { parseSearchParams, describeQualifiers } from "../public/lib/query.js";
import { searchRepositories } from "./search.js";
import { interpretQuery } from "./ai.js";
import { getReadme, parseRepo, parseMaxChars } from "./readme.js";
import { getSession, getApiKeyUser, touchApiKey } from "./auth.js";
import { WindowLimiter } from "./memo.js";

export const REQUESTS_PER_MINUTE = 120; // per user, across REST and MCP; GitHub adds its own 30 searches/min

export class ServiceError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * Resolves the caller. An Authorization header means API-key auth and never falls back to the cookie.
 * Returns { user, apiKey } or throws ServiceError(401).
 */
export async function authenticate(request, env, url, { allowCookie = true } = {}) {
  if (request.headers.has("Authorization")) {
    const apiKey = await getApiKeyUser(request, env);
    if (!apiKey) throw new ServiceError(401, "invalid_api_key", "Invalid or revoked API key.");
    return { user: apiKey.user, apiKey };
  }
  if (allowCookie) {
    const session = await getSession(request, env, url);
    if (session) return { user: session.user, apiKey: null };
  }
  throw new ServiceError(
    401,
    "signin_required",
    allowCookie
      ? "Sign in, or send an API key as 'Authorization: Bearer <key>'."
      : "Send your Code Search API key as 'Authorization: Bearer <key>'. Create one at /app/#keys.",
  );
}

const fallbackLimiter = new WindowLimiter(REQUESTS_PER_MINUTE, 60_000);

/** Throws ServiceError(429) when the user exceeds REQUESTS_PER_MINUTE. */
export async function enforceRateLimit(env, user) {
  const key = `u:${user.id}`;
  if (env.RATE_LIMITER?.limit) {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (success) return;
      throw new ServiceError(429, "too_many_requests", `Slow down: at most ${REQUESTS_PER_MINUTE} requests per minute per account.`, {
        retryAfter: 60,
      });
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      console.error("Rate limiter binding failed, using in-memory fallback", String(err));
    }
  }
  const r = fallbackLimiter.take(key);
  if (!r.ok) {
    throw new ServiceError(429, "too_many_requests", `Slow down: at most ${REQUESTS_PER_MINUTE} requests per minute per account.`, {
      retryAfter: r.retryAfter,
    });
  }
}

export async function userToken(user, env) {
  try {
    return await decryptText(user.token_enc, env.TOKEN_ENCRYPTION_KEY);
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    console.error("Stored GitHub token could not be decrypted", String(err));
    throw new ServiceError(401, "github_reauth", "Please sign in to Code Search again.");
  }
}

/** Records API key usage in the background (at most once an hour per key). */
export function noteKeyUse(env, ctx, apiKey) {
  if (apiKey) ctx.waitUntil(touchApiKey(env, apiKey).catch(() => {}));
}

/** Validates params (URLSearchParams), runs the search and returns the public response body. */
export async function searchFor(user, searchParams, { env, ctx, origin }) {
  const params = parseSearchParams(searchParams);
  if (!params.ok) throw new ServiceError(400, "invalid_params", params.error);
  const token = await userToken(user, env);
  const understood = await interpretQuery(params.value, { env, ctx, origin });
  const opts = { ...params.value, parsed: understood.parsed };
  const result = await searchRepositories(opts, { token, env, ctx, origin });
  return {
    query: {
      input: opts.input,
      keywords: opts.parsed.keywords,
      keyTerms: opts.parsed.core,
      descriptiveWords: opts.parsed.soft,
      synonyms: opts.parsed.synonyms ?? {},
      context: opts.parsed.context,
      interpretedBy: understood.interpretedBy,
      aiStatus: understood.aiStatus,
      qualifiers: describeQualifiers(opts.parsed, opts.language),
      ignored: opts.parsed.ignored,
      language: opts.language,
      minStars: opts.minStars,
      includeArchived: opts.includeArchived,
      notes: opts.notes,
    },
    ...result,
  };
}

export async function readmeFor(user, repoInput, maxCharsInput, { env }) {
  const repo = parseRepo(repoInput);
  if (!repo) throw new ServiceError(400, "invalid_params", "repo must look like owner/name, e.g. sxyazi/yazi.");
  const maxChars = parseMaxChars(maxCharsInput);
  if (maxChars === null) throw new ServiceError(400, "invalid_params", "max_chars must be a whole number from 200 to 20000.");
  return getReadme(repo, maxChars, { token: await userToken(user, env), env });
}

// ---------- Compact text for language models ----------

const MATCH_TEXT = {
  all_keywords: "every word matched",
  key_terms_plus: "all key terms and some descriptive words matched",
  key_terms: "fewer than 10 projects matched every word, so these match all key terms",
  most_key_terms: "fewer than 10 projects matched every word, so these match most key terms",
};

export function formatSearchText(r) {
  const q = r.query;
  const lines = [];
  const scope = `${q.minStars}+ stars${q.language ? `, ${q.language}` : ""}${q.includeArchived ? "" : ", not archived"}`;
  if (!r.items.length) {
    lines.push(`No repositories found for "${q.input}" (${scope}).`);
    lines.push(`Try fewer or different words${q.minStars > 10 ? `, or a lower min_stars (now ${q.minStars})` : ""}.`);
    return lines.join("\n");
  }
  const start = (r.page - 1) * r.perPage;
  lines.push(
    `${r.total} repositories for "${q.input}" (${scope}); ${MATCH_TEXT[r.matchLevel] ?? r.matchLevel}. Best matches first, then by stars. Showing ${start + 1}-${start + r.items.length}.`,
  );
  lines.push(`Key terms: ${q.keyTerms.join(", ") || "none"}${q.descriptiveWords.length ? `; descriptive: ${q.descriptiveWords.join(", ")}` : ""}.`);
  if (q.context?.length) lines.push(`Treated as context, not searched for: ${q.context.join("; ")}.`);
  r.items.forEach((it, i) => {
    const facts = [`★${it.stars}`, it.language, it.license, it.archived ? "archived" : null, it.pushedAt ? `pushed ${it.pushedAt.slice(0, 10)}` : null]
      .filter(Boolean)
      .join(" · ");
    const desc = it.description ? ` — ${it.description.replace(/\s+/g, " ").slice(0, 200)}` : "";
    lines.push(`${start + i + 1}. ${it.name} (${facts})${desc}`);
    lines.push(`   ${it.url}${it.topics.length ? ` · topics: ${it.topics.slice(0, 6).join(", ")}` : ""}`);
  });
  if (r.hasMore) lines.push(`More results: call again with page=${r.page + 1}.`);
  if (q.ignored.length) lines.push(`Ignored: ${q.ignored.join(" ")}.`);
  for (const n of q.notes) lines.push(n);
  return lines.join("\n");
}

export function formatReadmeText(r) {
  const head = `README of ${r.repo} (${r.url})${r.truncated ? `, first ${r.text.length} of ${r.totalChars} characters` : ""}:`;
  return `${head}\n\n${r.text}${r.truncated ? `\n\n[truncated: call again with a larger max_chars (up to 20000) to read more]` : ""}`;
}
