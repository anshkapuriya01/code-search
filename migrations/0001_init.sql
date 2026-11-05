-- Users who signed in with GitHub. id is the GitHub user id.
CREATE TABLE users (
  id          INTEGER PRIMARY KEY,
  login       TEXT    NOT NULL,
  name        TEXT,
  avatar_url  TEXT,
  token_enc   TEXT    NOT NULL,          -- GitHub OAuth token, AES-GCM encrypted
  created_at  INTEGER NOT NULL,          -- ms since epoch
  updated_at  INTEGER NOT NULL
);

-- Browser sessions. Only a SHA-256 hash of the session token is stored.
CREATE TABLE sessions (
  id_hash     TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);

-- API keys users create for programmatic access. Only a SHA-256 hash is stored.
CREATE TABLE api_keys (
  id            TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  key_hash      TEXT    NOT NULL UNIQUE,
  prefix        TEXT    NOT NULL,        -- first characters, shown in the UI to identify the key
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE INDEX api_keys_user_id ON api_keys(user_id);
