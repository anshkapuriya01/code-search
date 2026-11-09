// Code Search — GitHub search for AI agents. Cloudflare Worker.
//   /mcp            MCP server (Streamable HTTP, API key)
//   /v1/*           REST API (API key, or session cookie from the web app); /api/search is an alias
//   /api/*          web app endpoints (session cookie)
//   /auth/*         GitHub OAuth
// Everything else is static files in /public (landing page, app, docs, openapi.json, llms.txt).

import { json, errorJson, readBody } from "./http.js";
import { decryptText, ConfigError } from "./crypto.js";
import { QueryError } from "../public/lib/query.js";
import { GitHubError } from "./search.js";
import { handleMcp } from "./mcp.js";
import { authenticate, searchFor, readmeFor, noteKeyUse, ServiceError } from "./service.js";
import { anonymousRetryAfter, enforceLimits, enforceRateLimit } from "./limits.js";
import { runMaintenance } from "./maintenance.js";
import { recordCall, outcomeOf, usageFor, parseDays } from "./usage.js";
import { startAudit, auditCaller, auditError, auditSearch, auditReadme, finishAudit } from "./audit.js";
import { handleAdminApi } from "./admin.js";
import { isAdmin } from "./config.js";
import { registrationOpenForDisplay } from "./settings.js";
import {
  startLogin,
  finishLogin,
  getSession,
  endSession,
  clearSessionCookie,
  isSameOrigin,
  listApiKeys,
  createApiKey,
  deleteApiKey,
  deleteAccount,
  revokeGitHubGrant,
} from "./auth.js";

const PUBLIC_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Expose-Headers": "X-Request-Id, Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const started = Date.now();
    const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
    const audit = startAudit(request, url, requestId);
    let response;
    try {
      response = await route(request, env, ctx, url, requestId, audit);
    } catch (err) {
      console.error("Unhandled error", requestId, err instanceof Error ? err.stack : String(err));
      auditError(audit, err);
      const message = err instanceof ConfigError ? "The server is not configured correctly." : "Something went wrong.";
      response = isApiPath(url.pathname)
        ? errorJson(500, message, { code: "internal_error", requestId }, isPublicApi(url.pathname) ? PUBLIC_CORS : {})
        : new Response(message, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }
    if (isApiPath(url.pathname)) {
      response = new Response(response.body, response);
      response.headers.set("X-Request-Id", requestId);
      response.headers.set("Server-Timing", `total;dur=${Date.now() - started}`);
      response.headers.set("X-Content-Type-Options", "nosniff");
      if (url.protocol === "https:") response.headers.set("Strict-Transport-Security", "max-age=31536000");
      finishAudit(env, ctx, audit, response.status, Date.now() - started);
    }
    return response;
  },

  scheduled(_event, env, ctx) {
    ctx.waitUntil(runMaintenance(env));
  },
};

const isApiPath = (p) => p === "/mcp" || p.startsWith("/api/") || p.startsWith("/v1/") || p.startsWith("/auth/");
const isPublicApi = (p) => p.startsWith("/v1/") || p === "/api/search";

async function route(request, env, ctx, url, requestId, audit) {
  const { pathname } = url;
  if (pathname === "/mcp") {
    if (!env.DB || !env.TOKEN_ENCRYPTION_KEY) return errorJson(500, "The server is not configured correctly.", { code: "internal_error" });
    return handleMcp(request, env, ctx, url, audit);
  }
  if (pathname.startsWith("/auth/")) return handleAuth(request, env, url, audit);
  if (pathname === "/v1/search" || pathname === "/api/search") return publicApi(request, env, ctx, url, requestId, audit, "search");
  const readme = pathname.match(/^\/v1\/repos\/([^/]+)\/([^/]+)\/readme$/);
  if (readme) return publicApi(request, env, ctx, url, requestId, audit, "readme", `${safeDecode(readme[1])}/${safeDecode(readme[2])}`);
  if (pathname.startsWith("/v1/")) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });
    return errorJson(404, "Not found. The API is described at /openapi.json.", { code: "not_found", requestId }, PUBLIC_CORS);
  }
  if (pathname.startsWith("/api/")) return handleAppApi(request, env, url, audit);
  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("Not found", { status: 404 });
}

// ---------- Public REST API (/v1) ----------

async function publicApi(request, env, ctx, url, requestId, audit, kind, repo) {
  const fail = (status, code, message, extra = {}) => {
    const headers = { ...PUBLIC_CORS };
    if (extra.retryAfter) headers["Retry-After"] = String(extra.retryAfter);
    return errorJson(status, message, { code, requestId, ...extra }, headers);
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PUBLIC_CORS });
  if (request.method !== "GET") return fail(405, "method_not_allowed", "Use GET.");
  if (!env.DB || !env.TOKEN_ENCRYPTION_KEY) return fail(500, "internal_error", "The server is not configured correctly.");

  const endpoint = kind === "search" ? "rest_search" : "rest_readme";
  audit.action = endpoint;
  audit.input = kind === "search" ? Object.fromEntries(url.searchParams) : { repo, max_chars: url.searchParams.get("max_chars") };
  audit.query = kind === "search" ? url.searchParams.get("q") : repo;
  let caller = null;
  try {
    caller = await authenticate(request, env, url);
    auditCaller(audit, caller);
    await enforceLimits(env, caller.user);
    const body =
      kind === "search"
        ? await searchFor(caller.user, url.searchParams, { env, ctx, origin: url.origin })
        : await readmeFor(caller.user, repo, url.searchParams.get("max_chars"), { env });
    noteKeyUse(env, ctx, caller.apiKey);
    recordCall(env, ctx, caller, endpoint, "ok", body.cached === true);
    if (kind === "search") auditSearch(audit, body);
    else auditReadme(audit, body);
    const headers = { ...PUBLIC_CORS, "Cache-Control": "private, no-store" };
    const rl = body.rateLimit;
    if (rl?.limit != null) headers["X-RateLimit-Limit"] = String(rl.limit);
    if (rl?.remaining != null) headers["X-RateLimit-Remaining"] = String(rl.remaining);
    if (rl?.reset != null) headers["X-RateLimit-Reset"] = String(rl.reset);
    return json({ ...body, requestId }, 200, headers);
  } catch (err) {
    if (caller && !err.ownLimit) recordCall(env, ctx, caller, endpoint, outcomeOf(err));
    auditError(audit, err);
    if (err instanceof ServiceError && err.status === 401) {
      const retryAfter = await anonymousRetryAfter(env, request);
      if (retryAfter) return fail(429, "too_many_requests", "Too many requests.", { retryAfter });
    }
    if (err instanceof ServiceError) return fail(err.status, err.code, err.message, err.extra);
    if (err instanceof GitHubError) {
      return fail(err.status, err.extra.code ?? "github_error", err.message, err.extra.retryAfter ? { retryAfter: err.extra.retryAfter } : {});
    }
    if (err instanceof QueryError) return fail(400, "invalid_params", err.message);
    throw err;
  }
}

// ---------- OAuth ----------

async function handleAuth(request, env, url, audit) {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/auth/login" || pathname === "/auth/callback") {
    const retryAfter = await anonymousRetryAfter(env, request);
    if (retryAfter) return errorJson(429, "Too many requests.", { code: "too_many_requests", retryAfter }, { "Retry-After": String(retryAfter) });
  }
  if (pathname === "/auth/login" && method === "GET") return startLogin(env, url);
  if (pathname === "/auth/callback" && method === "GET") return finishLogin(request, env, url, audit);
  if (pathname === "/auth/logout" && method === "POST") {
    if (!isSameOrigin(request, url)) return errorJson(403, "Cross-site request blocked.", { code: "forbidden" });
    const session = env.DB ? await getSession(request, env, url) : null;
    if (session) {
      await endSession(env, session.sessionHash);
      auditCaller(audit, { user: session.user, apiKey: null }, "auth");
      audit.action = "auth_signout";
    }
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(url) });
  }
  return errorJson(404, "Not found.", { code: "not_found" });
}

// ---------- Web app API (session cookie) ----------

async function handleAppApi(request, env, url, audit) {
  const { pathname } = url;
  const method = request.method;
  if (!env.DB) return errorJson(500, "The server is not configured correctly.", { code: "internal_error" });
  const session = await getSession(request, env, url);
  const unauthorized = () => errorJson(401, "Sign in first.", { code: "signin_required" });
  const crossSite = () => errorJson(403, "Cross-site request blocked.", { code: "forbidden" });
  const limited = (err) =>
    errorJson(err.status, err.message, { code: err.code, ...err.extra }, { "Retry-After": String(err.extra.retryAfter) });

  if (session) {
    auditCaller(audit, { user: session.user, apiKey: null }, "web");
    audit.action = `${method} ${pathname}`.slice(0, 120);
    // Dashboard reads run on every page view and on a timer. They write nothing and stay available after the daily
    // allowance is used, so people can still see their usage and manage their keys.
    const isRead = method === "GET";
    // A used-up allowance must never stop someone revoking a key or deleting their account.
    const isRevocation = (method === "DELETE" && pathname.startsWith("/api/keys/")) || pathname === "/api/account/delete";
    audit.skip = isRead;
    audit.uncounted = isRead;
    try {
      if (isRead) await enforceRateLimit(env, session.user);
      else await enforceLimits(env, session.user);
    } catch (err) {
      if (!(err instanceof ServiceError)) throw err;
      auditError(audit, err);
      if (!isRevocation || err.code === "too_many_requests") return limited(err);
    }
  } else {
    const retryAfter = await anonymousRetryAfter(env, request);
    if (retryAfter) return limited({ status: 429, message: "Too many requests.", code: "too_many_requests", extra: { retryAfter } });
  }

  if (pathname.startsWith("/api/admin/")) return handleAdminApi(request, env, url, session, audit);

  if (pathname === "/api/me" && method === "GET") {
    if (!session) return errorJson(401, "Sign in first.", { code: "signin_required", registrationOpen: await registrationOpenForDisplay(env) });
    const { login, name, avatar_url } = session.user;
    return json({ user: { login, name, avatarUrl: avatar_url }, isAdmin: isAdmin(env, session.user), registrationOpen: await registrationOpenForDisplay(env) });
  }

  if (pathname === "/api/keys") {
    if (!session) return unauthorized();
    if (method === "GET") return json({ keys: await listApiKeys(env, session.user.id) });
    if (method === "POST") {
      if (!isSameOrigin(request, url)) return crossSite();
      const body = await readJson(request);
      if (body === undefined) return errorJson(400, 'Send a JSON body like {"name": "my agent"}.', { code: "invalid_params" });
      audit.input = { name: typeof body?.name === "string" ? body.name.slice(0, 60) : null };
      const result = await createApiKey(env, session.user.id, body?.name);
      if (result.error) return errorJson(result.status, result.error, { code: result.status === 409 ? "limit_reached" : "invalid_params" });
      audit.output = { id: result.record.id, name: result.record.name, prefix: result.record.prefix }; // never the key itself
      return json({ key: result.key, ...result.record }, 201);
    }
    return errorJson(405, "Use GET or POST.", { code: "method_not_allowed" });
  }

  if (pathname === "/api/usage") {
    if (!session) return unauthorized();
    if (method !== "GET") return errorJson(405, "Use GET.", { code: "method_not_allowed" });
    const days = parseDays(url.searchParams.get("days"));
    if (days === null) return errorJson(400, "days must be 1, 7, 30 or 90.", { code: "invalid_params" });
    const keys = await listApiKeys(env, session.user.id);
    return json(await usageFor(env, session.user.id, days, keys));
  }

  const keyMatch = pathname.match(/^\/api\/keys\/([A-Za-z0-9_-]{1,40})$/);
  if (keyMatch) {
    if (!session) return unauthorized();
    if (method !== "DELETE") return errorJson(405, "Use DELETE.", { code: "method_not_allowed" });
    if (!isSameOrigin(request, url)) return crossSite();
    const deleted = await deleteApiKey(env, session.user.id, keyMatch[1]);
    return deleted ? json({ ok: true }) : errorJson(404, "Key not found.", { code: "not_found" });
  }

  if (pathname === "/api/account/delete") {
    if (!session) return unauthorized();
    if (method !== "POST") return errorJson(405, "Use POST.", { code: "method_not_allowed" });
    if (!isSameOrigin(request, url)) return crossSite();
    try {
      await revokeGitHubGrant(env, await decryptText(session.user.token_enc, env.TOKEN_ENCRYPTION_KEY));
    } catch (err) {
      console.error("Could not decrypt token during account deletion", String(err));
    }
    await deleteAccount(env, session.user.id);
    audit.user = null; // the account and its log are gone; do not start a new one
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(url) });
  }

  return errorJson(404, "Not found.", { code: "not_found" });
}

/** Malformed percent-encoding becomes an invalid name (rejected with 400) instead of throwing. */
function safeDecode(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return "";
  }
}

/** Parses a small JSON body. Returns undefined if it is missing, too large, or invalid. */
async function readJson(request) {
  const text = await readBody(request, 4096);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
