/**
 * Macro terrain C4 — `terrain_records`: TERRAIN_RECORD_PUT is an absolute
 * upsert keyed on (sector, rock), and `loadTerrainRecords` reads back one
 * sector's rows as the cut field loads them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.js';
import { SyncSinkAdapter } from './SyncSinkAdapter.js';
import { loadTerrainRecords, terrainRecordStore } from './terrainSql.js';
import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';

interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[]; run(...p: unknown[]): unknown };
}
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (f: string) => SqliteDb };

function put(sectorKey: string, rockKey: number, pool: number | null, consumed: boolean, layoutVersion = 1, pose: { x: number; y: number; angle: number } | null = null): PersistOp {
  return { type: 'TERRAIN_RECORD_PUT', sectorKey, rockKey, layoutVersion, pool, consumed, pose, ts: 7 };
}

describe('terrain_records (C4)', () => {
  let db: SqliteDb;
  let sink: SyncSinkAdapter;
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    sink = new SyncSinkAdapter(db as never);
  });

  it('round-trips a mined rock and a consumed rock, per sector', () => {
    sink.enqueueCritical(put('a', 2_022_047_744, 37.5, false));
    sink.enqueueCritical(put('a', -5, null, true));
    sink.enqueueCritical(put('b', 9, 1, false));
    const rows = loadTerrainRecords(db as never, 'a').sort((x, y) => x.rockKey - y.rockKey);
    expect(rows).toEqual([
      { rockKey: -5, layoutVersion: 1, pool: null, consumed: true, pose: null },
      { rockKey: 2_022_047_744, layoutVersion: 1, pool: 37.5, consumed: false, pose: null },
    ]);
    expect(loadTerrainRecords(db as never, 'none')).toEqual([]);
  });

  it('a PUT for the same rock replaces its row (absolute upsert, idempotent replay)', () => {
    sink.enqueueCritical(put('a', 3, 50, false));
    sink.enqueueCritical(put('a', 3, 20, false));
    sink.enqueueCritical(put('a', 3, null, true, 2));
    sink.enqueueCritical(put('a', 3, null, true, 2));
    expect(loadTerrainRecords(db as never, 'a')).toEqual([{ rockKey: 3, layoutVersion: 2, pool: null, consumed: true, pose: null }]);
    expect(db.prepare('SELECT updated_at FROM terrain_records').get()).toEqual({ updated_at: 7 });
  });

  it('round-trips where a moved rock was left (C2 deep sleep), and a later PUT clears it', () => {
    sink.enqueueCritical(put('a', 4, 20, false, 1, { x: 1234.5, y: -6.25, angle: -0.75 }));
    expect(loadTerrainRecords(db as never, 'a')).toEqual([{ rockKey: 4, layoutVersion: 1, pool: 20, consumed: false, pose: { x: 1234.5, y: -6.25, angle: -0.75 } }]);
    sink.enqueueCritical(put('a', 4, 20, false));
    expect(loadTerrainRecords(db as never, 'a')[0]!.pose).toBeNull();
  });

  it('a table from before deep sleep gains the pose columns (the migration list)', async () => {
    const { PLAYER_SHIPS_MIGRATIONS } = await import('./schema.js');
    const old = new DatabaseSync(':memory:');
    old.exec('CREATE TABLE terrain_records (sector_key TEXT NOT NULL, rock_key INTEGER NOT NULL, layout_version INTEGER NOT NULL, pool REAL, consumed INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (sector_key, rock_key))');
    old.exec("INSERT INTO terrain_records VALUES ('a', 1, 1, 5, 0, 1)");
    old.exec(SCHEMA_SQL);
    for (const sql of PLAYER_SHIPS_MIGRATIONS) { try { old.exec(sql); } catch (err) { if (!/duplicate column name/i.test(String(err))) throw err; } }
    expect(loadTerrainRecords(old as never, 'a')).toEqual([{ rockKey: 1, layoutVersion: 1, pool: 5, consumed: false, pose: null }]);
    new SyncSinkAdapter(old as never).enqueueCritical(put('a', 1, 5, false, 1, { x: 1, y: 2, angle: 3 }));
    expect(loadTerrainRecords(old as never, 'a')[0]!.pose).toEqual({ x: 1, y: 2, angle: 3 });
  });

  it('a store whose SELECT fails loads nothing and warns (a boot never throws on it)', () => {
    const warns: unknown[] = [];
    const broken = { prepare: () => { throw new Error('no such table'); } };
    const store = terrainRecordStore('a', broken as never, sink, { warn: (f) => { warns.push(f); } });
    expect(store.load()).toEqual([]);
    expect(warns).toHaveLength(1);
  });
});
