#!/usr/bin/env node
/**
 * Ad-hoc dev tool — delete every row from the `player_ships` table. Used
 * during smoke-testing when a stuck roster entry needs to be cleared
 * without nuking the whole `eqx.db` (auth + snapshots + limbo survive).
 *
 * Usage: node scripts/clear-roster.mjs
 *
 * Server must NOT be running (`tsx watch` will release the WAL lock on
 * SIGTERM). Re-boot the server afterward; on next galaxy-map mount the
 * /dev/player-ships endpoint will return `{ ships: [] }` and the player
 * will be back to a fresh-spawn flow.
 *
 * Companion to clear-limbo.mjs; both are safe to run independently.
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, '..', 'eqx.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
const before = db.prepare('SELECT COUNT(*) AS n FROM player_ships').get();
db.prepare('DELETE FROM player_ships').run();
const after = db.prepare('SELECT COUNT(*) AS n FROM player_ships').get();
console.log(JSON.stringify({ dbPath, before: before.n, after: after.n }));
db.close();
