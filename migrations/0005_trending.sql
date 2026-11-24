-- Trending library: hand-picked repositories per use case. A search that matches a use case shows these first.
CREATE TABLE IF NOT EXISTS trending_repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  use_case      TEXT    NOT NULL,          -- e.g. "Web scraping"
  repo          TEXT    NOT NULL,          -- owner/name as GitHub spells it
  keywords      TEXT    NOT NULL,          -- JSON array of lower-case words or phrases that trigger this use case
  position      INTEGER NOT NULL DEFAULT 0, -- lower shows first within a use case
  data          TEXT    NOT NULL,          -- JSON snapshot of the repository (name, stars, description, ...)
  added_at      INTEGER NOT NULL,
  added_by      TEXT,
  refreshed_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS trending_repos_case_repo ON trending_repos(use_case COLLATE NOCASE, repo COLLATE NOCASE);
