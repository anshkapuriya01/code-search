-- Each account's use per UTC day: enforces the daily limits and feeds the admin totals. No search text.
CREATE TABLE IF NOT EXISTS user_daily (
  day          TEXT    NOT NULL,          -- YYYY-MM-DD
  user_id      INTEGER NOT NULL,          -- GitHub user id
  requests     INTEGER NOT NULL DEFAULT 0,
  searches     INTEGER NOT NULL DEFAULT 0,
  failed       INTEGER NOT NULL DEFAULT 0,
  ai_searches  INTEGER NOT NULL DEFAULT 0,
  neurons      REAL    NOT NULL DEFAULT 0,
  last_call    INTEGER,                   -- ms since epoch
  PRIMARY KEY (day, user_id)
);
