// GitHub OAuth login, browser sessions, and user-created API keys.

import { randomToken, sha256Hex, encryptText, safeEqual } from "./crypto.js";
import { redirect, parseCookies, serializeCookie } from "./http.js";
import { githubApiBase, githubOAuthBase, isAdmin, missingConfig, USER_AGENT } from "./config.js";
import { TtlCache } from "./memo.js";
import { withAppTables } from "./schema.js";
import { registrationOpenForDisplay, registrationState } from "./settings.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STATE_TTL_SECONDS = 600;
const STATE_COOKIE = "cs_oauth_state";
export const API_KEY_PREFIX = "codesearch_";
// "corch_" and "scout_" keys were issued under earlier names and stay valid.
const API_KEY_RE = /^(codesearch|corch|scout)_[A-Za-z0-9_-]{43}$/;
export const MAX_KEYS_PER_USER = 10;
export const MAX_KEY_NAME_LENGTH = 50;

// Per-isolate caches for hot lookups. Revocations clear the local entry immediately; other isolates
// see the change within AUTH_CACHE_TTL_MS.
const AUTH_CACHE_TTL_MS = 60_000;
const NEGATIVE_CACHE_TTL_MS = 30_000;
const sessionCache = new TtlCache(5000);
const keyCache = new TtlCache(5000);

function forgetUser(userId) {
  const sameUser = (v) => v && v.user && v.user.id === userId;
  sessionCache.deleteWhere(sameUser);
  keyCache.deleteWhere(sameUser);
}

const isSecure = (url) => url.protocol === "https:";
// "__Host-" cookies are locked to this exact host over HTTPS. Plain name is used for http://localhost dev.
const sessionCookieName = (url) => (isSecure(url) ? "__Host-cs_session" : "cs_session");

// ---------- OAuth ----------

export async function startLogin(env, url) {
  const missing = missingConfig(env);
  if (missing.length) {
    console.error("Login unavailable, missing configuration:", missing.join(", "));
    return redirect("/app/?error=config");
  }
  const state = randomToken(24);
  const authorize = new URL(`${githubOAuthBase(env)}/login/oauth/authorize`);
  authorize.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorize.searchParams.set("redirect_uri", `${url.origin}/auth/callback`);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("allow_signup", String(await registrationOpenForDisplay(env)));
  // No "scope" parameter: the token can only read public data, which is all search needs.
  return redirect(authorize.toString(), [
    serializeCookie(STATE_COOKIE, state, { path: "/auth", maxAge: STATE_TTL_SECONDS, secure: isSecure(url) }),
  ]);
}

export async function finishLogin(request, env, url, audit) {
  const clearState = serializeCookie(STATE_COOKIE, "", { path: "/auth", maxAge: 0, secure: isSecure(url) });
  const fail = (code) => redirect(`/app/?error=${code}`, [clearState]);

  if (missingConfig(env).length) return fail("config");
  if (url.searchParams.get("error")) return fail("denied");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = parseCookies(request.headers.get("Cookie"))[STATE_COOKIE];
  if (!code || !state || !expected || !safeEqual(state, expected)) return fail("state");

  const token = await exchangeCode(env, code, `${url.origin}/auth/callback`);
  if (!token) return fail("github");
  const ghUser = await fetchGitHubUser(env, token);
  if (!ghUser) return fail("github");

  // Only accounts that do not exist yet can be turned away, so existing users always get back in. Admins are
  // exempt so closing registration can never lock out the person who closed it.
  const existing = await env.DB.prepare("SELECT id FROM users WHERE id = ?1").bind(ghUser.id).first();
  audit.source = "auth";
  audit.user = { id: ghUser.id, login: ghUser.login };
  if (!existing && !isAdmin(env, ghUser) && !(await registrationState(env)).open) {
    audit.action = "auth_blocked_signup";
    audit.error = { code: "registration_closed", message: "New registrations are closed." };
    await revokeGitHubGrant(env, token); // no account was created, so keep no access
    return fail("registration_closed");
  }
  audit.action = existing ? "auth_signin" : "auth_register";

  const now = Date.now();
  const tokenEnc = await encryptText(token, env.TOKEN_ENCRYPTION_KEY);
  const sessionToken = randomToken(32);
  const sessionHash = await sha256Hex(sessionToken);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, login, name, avatar_url, token_enc, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(id) DO UPDATE SET login = excluded.login, name = excluded.name,
         avatar_url = excluded.avatar_url, token_enc = excluded.token_enc, updated_at = excluded.updated_at`,
    ).bind(ghUser.id, ghUser.login, ghUser.name, ghUser.avatarUrl, tokenEnc, now),
    env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)").bind(
      sessionHash,
      ghUser.id,
      now,
      now + SESSION_TTL_MS,
    ),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?1").bind(now),
  ]);

  forgetUser(ghUser.id); // the stored token changed
  return redirect("/app/#search", [
    clearState,
    serializeCookie(sessionCookieName(url), sessionToken, { maxAge: SESSION_TTL_MS / 1000, secure: isSecure(url) }),
  ]);
}

async function exchangeCode(env, code, redirectUri) {
  try {
    const res = await fetch(`${githubOAuthBase(env)}/login/oauth/access_token`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || typeof body?.access_token !== "string" || !body.access_token) {
      console.error("OAuth code exchange failed", res.status, body?.error ?? "");
      return null;
    }
    return body.access_token;
  } catch (err) {
    console.error("OAuth code exchange error", String(err));
    return null;
  }
}

async function fetchGitHubUser(env, token) {
  try {
    const res = await fetch(`${githubApiBase(env)}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      console.error("Fetching GitHub user failed", res.status);
      return null;
    }
    const u = await res.json();
    if (!Number.isSafeInteger(u?.id) || typeof u?.login !== "string") return null;
    return {
      id: u.id,
      login: u.login,
      name: typeof u.name === "string" ? u.name : null,
      avatarUrl: typeof u.avatar_url === "string" ? u.avatar_url : null,
    };
  } catch (err) {
    console.error("Fetching GitHub user error", String(err));
    return null;
  }
}

/** Best-effort: tells GitHub to revoke this app's access for the user. */
export async function revokeGitHubGrant(env, token) {
  try {
    const res = await fetch(`${githubApiBase(env)}/applications/${encodeURIComponent(env.GITHUB_CLIENT_ID)}/grant`, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
      },
      body: JSON.stringify({ access_token: token }),
    });
    if (!res.ok && res.status !== 404) console.error("Revoking GitHub grant failed", res.status);
  } catch (err) {
    console.error("Revoking GitHub grant error", String(err));
  }
}

// ---------- Sessions ----------

const USER_COLUMNS = "u.id, u.login, u.name, u.avatar_url, u.token_enc";

export async function getSession(request, env, url) {
  const token = parseCookies(request.headers.get("Cookie"))[sessionCookieName(url)];
  if (!token || token.length > 100) return null;
  const hash = await sha256Hex(token);
  const cached = sessionCache.get(hash);
  if (cached !== undefined) return cached && { user: cached.user, sessionHash: hash };
  const user = await env.DB.prepare(
    `SELECT ${USER_COLUMNS} FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ?1 AND s.expires_at > ?2`,
  )
    .bind(hash, Date.now())
    .first();
  if (user) sessionCache.set(hash, { user }, AUTH_CACHE_TTL_MS);
  else sessionCache.set(hash, null, NEGATIVE_CACHE_TTL_MS);
  return user ? { user, sessionHash: hash } : null;
}

export async function endSession(env, sessionHash) {
  sessionCache.delete(sessionHash);
  await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?1").bind(sessionHash).run();
}

export function clearSessionCookie(url) {
  return serializeCookie(sessionCookieName(url), "", { maxAge: 0, secure: isSecure(url) });
}

/** Blocks cross-site form/fetch submissions for cookie-authenticated writes. */
export function isSameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === url.origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

// ---------- API keys ----------

/**
 * Looks up the user for an "Authorization: Bearer codesearch_..." header.
 * Returns { user, keyId, lastUsedAt } or null.
 */
export async function getApiKeyUser(request, env) {
  const header = request.headers.get("Authorization") ?? "";
  // Accepts "Bearer <key>", a bare key, or a doubled prefix (some MCP hosts add "Bearer" themselves).
  const m = /^(?:Bearer\s+)*(\S+)$/i.exec(header.trim());
  if (!m || !API_KEY_RE.test(m[1])) return null;
  const hash = await sha256Hex(m[1]);
  const cached = keyCache.get(hash);
  if (cached !== undefined) return cached;
  const row = await env.DB.prepare(
    `SELECT ${USER_COLUMNS}, k.id AS key_id, k.name AS key_name, k.last_used_at FROM api_keys k JOIN users u ON u.id = k.user_id
     WHERE k.key_hash = ?1`,
  )
    .bind(hash)
    .first();
  if (!row) {
    keyCache.set(hash, null, NEGATIVE_CACHE_TTL_MS);
    return null;
  }
  const { key_id, key_name, last_used_at, ...user } = row;
  const result = { user, keyId: key_id, name: key_name, lastUsedAt: last_used_at };
  keyCache.set(hash, result, AUTH_CACHE_TTL_MS);
  return result;
}

/** Records key usage at most once per hour to keep database writes low. */
export async function touchApiKey(env, apiKey) {
  const now = Date.now();
  if (apiKey.lastUsedAt && now - apiKey.lastUsedAt < 60 * 60 * 1000) return;
  apiKey.lastUsedAt = now; // also updates the cached entry, so the next hour skips the write
  const keyId = apiKey.keyId;
  await env.DB.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2").bind(now, keyId).run();
}

export async function listApiKeys(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, prefix, created_at, last_used_at FROM api_keys WHERE user_id = ?1 ORDER BY created_at DESC",
  )
    .bind(userId)
    .all();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  }));
}

/** Returns { key, record } or { error, status }. The full key is only ever returned here. */
export async function createApiKey(env, userId, rawName) {
  const name = String(rawName ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) return { status: 400, error: "Give the key a name." };
  if (name.length > MAX_KEY_NAME_LENGTH) return { status: 400, error: `Key names can be at most ${MAX_KEY_NAME_LENGTH} characters.` };

  const { count } = await env.DB.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE user_id = ?1").bind(userId).first();
  if (count >= MAX_KEYS_PER_USER) {
    return { status: 409, error: `You can have at most ${MAX_KEYS_PER_USER} keys. Revoke one first.` };
  }

  const key = API_KEY_PREFIX + randomToken(32);
  const id = randomToken(12);
  const prefix = key.slice(0, API_KEY_PREFIX.length + 6);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO api_keys (id, user_id, name, key_hash, prefix, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(id, userId, name, await sha256Hex(key), prefix, now)
    .run();

  return { key, record: { id, name, prefix, createdAt: now, lastUsedAt: null } };
}

export async function deleteApiKey(env, userId, keyId) {
  const res = await env.DB.prepare("DELETE FROM api_keys WHERE id = ?1 AND user_id = ?2").bind(keyId, userId).run();
  keyCache.deleteWhere((v) => v && v.keyId === keyId);
  return (res.meta?.changes ?? 0) > 0;
}

export async function deleteAccount(env, userId) {
  forgetUser(userId);
  await withAppTables(env, () => env.DB.prepare("DELETE FROM api_calls WHERE user_id = ?1").bind(userId).run());
  await env.DB.batch([
    env.DB.prepare("DELETE FROM key_usage WHERE user_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM api_keys WHERE user_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?1").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId),
  ]);
}
