/**
 * Living World P1a (plan peppy-jumping-pinwheel) — SQL + atomic-group logic for
 * the unified `holds` table, shared by BOTH writers (the production `dbWorker`
 * and the test `SyncSinkAdapter`) so the two can never drift (invariant #15).
 */
import type { DatabaseSync } from 'node:sqlite';
import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';

export const HOLD_PUT_SQL =
  'INSERT INTO holds (holder_uid, holder_type, owner_id, sector_key, x, y, payload_json, expires_at, updated_at) ' +
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
  'ON CONFLICT(holder_uid) DO UPDATE SET holder_type=excluded.holder_type, owner_id=excluded.owner_id, ' +
  'sector_key=excluded.sector_key, x=excluded.x, y=excluded.y, payload_json=excluded.payload_json, ' +
  'expires_at=excluded.expires_at, updated_at=excluded.updated_at';

export const HOLD_DELETE_SQL = 'DELETE FROM holds WHERE holder_uid = ?';

type HoldPutOp = Extract<PersistOp, { type: 'HOLD_PUT' }>;

export function holdPutArgs(op: HoldPutOp): Array<string | number | null> {
  return [op.holderUid, op.holderType, op.ownerId, op.sectorKey, op.x, op.y, op.payloadJson, op.expiresAt, op.ts];
}

let savepointSeq = 0;

/**
 * Apply a GROUP atomically inside a SAVEPOINT (valid both inside an outer
 * BEGIN…COMMIT batch and standalone). On any sub-op failure the group rolls
 * back ALONE and `onError` is told — the surrounding batch still commits, so
 * one bad transfer never discards unrelated players' writes (hostile-review A5).
 * Returns true when the group committed.
 */
export function applyGroupAtomically(
  db: DatabaseSync,
  ops: readonly PersistOp[],
  applyOne: (op: PersistOp) => void,
  onError: (message: string) => void,
): boolean {
  const sp = `grp_${++savepointSeq}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    for (const op of ops) applyOne(op);
    db.exec(`RELEASE ${sp}`);
    return true;
  } catch (err) {
    db.exec(`ROLLBACK TO ${sp}`);
    db.exec(`RELEASE ${sp}`);
    onError(err instanceof Error ? err.message : String(err));
    return false;
  }
}
