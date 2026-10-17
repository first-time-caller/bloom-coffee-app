-- Bloom backend schema v1
CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,          -- stored lowercased
  name        TEXT NOT NULL DEFAULT '',
  pw_hash     TEXT NOT NULL,                 -- pbkdf2$sha256$<iterations>$<salt b64>$<hash b64>
  seq         INTEGER NOT NULL DEFAULT 0,    -- per-user monotonic change counter
  created_at  TEXT NOT NULL
);

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,             -- SHA-256 (hex) of the opaque bearer token
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,             -- epoch ms
  last_used_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE docs (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        TEXT,                          -- JSON; NULL for tombstones
  deleted     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,                 -- server ISO timestamp
  seq         INTEGER NOT NULL,              -- users.seq value at the time of this write
  PRIMARY KEY (user_id, collection, id)
);
CREATE INDEX docs_user_seq ON docs(user_id, seq);

CREATE TABLE shots (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  machine_id  TEXT NOT NULL,
  shot_id     TEXT NOT NULL,
  data        BLOB NOT NULL,                 -- raw .slog bytes
  size        INTEGER NOT NULL,
  meta        TEXT,                          -- optional JSON summary
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, machine_id, shot_id)
);

CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,             -- epoch ms
  count        INTEGER NOT NULL
);
