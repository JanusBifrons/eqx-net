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
  -- Phase 4 (Leveling & XP, WS-0). Per-ship-instance progression. Defaults
  -- (level 1 / xp 0 / empty JSON) make pre-Phase-4 rows hydrate cleanly; the
  -- companion idempotent ALTERs in PLAYER_SHIPS_MIGRATIONS add these columns
  -- to a DB created before this column block existed.
  level                 INTEGER NOT NULL DEFAULT 1,
  xp                    INTEGER NOT NULL DEFAULT 0,
  stat_alloc            TEXT NOT NULL DEFAULT '{}',
  mounts                TEXT NOT NULL DEFAULT '[]',
  hull_quality          INTEGER NOT NULL DEFAULT 0,
  auto_unload           INTEGER NOT NULL DEFAULT 1,
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

-- Living World P1b — per-allegiance director state for the NON-drone
-- directors (robots). The drone director keeps the singleton row above
-- (its CHECK can't be relaxed in place); every further side gets a row here.
CREATE TABLE IF NOT EXISTS allegiance_director_state (
  allegiance   TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- Living World P2 — economy. Memory (EconomyStore) is the authority; every
-- mutation is an absolute upsert. Per-player standing + trade history:
-- Economy v2 W1 — the virtual wallet: ONE credit balance per player (canonical
-- playerId). Credits never live in holds.
CREATE TABLE IF NOT EXISTS player_wallets (
  player_id   TEXT PRIMARY KEY,
  balance     INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS player_economy (
  player_id    TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
-- One row per trade deal (its in-flight run rides inside the payload; escrow
-- value lives in the holds table, written in the SAME atomic group):
CREATE TABLE IF NOT EXISTS trade_deals (
  deal_id      TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trade_deals_owner ON trade_deals(owner_id);
-- Galaxy-wide economy singletons (the market):
CREATE TABLE IF NOT EXISTS economy_state (
  key          TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

-- PR 3a — account-bound player identity. Each account has ONE canonical
-- playerId (the in-game identity that owns ships / structures / hulls), so
-- logging in on any device finds the same world. player_aliases records the
-- historical per-browser ids that belonged to an account; data persisted under
-- an alias is mapped to the canonical id when loaded.
CREATE TABLE IF NOT EXISTS account_players (
  user_id    TEXT PRIMARY KEY REFERENCES users(id),
  player_id  TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS player_aliases (
  alias_player_id     TEXT PRIMARY KEY,
  canonical_player_id TEXT NOT NULL,
  user_id             TEXT NOT NULL,
  created_at          INTEGER NOT NULL
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

-- Living World P1a (plan peppy-jumping-pinwheel) — the unified HOLD table.
-- Every unit of value (goods / credits / blueprints) lives in exactly one
-- holder's row: a ship instance, a loot pod, a storage structure, a hauler run.
-- holder_type: 'ship' | 'pod' | 'structure' | 'hauler'. Pods also persist their
-- sector + pose here (they are NOT in the sector snapshot — A3). Rows are
-- written as ABSOLUTE state (upsert), never deltas, so a replay is idempotent.
CREATE TABLE IF NOT EXISTS holds (
  holder_uid   TEXT PRIMARY KEY,
  holder_type  TEXT NOT NULL,
  owner_id     TEXT,
  sector_key   TEXT,
  x            REAL,
  y            REAL,
  payload_json TEXT NOT NULL,
  expires_at   INTEGER,
  updated_at   INTEGER NOT NULL,
  look         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_holds_sector ON holds(sector_key, holder_type);

-- Macro terrain C4 — a cut field's change record by rock key (the in-memory
-- record of CutFieldSubsystem, saved). A rock nobody touched has no row. Rows
-- cut under another layout_version (FIELD_LAYOUT_VERSION) are ignored on load.
-- pool: ore left in a mined rock (NULL: none recorded); consumed: 1 once the
-- rock is broken up (never cut whole again); pose_x/pose_y/pose_angle: where a
-- moved rock was left when its chunk unloaded (C2 deep sleep; NULL: its cut
-- pose). Absolute upserts, never deltas.
-- Wreck fields: lineage (JSON text) marks a battle-wreck lineage row (rock_key
-- = -serial); rock_key 0 is the reserved per-field serial row (next serial in
-- pool). Rock rows have lineage NULL. See terrainSql.ts.
CREATE TABLE IF NOT EXISTS terrain_records (
  sector_key     TEXT NOT NULL,
  rock_key       INTEGER NOT NULL,
  layout_version INTEGER NOT NULL,
  pool           REAL,
  consumed       INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  pose_x         REAL,
  pose_y         REAL,
  pose_angle     REAL,
  lineage        TEXT,
  PRIMARY KEY (sector_key, rock_key)
);
`;

/**
 * Idempotent column migrations applied AFTER `SCHEMA_SQL` in the DB worker
 * (the sole writer — see `dbWorker.ts`).
 *
 * `SCHEMA_SQL` uses `CREATE TABLE IF NOT EXISTS`, so a table created by an
 * older deploy is NOT re-created with new columns. SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so each statement here is run inside a
 * try/catch that swallows the "duplicate column name" error — that makes the
 * whole list idempotent (a fresh DB already has the columns from `SCHEMA_SQL`
 * and skips them; an old DB gains them).
 *
 * This mirrors the `kindVersion`-column precedent (it lived in the original
 * CREATE TABLE) but extends it to a true in-place migration so existing roster
 * rows survive the Phase 4 leveling/XP addition.
 */
export const PLAYER_SHIPS_MIGRATIONS: readonly string[] = [
  "ALTER TABLE player_ships ADD COLUMN level INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE player_ships ADD COLUMN xp INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE player_ships ADD COLUMN stat_alloc TEXT NOT NULL DEFAULT '{}'",
  "ALTER TABLE player_ships ADD COLUMN mounts TEXT NOT NULL DEFAULT '[]'",
  // Economy v2 — an unpacked hull's quality (a small max-hull bonus).
  "ALTER TABLE player_ships ADD COLUMN hull_quality INTEGER NOT NULL DEFAULT 0",
  // Cargo pods 14c — the ship auto-unloads at its owner's storage (1) or not (0).
  "ALTER TABLE player_ships ADD COLUMN auto_unload INTEGER NOT NULL DEFAULT 1",
  // Macro terrain C2 (deep sleep) — a moved field rock's saved pose.
  "ALTER TABLE terrain_records ADD COLUMN pose_x REAL",
  "ALTER TABLE terrain_records ADD COLUMN pose_y REAL",
  "ALTER TABLE terrain_records ADD COLUMN pose_angle REAL",
  // Wreck fields — a battle wreck's lineage record (JSON text; NULL on rocks).
  "ALTER TABLE terrain_records ADD COLUMN lineage TEXT",
  // Cargo pods — a pod's look (size class + glow tier), restored on restart.
  "ALTER TABLE holds ADD COLUMN look INTEGER",
];
