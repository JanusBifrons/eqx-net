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

CREATE TABLE IF NOT EXISTS limbo (
  player_id    TEXT PRIMARY KEY,
  user_id      TEXT,
  sector_key   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_limbo_expires_at ON limbo(expires_at);

-- Phase 2 multi-ship roster. Persistent per-ship state — a player owns up
-- to 10 ships, each with its own kind, health, last-known pose, and
-- last-known sector. Replaces (and will eventually retire) the per-player
-- limbo table; for now the two coexist while gameplay wiring catches up.
CREATE TABLE IF NOT EXISTS player_ships (
  ship_id               TEXT PRIMARY KEY,
  player_id             TEXT NOT NULL,
  user_id               TEXT,
  kind                  TEXT NOT NULL,
  kind_version          INTEGER NOT NULL DEFAULT 1,
  health                REAL NOT NULL,
  last_sector_key       TEXT NOT NULL,
  last_x                REAL NOT NULL,
  last_y                REAL NOT NULL,
  last_vx               REAL NOT NULL,
  last_vy               REAL NOT NULL,
  last_angle            REAL NOT NULL,
  last_angvel           REAL NOT NULL,
  last_fire_client_tick INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 0,
  active_room_id        TEXT,
  expires_at            INTEGER NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_ships_player  ON player_ships(player_id);
CREATE INDEX IF NOT EXISTS idx_player_ships_expires ON player_ships(expires_at);
CREATE INDEX IF NOT EXISTS idx_player_ships_active  ON player_ships(is_active, last_sector_key);

-- Phase 5 director-state persistence. A single row (id = 1) holding the
-- process-global LivingWorldDirector's abstract squad continuity, so a server
-- restart resumes the living world (squad sectors / targets / states + wave
-- bookkeeping) instead of re-seeding from scratch. payload_json is a
-- JSON.stringify'd DirectorStatePayload; only the latest write is kept (UPSERT).
CREATE TABLE IF NOT EXISTS director_state (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Web Push subscriptions (PWA notifications, e.g. "your base is under attack").
-- One row per browser push endpoint; a user may have several (phone + desktop).
-- Keyed on the unique endpoint URL so a re-subscribe from the same device is an
-- UPSERT, not a duplicate. Rows are pruned when the push service reports the
-- endpoint is gone (HTTP 404/410). See src/server/push/.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id),
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);
`;
