// Limits that keep one account, or anonymous traffic, from using up what the whole site depends on.
//   Per account:   REQUESTS_PER_MINUTE, a daily request allowance, and a daily AI allowance (see ai.js).
//   Whole site:    a daily request ceiling that leaves database writes free for sign-ins and key changes.
//   Anonymous:     failed or credential-less calls, per IP address. The address is never stored.
// The single admin account (config.js) is exempt from all of these.

import { isAdmin } from "./config.js";
import { TtlCache, WindowLimiter } from "./memo.js";
import { withAppTables } from "./schema.js";

export const REQUESTS_PER_MINUTE = 60; // keep in step with RATE_LIMITER in wrangler.toml
export const ANONYMOUS_PER_MINUTE = 60; // keep in step with ANON_LIMITER in wrangler.toml
export const DEFAULT_USER_DAILY_REQUESTS = 1500;
export const DEFAULT_SITE_DAILY_REQUESTS = 15000; // about 4 database rows each, under the free 100,000 a day
const QUOTA_TTL_MS = 30_000;
const SITE_TTL_MS = 60_000;

export class ServiceError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** An error from Code Search's own limits. Such calls write nothing, so being blocked costs no database quota. */
function limitError(code, message, retryAfter) {
  const err = new ServiceError(429, code, message, { retryAfter });
  err.ownLimit = true;
  return err;
}

export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

export function secondsUntilUtcMidnight(now = Date.now()) {
  return Math.max(1, Math.ceil((86_400_000 - (now % 86_400_000)) / 1000));
}

/** A non-negative number from a Worker variable, or the fallback when it is missing or invalid. */
export function numberVar(env, name, fallback) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------- Per minute ----------

const minuteLimiter = new WindowLimiter(REQUESTS_PER_MINUTE, 60_000);
const anonymousLimiter = new WindowLimiter(ANONYMOUS_PER_MINUTE, 60_000);

async function withinMinuteLimit(binding, limiter, key) {
  if (binding?.limit) {
    try {
      const { success } = await binding.limit({ key });
      return { ok: success, retryAfter: 60 };
    } catch (err) {
      console.error("Rate limiter binding failed, using in-memory fallback", String(err));
    }
  }
  return limiter.take(key);
}

/** Throws ServiceError(429) when the account exceeds REQUESTS_PER_MINUTE. The admin account has no limit. */
export async function enforceRateLimit(env, user) {
  if (isAdmin(env, user)) return;
  const r = await withinMinuteLimit(env.RATE_LIMITER, minuteLimiter, `u:${user.id}`);
  if (!r.ok) throw limitError("too_many_requests", `Slow down: at most ${REQUESTS_PER_MINUTE} requests per minute per account.`, r.retryAfter);
}

/** Seconds to wait if this anonymous caller is over its limit, otherwise 0. */
export async function anonymousRetryAfter(env, request) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return 0; // only local development has no address
  const r = await withinMinuteLimit(env.ANON_LIMITER, anonymousLimiter, `ip:${ip}`);
  return r.ok ? 0 : r.retryAfter;
}

// ---------- Per day ----------

const quotas = new TtlCache(5000);
const site = new TtlCache(1);

export const userDailyRequests = (env) => numberVar(env, "USER_DAILY_REQUESTS", DEFAULT_USER_DAILY_REQUESTS);
export const siteDailyRequests = (env) => numberVar(env, "SITE_DAILY_REQUESTS", DEFAULT_SITE_DAILY_REQUESTS);

async function userRequestsToday(env, userId, day) {
  const key = `${day}:${userId}`;
  let entry = quotas.get(key);
  if (!entry) {
    const row = await withAppTables(env, () => env.DB.prepare("SELECT requests FROM user_daily WHERE day = ?1 AND user_id = ?2").bind(day, userId).first());
    entry = { requests: row?.requests ?? 0 };
    quotas.set(key, entry, QUOTA_TTL_MS);
  }
  return entry;
}

async function siteRequestsToday(env, day) {
  const hit = site.get(day);
  if (hit) return hit;
  const adminId = Number(env.ADMIN_GITHUB_ID) || -1;
  const row = await withAppTables(env, () =>
    env.DB.prepare("SELECT COALESCE(SUM(requests), 0) AS n FROM user_daily WHERE day = ?1 AND user_id <> ?2").bind(day, adminId).first(),
  );
  const value = { requests: row?.n ?? 0 };
  site.set(day, value, SITE_TTL_MS);
  return value;
}

/** True once the site is known to be at its daily ceiling, when even the admin's calls stop being written down. */
export function siteIsFull(env, now = Date.now()) {
  const known = site.get(utcDay(now));
  return Boolean(known) && known.requests >= siteDailyRequests(env);
}

/** Throws ServiceError(429) when the account or the site has used today's allowance. The admin account has no limit. */
export async function enforceDailyLimits(env, user, now = Date.now()) {
  if (isAdmin(env, user)) return;
  const day = utcDay(now);
  let mine;
  let all;
  try {
    [mine, all] = await Promise.all([userRequestsToday(env, user.id, day), siteRequestsToday(env, day)]);
  } catch (err) {
    console.error("Could not read daily usage", String(err)); // the per-minute limit still applies
    return;
  }
  const retryAfter = secondsUntilUtcMidnight(now);
  if (mine.requests >= userDailyRequests(env)) {
    throw limitError("daily_limit", `This account has used its ${userDailyRequests(env)} requests for today. The allowance resets at 00:00 UTC.`, retryAfter);
  }
  if (all.requests >= siteDailyRequests(env)) {
    throw limitError("site_daily_limit", "Code Search has reached its capacity for today. It resets at 00:00 UTC.", retryAfter);
  }
  mine.requests += 1; // counted here too, so one busy isolate stops at the limit without waiting for a re-read
  all.requests += 1;
}

export async function enforceLimits(env, user) {
  await enforceRateLimit(env, user);
  await enforceDailyLimits(env, user);
}

const UPSERT_DAY = `INSERT INTO user_daily (day, user_id, requests, searches, failed, ai_searches, last_call)
  VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6)
  ON CONFLICT (day, user_id) DO UPDATE SET requests = requests + 1, searches = searches + excluded.searches,
    failed = failed + excluded.failed, ai_searches = ai_searches + excluded.ai_searches, last_call = excluded.last_call`;

/** The statement that counts one finished request. */
export function countRequestStatement(env, userId, { search, failed, ai }, now = Date.now()) {
  return env.DB.prepare(UPSERT_DAY).bind(utcDay(now), userId, search ? 1 : 0, failed ? 1 : 0, ai ? 1 : 0, now);
}
