#!/usr/bin/env node
/**
 * Ad-hoc dev tool — delete every row from the Limbo table. Used during
 * smoke-testing when a stuck ship-kind selection needs to be cleared
 * without nuking the whole `eqx.db` (auth + snapshots survive).
 *
 * Usage: node scripts/clear-limbo.mjs
 *
 * Server must NOT be running (`tsx watch` will release the WAL lock on
 * SIGTERM). Re-boot the server afterward; on next `onJoin` the player's
 * `Limbo.take` returns null and they get a fresh ship-pick.
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dbPath = resolve(here, '..', 'eqx.db');

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
const before = db.prepare('SELECT COUNT(*) AS n FROM limbo').get();
db.prepare('DELETE FROM limbo').run();
const after = db.prepare('SELECT COUNT(*) AS n FROM limbo').get();
console.log(JSON.stringify({ dbPath, before: before.n, after: after.n }));
db.close();
