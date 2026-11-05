-- Hourly API call counts per key, for the dashboard's Usage view. No query text is stored.
-- key_id is api_keys.id, or 'web' for searches made in the dashboard itself. Rows of revoked keys are
-- kept (shown as "Revoked key") until they age out after 90 days.
CREATE TABLE IF NOT EXISTS key_usage (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_id    TEXT    NOT NULL,
  hour      INTEGER NOT NULL,           -- start of the UTC hour, ms since epoch
  endpoint  TEXT    NOT NULL,           -- rest_search, rest_readme, mcp_search, mcp_readme
  calls     INTEGER NOT NULL DEFAULT 0,
  ok        INTEGER NOT NULL DEFAULT 0,
  errors    INTEGER NOT NULL DEFAULT 0,
  limited   INTEGER NOT NULL DEFAULT 0, -- answered 429 (GitHub's or Code Search's limit)
  cached    INTEGER NOT NULL DEFAULT 0, -- answered from cache, no GitHub quota used
  PRIMARY KEY (user_id, key_id, hour, endpoint)
);
CREATE INDEX IF NOT EXISTS key_usage_user_hour ON key_usage(user_id, hour);
