export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  display_name TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_providers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  UNIQUE(provider, provider_id)
);

CREATE TABLE IF NOT EXISTS login_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  user_id    TEXT,
  success    INTEGER NOT NULL,
  provider   TEXT NOT NULL,
  ip         TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_sessions (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   TEXT REFERENCES users(id),
  play_id   TEXT NOT NULL,
  sector_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  left_at   INTEGER
);

CREATE TABLE IF NOT EXISTS player_kills (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  killer_user_id TEXT REFERENCES users(id),
  victim_user_id TEXT REFERENCES users(id),
  weapon         TEXT NOT NULL,
  sector_id      TEXT NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_snapshots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sector_id  TEXT NOT NULL,
  snapshot   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;
