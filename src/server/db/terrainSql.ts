/**
 * Macro terrain C4 — the `terrain_records` table: a cut field's change record
 * by rock key (ore left in a mined rock, rocks broken up, where a moved rock
 * was left). The SQL is shared by
 * BOTH writers (the production `dbWorker` and the test `SyncSinkAdapter`) so the
 * two can never drift (#15). Imports nothing at runtime: the DB worker bundles
 * this file. How it works: docs/architecture/macro-terrain.md.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';

export const TERRAIN_RECORD_PUT_SQL =
  'INSERT INTO terrain_records (sector_key, rock_key, layout_version, pool, consumed, updated_at, pose_x, pose_y, pose_angle) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(sector_key, rock_key) DO UPDATE SET layout_version=excluded.layout_version, ' +
  'pool=excluded.pool, consumed=excluded.consumed, updated_at=excluded.updated_at, ' +
  'pose_x=excluded.pose_x, pose_y=excluded.pose_y, pose_angle=excluded.pose_angle';

type TerrainRecordPutOp = Extract<PersistOp, { type: 'TERRAIN_RECORD_PUT' }>;

export function terrainRecordPutArgs(op: TerrainRecordPutOp): Array<string | number | null> {
  const p = op.pose;
  return [op.sectorKey, op.rockKey, op.layoutVersion, op.pool, op.consumed ? 1 : 0, op.ts, p ? p.x : null, p ? p.y : null, p ? p.angle : null];
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
}

/** Every saved rock of one sector, any layout version (the cut field drops
 *  the ones cut under another `FIELD_LAYOUT_VERSION`). Read-only: boot only. */
export function loadTerrainRecords(db: Pick<DatabaseSync, 'prepare'>, sectorKey: string): TerrainRecordRow[] {
  const rows = db
    .prepare('SELECT rock_key, layout_version, pool, consumed, pose_x, pose_y, pose_angle FROM terrain_records WHERE sector_key = ?')
    .all(sectorKey) as Array<{ rock_key: number; layout_version: number; pool: number | null; consumed: number; pose_x: number | null; pose_y: number | null; pose_angle: number | null }>;
  return rows.map((r) => ({
    rockKey: r.rock_key, layoutVersion: r.layout_version, pool: r.pool, consumed: r.consumed !== 0,
    pose: r.pose_x !== null && r.pose_y !== null && r.pose_angle !== null ? { x: r.pose_x, y: r.pose_y, angle: r.pose_angle } : null,
  }));
}

/** A cut field's save: what `CutFieldSubsystem` gets in a room that persists
 *  (a galaxy sector key, `persistSector` on). Loads through the main thread's
 *  read-only connection, writes on the CRITICAL lane. */
export interface TerrainRecordStore {
  readonly sectorKey: string;
  load(): readonly TerrainRecordRow[];
  put(op: TerrainRecordPutOp): void;
  warn(fields: object, msg: string): void;
}

export function terrainRecordStore(
  sectorKey: string,
  db: Pick<DatabaseSync, 'prepare'>,
  sink: IPersistenceSink,
  logger: { warn(fields: object, msg: string): void },
): TerrainRecordStore {
  return {
    sectorKey,
    load: () => {
      try { return loadTerrainRecords(db, sectorKey); } catch (err) {
        logger.warn({ err, sectorKey, table: 'terrain_records' }, 'terrain_records SELECT failed (treating as empty)');
        return [];
      }
    },
    put: (op) => { sink.enqueueCritical(op); },
    warn: (fields, msg) => { logger.warn(fields, msg); },
  };
}
