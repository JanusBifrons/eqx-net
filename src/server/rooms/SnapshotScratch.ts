/**
 * Snapshot-broadcast scratch & object pools (2026-05-25 GC sweep).
 *
 * Owns ALL persistent reusable structures consumed by `SectorRoom.update()`'s
 * snapshot broadcast block (the per-tick 60 Hz / per-recipient 20 Hz loop
 * over `this.clients`). Constructed once in `SectorRoom.onCreate`; cleaned
 * via per-player hooks (`onLeave`, `evictSwarmEntity`, wreck-conversion).
 *
 * Design rests on the load-bearing assumption locked by
 * `tests/integration/allocations/colyseusSendSyncEncode.test.ts`:
 * `client.send('snapshot', snap)` synchronously encodes `snap` into the
 * WebSocket buffer before returning, so a SINGLE shared `snap` envelope
 * (plus its nested `states` / `projectiles` / `drones` / `wrecks`
 * collections) can be mutated per-recipient within the same tick.
 *
 * If that assumption EVER breaks, fall back to a per-recipient scratch
 * `Map<sessionId, SnapshotScratch>` — 10× memory cost at typical room
 * size, still bounded, and the SectorRoom code path is otherwise identical.
 *
 * See [docs/architecture/gc-discipline.md] for the paradigm.
 */
import { ObjectPool, clearArray } from '../../core/util/ObjectPool.js';
import type { SnapshotMessage } from '../../shared-types/messages.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';

// ── Wire-type slices the pools produce ────────────────────────────────────

/** Last-input bits nested inside `AllShipEntry`. Wire shape from
 *  `SnapshotMessage.states[id].lastInput`. */
export interface PooledLastInput {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost: boolean;
  reverse: boolean;
}

/** Shared per-tick ship digest — built once, consumed by every recipient. */
export interface AllShipEntry {
  playerId: string;
  shipInstanceId: string;
  isActive: boolean;
  pose: ShipPhysicsState;
  lastInput: PooledLastInput;
}

/** Per-recipient `states[shipInstanceId]` entry. */
export interface PooledStateEntry {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
  playerId: string;
  isActive: boolean;
  lastInput?: PooledLastInput;
  mountAngles?: number[];
}

/** Per-recipient `projectiles[]` entry. */
export interface PooledProjectileEntry {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  ownerId: string;
  weaponId?: string;
}

/** Per-recipient `drones[]` entry (slim turret/shield slice). */
export interface PooledDroneEntry {
  id: number;
  shieldDown?: boolean;
  mountAngles?: number[];
}

/** Per-recipient `wrecks[]` entry. */
export interface PooledWreckEntry {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel: number;
}

// ── Factories + resets ────────────────────────────────────────────────────

const makeLastInput = (): PooledLastInput => ({
  thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false,
});

const makeAllShip = (): AllShipEntry => ({
  playerId: '',
  shipInstanceId: '',
  isActive: false,
  // Reused pose ref from upstream; we just keep a slot. Will be reassigned.
  pose: { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 } as ShipPhysicsState,
  lastInput: makeLastInput(),
});

// Reset for AllShipEntry: clear string fields so dead entries don't leak
// identifiers into stale pools. The `lastInput` sub-object is recycled along
// with its parent; bits get rewritten next acquire.
const resetAllShip = (e: AllShipEntry): void => {
  e.playerId = '';
  e.shipInstanceId = '';
  e.isActive = false;
};

const makeStateEntry = (): PooledStateEntry => ({
  x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
  playerId: '',
  isActive: false,
  // lastInput/mountAngles intentionally undefined; set only when emitted
});

const resetStateEntry = (e: PooledStateEntry): void => {
  e.playerId = '';
  e.isActive = false;
  e.lastInput = undefined;
  e.mountAngles = undefined;
};

const makeProjectileEntry = (): PooledProjectileEntry => ({
  id: '', x: 0, y: 0, vx: 0, vy: 0, ownerId: '',
});

const resetProjectileEntry = (e: PooledProjectileEntry): void => {
  e.id = '';
  e.ownerId = '';
  e.weaponId = undefined;
};

const makeDroneEntry = (): PooledDroneEntry => ({ id: 0 });

const resetDroneEntry = (e: PooledDroneEntry): void => {
  e.shieldDown = undefined;
  e.mountAngles = undefined;
};

const makeWreckEntry = (): PooledWreckEntry => ({
  id: '', x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0,
});

const resetWreckEntry = (e: PooledWreckEntry): void => {
  e.id = '';
};

// ── The scratch object ────────────────────────────────────────────────────

/** Snapshot wire envelope reused across recipients. `client.send` encodes
 *  synchronously (proof gate), so we mutate this in place per-recipient. */
export interface SnapshotEnvelope extends SnapshotMessage {
  /** Override the optional/nested fields with the concrete reused
   *  collections so we can mutate them without re-narrowing. */
  states: Record<string, PooledStateEntry>;
  projectiles?: PooledProjectileEntry[];
  drones?: PooledDroneEntry[];
  wrecks?: PooledWreckEntry[];
  boostingIds?: string[];
  thrustingIds?: string[];
}

export class SnapshotScratch {
  // Shared per-tick collections (used by every recipient).
  readonly allShips: AllShipEntry[] = [];
  readonly allShipsPool = new ObjectPool<AllShipEntry>(makeAllShip, resetAllShip);

  readonly boostingIds: string[] = [];
  readonly thrustingIds: string[] = [];

  // Per-recipient collections (reused across recipients within a tick).
  // The states map is `Record<shipInstanceId, PooledStateEntry>` — cleared
  // and re-populated each recipient via for…in + delete + pool.release.
  readonly statesScratch: Record<string, PooledStateEntry> = {};
  readonly stateEntryPool = new ObjectPool<PooledStateEntry>(makeStateEntry, resetStateEntry);

  readonly projectilesScratch: PooledProjectileEntry[] = [];
  readonly projectileEntryPool = new ObjectPool<PooledProjectileEntry>(makeProjectileEntry, resetProjectileEntry);

  readonly dronesScratch: PooledDroneEntry[] = [];
  readonly droneEntryPool = new ObjectPool<PooledDroneEntry>(makeDroneEntry, resetDroneEntry);

  readonly wrecksScratch: PooledWreckEntry[] = [];
  readonly wreckEntryPool = new ObjectPool<PooledWreckEntry>(makeWreckEntry, resetWreckEntry);

  /** Reused snapshot envelope. Field references are stable across calls;
   *  optional fields are set/deleted per recipient (msgpack drops missing
   *  keys, matching the pre-pool wire shape byte-for-byte). */
  readonly snapEnvelope: SnapshotEnvelope = {
    type: 'snapshot',
    serverTick: 0,
    // `states` reference is stable; entries are reset each tick.
    states: this.statesScratch,
    ackedTick: 0,
  };

  /** Per-ship mount-angle scratch arrays. Lazy-alloc on first non-zero
   *  rotation, reused thereafter. Keyed by shipId (player or drone). MUST
   *  be cleared via `releaseShipMountAngles(id)` on `onLeave` /
   *  `evictSwarmEntity` / wreck-conversion to avoid reconnect leaks.
   *  See `src/server/CLAUDE.md` "Cleanup paths". */
  readonly mountAngleArrays = new Map<string, number[]>();

  /** Get-or-create per-ship mount-angle scratch. Caller fills the entries. */
  ensureMountAngleArray(shipId: string, len: number): number[] {
    let arr = this.mountAngleArrays.get(shipId);
    if (!arr || arr.length !== len) {
      arr = new Array<number>(len);
      this.mountAngleArrays.set(shipId, arr);
    }
    return arr;
  }

  /** Drop the per-ship mount-angle scratch for a despawned ship. */
  releaseShipMountAngles(shipId: string): void {
    this.mountAngleArrays.delete(shipId);
  }

  /** Reset shared per-tick collections. Called at the START of the snapshot
   *  broadcast block. */
  beginTick(): void {
    this.allShipsPool.releaseAll(this.allShips);
    clearArray(this.boostingIds);
    clearArray(this.thrustingIds);
  }

  /** Reset per-recipient collections. Called BEFORE populating each
   *  recipient's snapshot. */
  beginRecipient(): void {
    // Clear states map: for…in + pool.release + delete. O(N) per recipient.
    for (const key in this.statesScratch) {
      const e = this.statesScratch[key];
      if (e) this.stateEntryPool.release(e);
      delete this.statesScratch[key];
    }
    this.projectileEntryPool.releaseAll(this.projectilesScratch);
    this.droneEntryPool.releaseAll(this.dronesScratch);
    this.wreckEntryPool.releaseAll(this.wrecksScratch);
    // Clear optional envelope fields. msgpack drops missing keys, matching
    // the legacy `...(projectiles ? { projectiles } : {})` shape.
    delete this.snapEnvelope.projectiles;
    delete this.snapEnvelope.drones;
    delete this.snapEnvelope.wrecks;
    delete this.snapEnvelope.boostingIds;
    delete this.snapEnvelope.thrustingIds;
  }
}
