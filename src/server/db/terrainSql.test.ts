/**
 * Macro terrain C4 — `terrain_records`: TERRAIN_RECORD_PUT is an absolute
 * upsert keyed on (sector, rock), and `loadTerrainRecords` reads back one
 * sector's rows as the cut field loads them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { SCHEMA_SQL } from './schema.js';
import { SyncSinkAdapter } from './SyncSinkAdapter.js';
import { LINEAGE_SERIAL_ROW_KEY, lineageRowKey, loadTerrainRecords, terrainRecordStore } from './terrainSql.js';
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
      { rockKey: -5, layoutVersion: 1, pool: null, consumed: true, pose: null, lineage: null },
      { rockKey: 2_022_047_744, layoutVersion: 1, pool: 37.5, consumed: false, pose: null, lineage: null },
    ]);
    expect(loadTerrainRecords(db as never, 'none')).toEqual([]);
  });

  it('a PUT for the same rock replaces its row (absolute upsert, idempotent replay)', () => {
    sink.enqueueCritical(put('a', 3, 50, false));
    sink.enqueueCritical(put('a', 3, 20, false));
    sink.enqueueCritical(put('a', 3, null, true, 2));
    sink.enqueueCritical(put('a', 3, null, true, 2));
    expect(loadTerrainRecords(db as never, 'a')).toEqual([{ rockKey: 3, layoutVersion: 2, pool: null, consumed: true, pose: null, lineage: null }]);
    expect(db.prepare('SELECT updated_at FROM terrain_records').get()).toEqual({ updated_at: 7 });
  });

  it('round-trips where a moved rock was left (C2 deep sleep), and a later PUT clears it', () => {
    sink.enqueueCritical(put('a', 4, 20, false, 1, { x: 1234.5, y: -6.25, angle: -0.75 }));
    expect(loadTerrainRecords(db as never, 'a')).toEqual([{ rockKey: 4, layoutVersion: 1, pool: 20, consumed: false, pose: { x: 1234.5, y: -6.25, angle: -0.75 }, lineage: null }]);
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
    expect(loadTerrainRecords(old as never, 'a')).toEqual([{ rockKey: 1, layoutVersion: 1, pool: 5, consumed: false, pose: null, lineage: null }]);
    new SyncSinkAdapter(old as never).enqueueCritical(put('a', 1, 5, false, 1, { x: 1, y: 2, angle: 3 }));
    expect(loadTerrainRecords(old as never, 'a')[0]!.pose).toEqual({ x: 1, y: 2, angle: 3 });
  });

  it('a store whose SELECT fails loads nothing and warns (a boot never throws on it)', () => {
    const warns: unknown[] = [];
    const broken = { prepare: () => { throw new Error('no such table'); } };
    const store = terrainRecordStore('a', broken as never, sink, { warn: (f) => { warns.push(f); } }, () => 0);
    expect(store.load()).toEqual([]);
    expect(warns).toHaveLength(1);
  });
});

describe('terrain_records: battle-wreck lineage rows (wreck fields)', () => {
  let db: SqliteDb;
  let sink: SyncSinkAdapter;
  const noWarn = { warn: () => { throw new Error('unexpected warn'); } };
  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    sink = new SyncSinkAdapter(db as never);
  });

  it('round-trips lineage text; rock rows load with lineage null and stay out of lineages()', () => {
    const store = terrainRecordStore('a', db as never, sink, noWarn, () => 9);
    sink.enqueueCritical(put('a', 7, 12, false));
    const json = JSON.stringify({ v: 1, kind: 'battleship', pieces: [[1, 2]] });
    store.putLineage(3, json);
    expect(store.lineages()).toEqual([{ serial: 3, json }]);
    expect(store.load()).toEqual([{ rockKey: 7, layoutVersion: 1, pool: 12, consumed: false, pose: null, lineage: null }]);
    expect(loadTerrainRecords(db as never, 'a').find((r) => r.rockKey === lineageRowKey(3))!.lineage).toBe(json);
    expect(db.prepare('SELECT updated_at FROM terrain_records WHERE rock_key = -3').get()).toEqual({ updated_at: 9 });
  });

  it('a rock PUT without lineage leaves rock behaviour unchanged (absolute upsert writes NULL)', () => {
    sink.enqueueCritical({ ...put('a', 5, 1, false), lineage: 'x' } as PersistOp);
    sink.enqueueCritical(put('a', 5, 2, false));
    expect(loadTerrainRecords(db as never, 'a')).toEqual([{ rockKey: 5, layoutVersion: 1, pool: 2, consumed: false, pose: null, lineage: null }]);
  });

  it('TERRAIN_RECORD_DELETE removes exactly one row; a missing row is a no-op', () => {
    const store = terrainRecordStore('a', db as never, sink, noWarn, () => 0);
    sink.enqueueCritical(put('a', 7, 12, false));
    sink.enqueueCritical(put('b', -1, null, false));
    store.putLineage(1, '{}');
    store.putLineage(2, '{"b":1}');
    store.deleteRecord(lineageRowKey(1));
    store.deleteRecord(lineageRowKey(99));
    expect(store.lineages()).toEqual([{ serial: 2, json: '{"b":1}' }]);
    expect(store.load().map((r) => r.rockKey)).toEqual([7]);
    expect(loadTerrainRecords(db as never, 'b')).toHaveLength(1);
  });

  it('the serial counts up per partition, lives in row 0, and survives a reload', () => {
    const a = terrainRecordStore('a', db as never, sink, noWarn, () => 0);
    expect([a.nextLineageSerial(), a.nextLineageSerial(), a.nextLineageSerial()]).toEqual([1, 2, 3]);
    expect(terrainRecordStore('b', db as never, sink, noWarn, () => 0).nextLineageSerial()).toBe(1);
    const row0 = loadTerrainRecords(db as never, 'a').find((r) => r.rockKey === LINEAGE_SERIAL_ROW_KEY)!;
    expect(row0).toMatchObject({ pool: 4, lineage: null });
    expect(a.load()).toEqual([]); // the serial row is never read as a rock
    // A restart: a fresh store reads the saved serial.
    expect(terrainRecordStore('a', db as never, sink, noWarn, () => 0).nextLineageSerial()).toBe(4);
  });

  it('a lost serial row never reissues a saved lineage serial', () => {
    const a = terrainRecordStore('a', db as never, sink, noWarn, () => 0);
    a.putLineage(7, '{}');
    expect(a.nextLineageSerial()).toBe(8);
  });

  it('the migration adds lineage to an existing table and is idempotent on a fresh one', async () => {
    const { PLAYER_SHIPS_MIGRATIONS } = await import('./schema.js');
    const migrate = (d: SqliteDb) => {
      for (const sql of PLAYER_SHIPS_MIGRATIONS) { try { d.exec(sql); } catch (err) { if (!/duplicate column name/i.test(String(err))) throw err; } }
    };
    const old = new DatabaseSync(':memory:');
    old.exec('CREATE TABLE terrain_records (sector_key TEXT NOT NULL, rock_key INTEGER NOT NULL, layout_version INTEGER NOT NULL, pool REAL, consumed INTEGER NOT NULL, updated_at INTEGER NOT NULL, pose_x REAL, pose_y REAL, pose_angle REAL, PRIMARY KEY (sector_key, rock_key))');
    old.exec("INSERT INTO terrain_records VALUES ('a', 1, 1, 5, 0, 1, NULL, NULL, NULL)");
    old.exec(SCHEMA_SQL);
    migrate(old);
    migrate(old);
    expect(loadTerrainRecords(old as never, 'a')).toEqual([{ rockKey: 1, layoutVersion: 1, pool: 5, consumed: false, pose: null, lineage: null }]);
    const s = terrainRecordStore('a', old as never, new SyncSinkAdapter(old as never), noWarn, () => 0);
    s.putLineage(s.nextLineageSerial(), '{"ok":true}');
    expect(s.lineages()).toEqual([{ serial: 1, json: '{"ok":true}' }]);
    migrate(db); // fresh DB: every ALTER is a duplicate column, skipped
    expect((db.prepare('PRAGMA table_info(terrain_records)').all() as Array<{ name: string }>).filter((c) => c.name === 'lineage')).toHaveLength(1);
  });
});
