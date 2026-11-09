// API usage analytics: hourly call counts per key and endpoint, written in the background after each
// call (one D1 upsert, off the response path) and read by the dashboard's Usage view.
// Only counts and outcomes are stored, never the query text.

import { siteIsFull } from "./limits.js";

export const USAGE_RETENTION_DAYS = 90; // enforced daily by maintenance.js
export const ENDPOINTS = ["rest_search", "rest_readme", "mcp_search", "mcp_readme"];
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// Same as migrations/0002_key_usage.sql. Applied on demand when the table is missing (for example a deploy
// that skipped `npm run db:migrate:remote`), so usage tracking never silently stops working.
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS key_usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key_id TEXT NOT NULL, hour INTEGER NOT NULL, endpoint TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
    limited INTEGER NOT NULL DEFAULT 0, cached INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, key_id, hour, endpoint))`,
  "CREATE INDEX IF NOT EXISTS key_usage_user_hour ON key_usage(user_id, hour)",
];
let schemaReady = null;

function ensureSchema(env) {
  schemaReady ??= env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}

const isMissingTable = (err) => /no such table/i.test(String(err?.message ?? err));

/** Runs fn; if the usage table does not exist yet, creates it and runs fn once more. */
export async function withUsageTable(env, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.warn("key_usage table missing; creating it (run the D1 migrations to silence this)");
    await ensureSchema(env);
    return fn();
  }
}

const UPSERT = `INSERT INTO key_usage (user_id, key_id, hour, endpoint, calls, ok, errors, limited, cached)
  VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, ?7, ?8)
  ON CONFLICT (user_id, key_id, hour, endpoint) DO UPDATE SET
    calls = calls + 1, ok = ok + excluded.ok, errors = errors + excluded.errors,
    limited = limited + excluded.limited, cached = cached + excluded.cached`;

/** Outcome for an error thrown while serving a call. */
export function outcomeOf(err) {
  return err?.status === 429 ? "limited" : "error";
}

/**
 * Counts one call in the background. caller is { user, apiKey } from authenticate(); calls made in the
 * dashboard (cookie session, no key) are counted under key_id 'web'.
 */
export function recordCall(env, ctx, caller, endpoint, outcome, cached = false) {
  if (!env?.DB || !ctx?.waitUntil || !caller?.user || !ENDPOINTS.includes(endpoint) || siteIsFull(env)) return;
  const hour = Math.floor(Date.now() / HOUR_MS) * HOUR_MS;
  const keyId = caller.apiKey?.keyId ?? "web";
  const args = [caller.user.id, keyId, hour, endpoint, outcome === "ok" ? 1 : 0, outcome === "error" ? 1 : 0, outcome === "limited" ? 1 : 0, cached ? 1 : 0];
  const write = withUsageTable(env, () => env.DB.prepare(UPSERT).bind(...args).run()).catch((err) => console.error("Usage write failed", String(err)));
  ctx.waitUntil(write);
}

/** Parses ?days= (1, 7, 30 or 90; default 7). */
export function parseDays(raw) {
  const n = Number(raw ?? 7);
  return [1, 7, 30, 90].includes(n) ? n : null;
}

/** Usage rows for the user's last `days` days, plus their keys. */
export function usageFor(env, userId, days, keys) {
  return withUsageTable(env, () => readUsage(env, userId, days, keys));
}

async function readUsage(env, userId, days, keys) {
  const now = Date.now();
  const since = Math.floor((now - days * DAY_MS) / HOUR_MS) * HOUR_MS + HOUR_MS;
  const { results } = await env.DB.prepare(
    `SELECT key_id, hour, endpoint, calls, ok, errors, limited, cached FROM key_usage
     WHERE user_id = ?1 AND hour >= ?2 ORDER BY hour`,
  )
    .bind(userId, since)
    .all();
  const known = new Set(keys.map((k) => k.id));
  const revoked = [...new Set(results.map((r) => r.key_id))].filter((id) => id !== "web" && !known.has(id));
  return {
    days,
    since,
    now,
    retentionDays: USAGE_RETENTION_DAYS,
    keys: [
      ...keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, revoked: false })),
      ...revoked.map((id) => ({ id, name: "Revoked key", prefix: null, revoked: true })),
    ],
    rows: results.map((r) => ({
      keyId: r.key_id,
      hour: r.hour,
      endpoint: r.endpoint,
      calls: r.calls,
      ok: r.ok,
      errors: r.errors,
      limited: r.limited,
      cached: r.cached,
    })),
  };
}
