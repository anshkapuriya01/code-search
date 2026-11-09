-- Site-wide settings changed from the admin console, such as whether new users may register.
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT    NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
);

-- Workers AI spending per UTC day (the free allocation resets at 00:00 UTC).
CREATE TABLE IF NOT EXISTS ai_usage (
  day       TEXT    PRIMARY KEY,         -- YYYY-MM-DD
  neurons   REAL    NOT NULL DEFAULT 0,
  calls     INTEGER NOT NULL DEFAULT 0,
  failures  INTEGER NOT NULL DEFAULT 0
);

-- One row per API call by a signed-in user, for the admin console. No foreign key: blocked sign-ups have no
-- users row, and src/auth.js removes a user's rows when the account is deleted.
CREATE TABLE IF NOT EXISTS api_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,        -- ms since epoch
  request_id    TEXT,
  user_id       INTEGER NOT NULL,        -- GitHub user id
  user_login    TEXT    NOT NULL,
  key_id        TEXT,                    -- api_keys.id; NULL for dashboard calls
  key_name      TEXT,
  source        TEXT    NOT NULL,        -- web, rest, mcp, auth, admin
  action        TEXT    NOT NULL,        -- rest_search, mcp_readme, "POST /api/keys", ...
  method        TEXT    NOT NULL,
  path          TEXT    NOT NULL,
  status        INTEGER NOT NULL,
  outcome       TEXT    NOT NULL,        -- ok, error, limited
  error         TEXT,
  duration_ms   INTEGER NOT NULL,
  cached        INTEGER NOT NULL DEFAULT 0,
  query_text    TEXT,                    -- what was searched, or the repository whose README was read
  result_count  INTEGER,
  ai_status     TEXT,
  client        TEXT,                    -- User-Agent
  country       TEXT,
  request_json  TEXT,
  response_json TEXT                     -- what was returned; never contains an API key
);
CREATE INDEX IF NOT EXISTS api_calls_user ON api_calls(user_id, id);
