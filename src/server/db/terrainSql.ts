/**
 * Macro terrain C4 — the `terrain_records` table: a cut field's change record
 * by rock key (ore left in a mined rock, rocks broken up, where a moved rock
 * was left). The SQL is shared by
 * BOTH writers (the production `dbWorker` and the test `SyncSinkAdapter`) so the
 * two can never drift (#15). Imports nothing at runtime: the DB worker bundles
 * this file. How it works: docs/architecture/macro-terrain.md.
 *
 * Wreck fields share the table (one partition = one field key): a battle
 * wreck's lineage row has `rock_key = -serial` (rock keys are u32, so never
 * negative) and its JSON record in `lineage`; the reserved row `rock_key = 0`
 * (`LINEAGE_SERIAL_ROW_KEY`) holds the partition's next serial in `pool`.
 * Rock rows have `lineage` NULL.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';

export const TERRAIN_RECORD_PUT_SQL =
  'INSERT INTO terrain_records (sector_key, rock_key, layout_version, pool, consumed, updated_at, pose_x, pose_y, pose_angle, lineage) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(sector_key, rock_key) DO UPDATE SET layout_version=excluded.layout_version, ' +
  'pool=excluded.pool, consumed=excluded.consumed, updated_at=excluded.updated_at, ' +
  'pose_x=excluded.pose_x, pose_y=excluded.pose_y, pose_angle=excluded.pose_angle, lineage=excluded.lineage';

export const TERRAIN_RECORD_DELETE_SQL = 'DELETE FROM terrain_records WHERE sector_key = ? AND rock_key = ?';

/** The partition's reserved row: its `pool` holds the next lineage serial.
 *  Rock key 0 is chunk (-128, -128), index 0: far outside any field. */
export const LINEAGE_SERIAL_ROW_KEY = 0;

/** A lineage row's rock key: the negated serial (serials start at 1). */
export function lineageRowKey(serial: number): number { return -serial; }

type TerrainRecordPutOp = Extract<PersistOp, { type: 'TERRAIN_RECORD_PUT' }>;

export function terrainRecordPutArgs(op: TerrainRecordPutOp): Array<string | number | null> {
  const p = op.pose;
  return [op.sectorKey, op.rockKey, op.layoutVersion, op.pool, op.consumed ? 1 : 0, op.ts, p ? p.x : null, p ? p.y : null, p ? p.angle : null, op.lineage ?? null];
}

type TerrainRecordDeleteOp = Extract<PersistOp, { type: 'TERRAIN_RECORD_DELETE' }>;

export function terrainRecordDeleteArgs(op: TerrainRecordDeleteOp): Array<string | number> {
  return [op.sectorKey, op.rockKey];
}

/** One saved rock, as the cut field reads it back. */
export interface TerrainRecordRow {
  rockKey: number;
  layoutVersion: number;
  /** Ore left in a mined rock (null: none recorded). */
  pool: number | null;
  consumed: boolean;
  /** Where a moved rock was left (C2 deep sleep); null: its cut pose. */
  pose: { x: number; y: number; angle: number } | null;
  /** A battle wreck's lineage record (JSON text) on a lineage row; null on
   *  rock rows and the reserved serial row. */
  lineage: string | null;
}

/** A rock row: not a lineage row, not the reserved serial row. */
export function isRockRow(r: TerrainRecordRow): boolean {
  return r.lineage === null && r.rockKey !== LINEAGE_SERIAL_ROW_KEY;
}

/** Every saved rock of one sector, any layout version (the cut field drops
 *  the ones cut under another `FIELD_LAYOUT_VERSION`). Read-only: boot only. */
export function loadTerrainRecords(db: Pick<DatabaseSync, 'prepare'>, sectorKey: string): TerrainRecordRow[] {
  const rows = db
    .prepare('SELECT rock_key, layout_version, pool, consumed, pose_x, pose_y, pose_angle, lineage FROM terrain_records WHERE sector_key = ?')
    .all(sectorKey) as Array<{ rock_key: number; layout_version: number; pool: number | null; consumed: number; pose_x: number | null; pose_y: number | null; pose_angle: number | null; lineage: string | null }>;
  return rows.map((r) => ({
    rockKey: r.rock_key, layoutVersion: r.layout_version, pool: r.pool, consumed: r.consumed !== 0,
    pose: r.pose_x !== null && r.pose_y !== null && r.pose_angle !== null ? { x: r.pose_x, y: r.pose_y, angle: r.pose_angle } : null,
    lineage: r.lineage,
  }));
}

/** A cut field's save: what `CutFieldSubsystem` gets in a room that persists
 *  (a galaxy sector key, `persistSector` on). Loads through the main thread's
 *  read-only connection, writes on the CRITICAL lane. */
export interface RockRecordStore {
  readonly sectorKey: string;
  /** The partition's rock rows only (lineage rows and the serial row are
   *  left out, so the cut field never reads them as rocks). */
  load(): readonly TerrainRecordRow[];
  put(op: TerrainRecordPutOp): void;
  warn(fields: object, msg: string): void;
}

/** A partition's saved rows cut under `version`, once when its chunk source
 *  starts (wreck fields R10: every partition loads through this). Rows cut
 *  under another version name other things: skipped with one warning, and
 *  overwritten if their key is written again. */
export function loadRecords(store: RockRecordStore, version: number): TerrainRecordRow[] {
  const out: TerrainRecordRow[] = [];
  let stale = 0;
  for (const r of store.load()) {
    if (r.layoutVersion !== version) stale++;
    else out.push(r);
  }
  if (stale > 0) store.warn({ sectorKey: store.sectorKey, stale, layoutVersion: version }, 'terrain_records: rows from another layout version ignored');
  return out;
}

/** The whole store: the rock half plus the battle-wreck lineage rows of the
 *  same partition (wreck fields). */
export interface TerrainRecordStore extends RockRecordStore {
  /** Wreck fields — the next battle-wreck lineage serial of this partition
   *  (1, 2, ...). Read once from the save (the serial row, or past the highest
   *  lineage row), then counted in memory; each call saves the new next value
   *  to the reserved row, so serials never repeat across a restart. */
  nextLineageSerial(): number;
  /** Saves a lineage record (JSON text) under its serial (absolute upsert). */
  putLineage(serial: number, json: string): void;
  /** Removes one row by rock key (`lineageRowKey(serial)` for a lineage). */
  deleteRecord(rockKey: number): void;
  /** Every saved lineage of this partition, by serial ascending. */
  lineages(): Array<{ serial: number; json: string }>;
}

export function terrainRecordStore(
  sectorKey: string,
  db: Pick<DatabaseSync, 'prepare'>,
  sink: IPersistenceSink,
  logger: { warn(fields: object, msg: string): void },
  /** Stamps `updated_at` on the lineage/serial writes (game time; injected so
   *  this file keeps no runtime import). */
  now: () => number,
): TerrainRecordStore {
  const all = (): TerrainRecordRow[] => {
    try { return loadTerrainRecords(db, sectorKey); } catch (err) {
      logger.warn({ err, sectorKey, table: 'terrain_records' }, 'terrain_records SELECT failed (treating as empty)');
      return [];
    }
  };
  let nextSerial = 0; // 0: not read yet
  return {
    sectorKey,
    load: () => all().filter(isRockRow),
    put: (op) => { sink.enqueueCritical(op); },
    warn: (fields, msg) => { logger.warn(fields, msg); },
    nextLineageSerial: () => {
      if (nextSerial === 0) {
        nextSerial = 1;
        for (const r of all()) {
          if (r.rockKey === LINEAGE_SERIAL_ROW_KEY && r.pool !== null) nextSerial = Math.max(nextSerial, Math.floor(r.pool));
          else if (r.lineage !== null && r.rockKey < 0) nextSerial = Math.max(nextSerial, -r.rockKey + 1);
        }
      }
      const serial = nextSerial++;
      sink.enqueueCritical({
        type: 'TERRAIN_RECORD_PUT', sectorKey, rockKey: LINEAGE_SERIAL_ROW_KEY, layoutVersion: 0,
        pool: nextSerial, consumed: false, pose: null, lineage: null, ts: now(),
      });
      return serial;
    },
    putLineage: (serial, json) => {
      sink.enqueueCritical({
        type: 'TERRAIN_RECORD_PUT', sectorKey, rockKey: lineageRowKey(serial), layoutVersion: 0,
        pool: null, consumed: false, pose: null, lineage: json, ts: now(),
      });
    },
    deleteRecord: (rockKey) => { sink.enqueueCritical({ type: 'TERRAIN_RECORD_DELETE', sectorKey, rockKey, ts: now() }); },
    lineages: () => all()
      .filter((r) => r.lineage !== null)
      .map((r) => ({ serial: -r.rockKey, json: r.lineage as string }))
      .sort((a, b) => a.serial - b.serial),
  };
}
