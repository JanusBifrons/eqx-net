#!/usr/bin/env node
/**
 * Ad-hoc dev tool — wipe every persisted sector snapshot AND every
 * Limbo entry, so each galaxy sector re-seeds at its sunflower-spiral
 * defaults on next room creation (30 drones at random positions inside
 * the playable bound). Useful when drones have accumulated near the
 * sector boundary and are thrashing the clamp logic (Phase 4b smoke
 * test, 2026-05-11).
 *
 * Wipes:
 *   - `game_snapshots` — per-sector swarm state. Without a row, the
 *     `sector hydrated from snapshot` boot step skips and the room
 *     spawns the default seed wave.
 *   - `limbo` — held ship state across disconnects/transit. Without
 *     this, the player's previous ship pose / weapon choice is gone.
 *
 * Auth (`users`, `auth_providers`, `login_events`) is left intact, so
 * the user doesn't need to re-register.
 *
 * Usage: node scripts/reset-sectors.mjs
 *
 * Server must NOT be running (`tsx watch` will release the WAL lock on
 * SIGTERM). Re-boot the server afterward; on next sector creation each
 * `SectorRoom` finds no snapshot row and runs `seed()` instead of
 * `hydrateFromSnapshot()`.
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, '..', 'eqx.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
const before = {
  game_snapshots: db.prepare('SELECT COUNT(*) AS n FROM game_snapshots').get().n,
  limbo: db.prepare('SELECT COUNT(*) AS n FROM limbo').get().n,
};
db.prepare('DELETE FROM game_snapshots').run();
db.prepare('DELETE FROM limbo').run();
const after = {
  game_snapshots: db.prepare('SELECT COUNT(*) AS n FROM game_snapshots').get().n,
  limbo: db.prepare('SELECT COUNT(*) AS n FROM limbo').get().n,
};
console.log(JSON.stringify({ dbPath, before, after }, null, 2));
db.close();
