// Daily clean-up, run by the cron trigger in wrangler.toml. Retention no longer depends on how busy the site is
// or on anyone opening a page.

import { MAX_ROWS, RETENTION_DAYS, USER_LOG_ROWS } from "./audit.js";
import { utcDay } from "./limits.js";
import { withAppTables } from "./schema.js";
import { USAGE_RETENTION_DAYS, withUsageTable } from "./usage.js";

const DAY_MS = 86_400_000;
export const USER_DAILY_RETENTION_DAYS = 31;

async function attempt(name, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`Maintenance step failed: ${name}`, String(err)); // the other steps still run
  }
}

export async function runMaintenance(env, now = Date.now()) {
  const delete_ = (sql, ...args) => env.DB.prepare(sql).bind(...args).run();
  await attempt("log age", () => withAppTables(env, () => delete_("DELETE FROM api_calls WHERE ts < ?1", now - RETENTION_DAYS * DAY_MS)));
  await attempt("log size", () => withAppTables(env, () => delete_("DELETE FROM api_calls WHERE id <= (SELECT MAX(id) FROM api_calls) - ?1", MAX_ROWS)));
  await attempt("log share per account", () =>
    withAppTables(env, () =>
      delete_(
        `DELETE FROM api_calls WHERE id IN (
           SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY id DESC) AS newest FROM api_calls) WHERE newest > ?1)`,
        USER_LOG_ROWS,
      ),
    ),
  );
  await attempt("usage counts", () => withUsageTable(env, () => delete_("DELETE FROM key_usage WHERE hour < ?1", now - USAGE_RETENTION_DAYS * DAY_MS)));
  await attempt("sessions", () => delete_("DELETE FROM sessions WHERE expires_at <= ?1", now));
  await attempt("daily totals", () => withAppTables(env, () => delete_("DELETE FROM user_daily WHERE day < ?1", utcDay(now - USER_DAILY_RETENTION_DAYS * DAY_MS))));
  await attempt("AI usage", () => withAppTables(env, () => delete_("DELETE FROM ai_usage WHERE day < ?1", utcDay(now - USAGE_RETENTION_DAYS * DAY_MS))));
}
