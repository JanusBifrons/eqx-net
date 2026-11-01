/**
 * HoldStore — the in-memory authority for every hold in the process (plan
 * peppy-jumping-pinwheel P1a-1). Mirrors `PlayerShipStore`: memory is primary,
 * every mutation is shadowed to the CRITICAL persistence lane.
 *
 * Anti-duplication contract (hostile-review A5): a VALUE TRANSFER touches two
 * holders (e.g. pod → ship on pickup) and is committed as ONE atomic `GROUP`
 * op of ABSOLUTE upserts/deletes. Memory changes first (it is the authority);
 * the group either lands whole or not at all, so a crash can never leave the
 * value in both holders.
 */
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import type { Hold } from '../../shared-types/goods.js';

export type HolderType = 'ship' | 'pod' | 'derelict' | 'structure' | 'hauler';

export interface HoldRecord {
  readonly holderUid: string;
  readonly holderType: HolderType;
  ownerId: string | null;
  sectorKey: string | null;
  /** Pose for pods / derelicts (null for ships + structures, which own a pose). */
  x: number | null;
  y: number | null;
  hold: Hold;
  /** Absolute ms expiry (pods), else null. */
  expiresAt: number | null;
}

export interface HoldStoreDeps {
  /** Resolved per call so a test `setPersistence` swap is honoured. */
  persistence: () => IPersistenceSink;
  now?: () => number;
}

export class HoldStore {
  private readonly byUid = new Map<string, HoldRecord>();
  private readonly now: () => number;

  constructor(private readonly deps: HoldStoreDeps) {
    this.now = deps.now ?? Date.now;
  }

  get(uid: string): HoldRecord | undefined {
    return this.byUid.get(uid);
  }

  /** Boot hydrate — memory only, never re-persisted. */
  hydrate(records: readonly HoldRecord[]): void {
    for (const r of records) this.byUid.set(r.holderUid, r);
  }

  /** Every record of `type` in `sectorKey` (pods to restore on room hydrate). */
  inSector(sectorKey: string, type: HolderType): HoldRecord[] {
    const out: HoldRecord[] = [];
    for (const r of this.byUid.values()) {
      if (r.holderType === type && r.sectorKey === sectorKey) out.push(r);
    }
    return out;
  }

  /**
   * Atomically commit upserts + deletes. Memory first (authority), then ONE
   * `GROUP` op. `persist: false` keeps it memory-only (engineering rooms with no
   * persistent identity).
   */
  commit(
    puts: readonly HoldRecord[],
    deletes: readonly string[],
    persist = true,
    /** P2 — non-hold ops that must land in the SAME atomic group (e.g. the
     *  trade-deal state that records an escrow move). */
    extraOps: readonly PersistOp[] = [],
  ): void {
    for (const r of puts) this.byUid.set(r.holderUid, r);
    for (const uid of deletes) this.byUid.delete(uid);
    if (!persist) return;
    const ts = this.now();
    const ops: PersistOp[] = [];
    for (const r of puts) ops.push(toPutOp(r, ts));
    for (const uid of deletes) ops.push({ type: 'HOLD_DELETE', holderUid: uid, ts });
    for (const op of extraOps) ops.push(op);
    if (ops.length === 0) return;
    this.deps.persistence().enqueueCritical(ops.length === 1 ? ops[0]! : { type: 'GROUP', ops });
  }

  put(rec: HoldRecord, persist = true): void {
    this.commit([rec], [], persist);
  }

  delete(uid: string, persist = true): void {
    if (!this.byUid.has(uid)) return;
    this.commit([], [uid], persist);
  }

  size(): number {
    return this.byUid.size;
  }
}

function toPutOp(r: HoldRecord, ts: number): PersistOp {
  return {
    type: 'HOLD_PUT',
    holderUid: r.holderUid,
    holderType: r.holderType,
    ownerId: r.ownerId,
    sectorKey: r.sectorKey,
    x: r.x,
    y: r.y,
    payloadJson: JSON.stringify(r.hold),
    expiresAt: r.expiresAt,
    ts,
  };
}
