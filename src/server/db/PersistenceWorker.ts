import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { WorkerBackedSink, type WorkerHandle } from './WorkerBackedSink.js';
import { bundleWorker } from '../workers/bundleWorker.js';
import { LimboStore, type LimboEntry, type LimboPayload } from '../limbo/LimboStore.js';
import { PlayerShipStore, type PlayerShipRecord } from '../playerShips/PlayerShipStore.js';
import { db } from './Database.js';

/**
 * Process-global persistence singleton. `initWorker()` constructs a
 * `WorkerBackedSink`, awaits the DB worker's READY handshake, and swaps it
 * in via `setPersistence`. Until then, any write attempt throws — production
 * boot must call `initWorker()` before serving traffic, and tests must call
 * `setPersistence()` with their own adapter.
 *
 * Auth's read-only main-thread connection lives in `Database.ts`; this
 * module never imports it (so unit tests that mock `setPersistence` don't
 * pull `node:sqlite` transitively).
 */
class UninitializedSink implements IPersistenceSink {
  private fail(): never {
    throw new Error('persistence sink not initialised — call initWorker() or setPersistence()');
  }
  enqueueCritical(): void { this.fail(); }
  enqueueVolatile(): void { this.fail(); }
  enqueueCriticalAwaitable(): Promise<{ rowId?: number }> {
    return Promise.reject(new Error('persistence sink not initialised'));
  }
  shutdown(): Promise<{ drained: number }> {
    return Promise.resolve({ drained: 0 });
  }
}

let _sink: IPersistenceSink = new UninitializedSink();

export function getPersistence(): IPersistenceSink {
  return _sink;
}

export function setPersistence(s: IPersistenceSink): void {
  _sink = s;
}

/**
 * Convenience proxy: callers can `import { persistence }` and call methods
 * directly without ever holding a stale reference if `setPersistence` is
 * later used to swap in a worker-backed sink.
 */
export const persistence: IPersistenceSink = {
  enqueueCritical(op: PersistOp): void {
    _sink.enqueueCritical(op);
  },
  enqueueVolatile(op: PersistOp): void {
    _sink.enqueueVolatile(op);
  },
  enqueueCriticalAwaitable(op: PersistOp): Promise<{ rowId?: number }> {
    return _sink.enqueueCriticalAwaitable(op);
  },
  shutdown(opts: { timeoutMs: number }): Promise<{ drained: number }> {
    return _sink.shutdown(opts);
  },
};

const DB_WORKER_TS_PATH = fileURLToPath(new URL('./dbWorker.ts', import.meta.url));

/**
 * Bundle the DB worker, spawn it, await READY, and swap in the
 * WorkerBackedSink. Called once from `src/server/index.ts` at boot.
 */
export async function initWorker(opts: { dbPath: string }): Promise<void> {
  const code = await bundleWorker({ entryPoint: DB_WORKER_TS_PATH });
  const worker = new Worker(code, {
    eval: true,
    workerData: { dbPath: opts.dbPath },
  });
  const sink = new WorkerBackedSink();
  await sink.attach(worker as unknown as WorkerHandle);
  setPersistence(sink);
}

// ── Phase 8 sub-phase B — Limbo store singleton ────────────────────────

/**
 * Process-global LimboStore. Hot path is in-memory; every put/delete
 * shadows through `persistence.enqueueCritical`. Created lazily on first
 * `getLimboStore()` so unit tests that don't `initLimboStore()` still
 * compile / typecheck.
 *
 * Production boot (`src/server/index.ts`): after `initWorker()` resolves,
 * call `initLimboStore()` to hydrate from `SELECT ... WHERE expires_at > now`
 * and start the prune timer.
 */
let _limboStore: LimboStore | null = null;

export function getLimboStore(): LimboStore {
  if (_limboStore === null) {
    _limboStore = new LimboStore({ persistence });
  }
  return _limboStore;
}

/** Test seam — replace the store with an injected one. */
export function setLimboStore(store: LimboStore): void {
  _limboStore = store;
}

/**
 * Boot hydrate. Reads the surviving rows from the read-only main-thread
 * connection and starts the prune timer.
 */
export function initLimboStore(now: number = Date.now()): { hydrated: number } {
  const store = getLimboStore();
  let rows: Array<{
    player_id: string;
    user_id: string | null;
    sector_key: string;
    payload_json: string;
    expires_at: number;
    created_at: number;
  }> = [];
  try {
    rows = db.prepare(
      'SELECT player_id, user_id, sector_key, payload_json, expires_at, created_at ' +
      'FROM limbo WHERE expires_at > ?',
    ).all(now) as typeof rows;
  } catch {
    // First-ever boot may race the worker's schema creation; treat as zero.
    rows = [];
  }
  const entries: LimboEntry[] = [];
  for (const row of rows) {
    let payload: LimboPayload;
    try {
      payload = JSON.parse(row.payload_json) as LimboPayload;
    } catch {
      continue;
    }
    entries.push({
      playerId: row.player_id,
      payload,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
    });
  }
  store.hydrate(entries);
  store.startPruneTimer();
  return { hydrated: entries.length };
}

// ── Phase 2 — PlayerShipStore singleton ────────────────────────────────

let _playerShipStore: PlayerShipStore | null = null;

export function getPlayerShipStore(): PlayerShipStore {
  if (_playerShipStore === null) {
    _playerShipStore = new PlayerShipStore({ persistence });
  }
  return _playerShipStore;
}

/** Test seam — replace the store with an injected one. */
export function setPlayerShipStore(store: PlayerShipStore): void {
  _playerShipStore = store;
}

/**
 * Boot hydrate. Reads `player_ships` rows from the read-only main-thread
 * connection. Unlike Limbo, this table is NOT pruned by TTL — entries
 * live indefinitely until the 10-cap evicts or the player abandons.
 */
export function initPlayerShipStore(): { hydrated: number } {
  const store = getPlayerShipStore();
  let rows: Array<{
    ship_id: string;
    player_id: string;
    user_id: string | null;
    kind: string;
    kind_version: number;
    health: number;
    last_sector_key: string;
    last_x: number;
    last_y: number;
    last_vx: number;
    last_vy: number;
    last_angle: number;
    last_angvel: number;
    last_fire_client_tick: number;
    is_active: number;
    active_room_id: string | null;
    expires_at: number;
    created_at: number;
    updated_at: number;
  }> = [];
  try {
    rows = db.prepare(
      'SELECT ship_id, player_id, user_id, kind, kind_version, health, ' +
      'last_sector_key, last_x, last_y, last_vx, last_vy, last_angle, last_angvel, ' +
      'last_fire_client_tick, is_active, active_room_id, expires_at, created_at, updated_at ' +
      'FROM player_ships',
    ).all() as typeof rows;
  } catch {
    // First-ever boot may race the worker's schema creation; treat as zero.
    rows = [];
  }
  const records: PlayerShipRecord[] = rows.map((row) => ({
    shipId: row.ship_id,
    playerId: row.player_id,
    userId: row.user_id,
    kind: row.kind,
    kindVersion: row.kind_version,
    health: row.health,
    lastSectorKey: row.last_sector_key,
    lastX: row.last_x,
    lastY: row.last_y,
    lastVx: row.last_vx,
    lastVy: row.last_vy,
    lastAngle: row.last_angle,
    lastAngvel: row.last_angvel,
    lastFireClientTick: row.last_fire_client_tick,
    isActive: row.is_active === 1,
    activeRoomId: row.active_room_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
  store.hydrate(records);
  return { hydrated: records.length };
}
