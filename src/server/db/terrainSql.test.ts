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

function put(sectorKey: string, rockKey: number, pool: number | null, consumed: boolean, layoutVersion = 1): PersistOp {
  return { type: 'TERRAIN_RECORD_PUT', sectorKey, rockKey, layoutVersion, pool, consumed, ts: 7 };
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
      { rockKey: -5, layoutVersion: 1, pool: null, consumed: true },
      { rockKey: 2_022_047_744, layoutVersion: 1, pool: 37.5, consumed: false },
    ]);
    expect(loadTerrainRecords(db as never, 'none')).toEqual([]);
  });

  it('a PUT for the same rock replaces its row (absolute upsert, idempotent replay)', () => {
    sink.enqueueCritical(put('a', 3, 50, false));
    sink.enqueueCritical(put('a', 3, 20, false));
    sink.enqueueCritical(put('a', 3, null, true, 2));
    sink.enqueueCritical(put('a', 3, null, true, 2));
    expect(loadTerrainRecords(db as never, 'a')).toEqual([{ rockKey: 3, layoutVersion: 2, pool: null, consumed: true }]);
    expect(db.prepare('SELECT updated_at FROM terrain_records').get()).toEqual({ updated_at: 7 });
  });

  it('a store whose SELECT fails loads nothing and warns (a boot never throws on it)', () => {
    const warns: unknown[] = [];
    const broken = { prepare: () => { throw new Error('no such table'); } };
    const store = terrainRecordStore('a', broken as never, sink, { warn: (f) => { warns.push(f); } });
    expect(store.load()).toEqual([]);
    expect(warns).toHaveLength(1);
  });
});
