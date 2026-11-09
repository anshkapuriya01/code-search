// Tables for the admin console, the API call log and AI usage. Same SQL as migrations/0003_admin_ai.sql.
// They are created on demand when missing (for example a deploy that ran before the migration), so a
// missing table can never break sign-in or search.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS ai_usage (
    day TEXT PRIMARY KEY, neurons REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, request_id TEXT,
    user_id INTEGER NOT NULL, user_login TEXT NOT NULL, key_id TEXT, key_name TEXT,
    source TEXT NOT NULL, action TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
    status INTEGER NOT NULL, outcome TEXT NOT NULL, error TEXT, duration_ms INTEGER NOT NULL,
    cached INTEGER NOT NULL DEFAULT 0, query_text TEXT, result_count INTEGER, ai_status TEXT,
    client TEXT, country TEXT, request_json TEXT, response_json TEXT)`,
  "CREATE INDEX IF NOT EXISTS api_calls_user ON api_calls(user_id, id)",
];

let ready = null;

function ensure(env) {
  ready ??= env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql))).catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

const isMissingTable = (err) => /no such table/i.test(String(err?.message ?? err));

/** Runs fn; if one of these tables does not exist yet, creates them and runs fn once more. */
export async function withAppTables(env, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isMissingTable(err)) throw err;
    console.warn("Admin tables missing; creating them (run the D1 migrations to silence this)");
    await ensure(env);
    return fn();
  }
}
