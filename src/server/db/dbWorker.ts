/**
 * DB worker — sole writer to the eqx.db SQLite file.
 *
 * Bundled at server startup via esbuild (`bundleWorker`) and spawned via
 * `new Worker(code, { eval: true, workerData: { dbPath } })`. The main
 * thread sends:
 *   - BATCH      — coalesced CRITICAL ops, applied inside one transaction
 *   - AWAITABLE  — single CRITICAL op whose caller awaits the rowId
 *   - VOLATILE   — telemetry, fire-and-forget
 *   - SHUTDOWN   — flush in-flight + reply SHUTDOWN_ACK + exit(0)
 *
 * Replies on `parentPort.postMessage` with a discriminated `WorkerOutbound`.
 *
 * Schema is created via `IF NOT EXISTS` against `SCHEMA_SQL`, so first-ever
 * boot bootstraps the file. Subsequent boots are no-op.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, PLAYER_SHIPS_MIGRATIONS } from './schema.js';
import type { PersistOp } from '../../core/contracts/IPersistenceSink.js';
import type { WorkerInbound, WorkerOutbound } from './workerProtocol.js';

interface WorkerData {
  dbPath: string;
}

function post(msg: WorkerOutbound): void {
  parentPort!.postMessage(msg);
}

const { dbPath } = workerData as WorkerData;
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA synchronous=NORMAL');
db.exec('PRAGMA foreign_keys=ON');
db.exec(SCHEMA_SQL);

// Idempotent in-place column migrations. SCHEMA_SQL only creates a table when
// it doesn't exist, so a table from an older deploy is missing the new Phase 4
// roster columns. SQLite has no ADD COLUMN IF NOT EXISTS — run each ALTER and
// swallow the "duplicate column name" error so the list is idempotent (a fresh
// DB already has the columns and skips them).
for (const sql of PLAYER_SHIPS_MIGRATIONS) {
  try {
    db.exec(sql);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column name/i.test(message)) throw err;
  }
}

const stmts = {
  KILL: db.prepare(
    'INSERT INTO player_kills (killer_user_id, victim_user_id, weapon, sector_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ),
  GAME_JOIN: db.prepare(
    'INSERT INTO game_sessions (user_id, play_id, sector_id, joined_at) VALUES (?, ?, ?, ?)',
  ),
  GAME_LEAVE: db.prepare('UPDATE game_sessions SET left_at = ? WHERE play_id = ?'),
  LOGIN_EVENT: db.prepare(
    'INSERT INTO login_events (email, user_id, success, provider, ip, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  SNAPSHOT: db.prepare(
    'INSERT INTO game_snapshots (sector_id, snapshot, created_at) VALUES (?, ?, ?)',
  ),
  USER_REGISTER: db.prepare(
    'INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  USER_PROVIDER: db.prepare(
    'INSERT INTO auth_providers (id, user_id, provider, provider_id) VALUES (?, ?, ?, ?)',
  ),
  USER_PROVIDER_IGNORE: db.prepare(
    'INSERT OR IGNORE INTO auth_providers (id, user_id, provider, provider_id) VALUES (?, ?, ?, ?)',
  ),
  USER_UPDATE_DISPLAY_NAME: db.prepare(
    'UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?',
  ),
  // Phase 2 multi-ship roster persistence shadow.
  PLAYER_SHIP_PUT: db.prepare(
    'INSERT INTO player_ships (ship_id, player_id, user_id, kind, kind_version, health, ' +
    'last_sector_key, last_x, last_y, last_vx, last_vy, last_angle, last_angvel, ' +
    'last_fire_client_tick, is_active, active_room_id, expires_at, ' +
    'level, xp, stat_alloc, mounts, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(ship_id) DO UPDATE SET ' +
    'player_id=excluded.player_id, user_id=excluded.user_id, kind=excluded.kind, ' +
    'kind_version=excluded.kind_version, health=excluded.health, ' +
    'last_sector_key=excluded.last_sector_key, last_x=excluded.last_x, last_y=excluded.last_y, ' +
    'last_vx=excluded.last_vx, last_vy=excluded.last_vy, last_angle=excluded.last_angle, ' +
    'last_angvel=excluded.last_angvel, last_fire_client_tick=excluded.last_fire_client_tick, ' +
    'is_active=excluded.is_active, active_room_id=excluded.active_room_id, ' +
    'expires_at=excluded.expires_at, level=excluded.level, xp=excluded.xp, ' +
    'stat_alloc=excluded.stat_alloc, mounts=excluded.mounts, updated_at=excluded.updated_at',
  ),
  PLAYER_SHIP_DELETE: db.prepare('DELETE FROM player_ships WHERE ship_id = ?'),
  // Phase 5 director-state persistence shadow. Singleton row (id = 1).
  DIRECTOR_STATE_PUT: db.prepare(
    'INSERT INTO director_state (id, payload_json, created_at, updated_at) VALUES (1, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at',
  ),
  // Web Push subscriptions. UPSERT keyed on the unique endpoint so a device
  // re-subscribing (re-granted permission, rotated keys) updates in place.
  PUSH_SUBSCRIPTION_PUT: db.prepare(
    'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(endpoint) DO UPDATE SET ' +
    'user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, updated_at=excluded.updated_at',
  ),
  PUSH_SUBSCRIPTION_DELETE: db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?'),
};

let drainedCount = 0;

function applyOp(op: PersistOp): { rowId?: number } {
  switch (op.type) {
    case 'KILL': {
      stmts.KILL.run(op.killerUserId, op.victimUserId, op.weapon, op.sectorId, op.ts);
      return {};
    }
    case 'GAME_JOIN': {
      const r = stmts.GAME_JOIN.run(op.userId, op.playId, op.sectorId, op.ts);
      return { rowId: Number(r.lastInsertRowid) };
    }
    case 'GAME_LEAVE': {
      stmts.GAME_LEAVE.run(op.ts, op.playId);
      return {};
    }
    case 'LOGIN_EVENT': {
      stmts.LOGIN_EVENT.run(op.email, op.userId, op.success ? 1 : 0, op.provider, op.ip, op.ts);
      return {};
    }
    case 'SNAPSHOT': {
      stmts.SNAPSHOT.run(op.sectorId, op.payloadJson, op.ts);
      return {};
    }
    case 'USER_REGISTER': {
      const r = stmts.USER_REGISTER.run(
        op.userId,
        op.email,
        op.passwordHash,
        op.displayName,
        op.ts,
        op.ts,
      );
      return { rowId: Number(r.lastInsertRowid) };
    }
    case 'USER_PROVIDER': {
      const stmt = op.ignoreConflict ? stmts.USER_PROVIDER_IGNORE : stmts.USER_PROVIDER;
      stmt.run(op.providerRowId, op.userId, op.provider, op.providerId);
      return {};
    }
    case 'USER_UPDATE_DISPLAY_NAME': {
      stmts.USER_UPDATE_DISPLAY_NAME.run(op.displayName, op.ts, op.userId);
      return {};
    }
    case 'TELEMETRY_SHED':
    case 'TELEMETRY_SLEEP': {
      // No telemetry tables yet. Phase 7+ work will introduce them; for now
      // these are silent no-ops so VOLATILE flow is exercised end-to-end.
      return {};
    }
    case 'PLAYER_SHIP_PUT': {
      stmts.PLAYER_SHIP_PUT.run(
        op.shipId,
        op.playerId,
        op.userId,
        op.kind,
        op.kindVersion,
        op.health,
        op.lastSectorKey,
        op.lastX,
        op.lastY,
        op.lastVx,
        op.lastVy,
        op.lastAngle,
        op.lastAngvel,
        op.lastFireClientTick,
        op.isActive ? 1 : 0,
        op.activeRoomId,
        op.expiresAt,
        op.level,
        op.xp,
        op.statAllocJson,
        op.mountsJson,
        op.ts,
        op.ts,
      );
      return {};
    }
    case 'PLAYER_SHIP_DELETE': {
      stmts.PLAYER_SHIP_DELETE.run(op.shipId);
      return {};
    }
    case 'DIRECTOR_STATE_PUT': {
      stmts.DIRECTOR_STATE_PUT.run(op.payloadJson, op.ts, op.ts);
      return {};
    }
    case 'PUSH_SUBSCRIPTION_PUT': {
      stmts.PUSH_SUBSCRIPTION_PUT.run(
        op.subscriptionId,
        op.userId,
        op.endpoint,
        op.p256dh,
        op.auth,
        op.ts,
        op.ts,
      );
      return {};
    }
    case 'PUSH_SUBSCRIPTION_DELETE': {
      stmts.PUSH_SUBSCRIPTION_DELETE.run(op.endpoint);
      return {};
    }
  }
}

parentPort!.on('message', (msg: WorkerInbound) => {
  if (msg.type === 'BATCH') {
    db.exec('BEGIN');
    try {
      for (const op of msg.ops) applyOp(op);
      db.exec('COMMIT');
      drainedCount += msg.ops.length;
      post({ type: 'BATCH_ACK', batchId: msg.batchId });
    } catch (err) {
      db.exec('ROLLBACK');
      const message = err instanceof Error ? err.message : String(err);
      post({ type: 'BATCH_ERROR', batchId: msg.batchId, message });
    }
    return;
  }
  if (msg.type === 'AWAITABLE') {
    try {
      const { rowId } = applyOp(msg.op);
      drainedCount += 1;
      post({ type: 'AWAITABLE_ACK', opId: msg.opId, rowId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      post({ type: 'AWAITABLE_ERROR', opId: msg.opId, message });
    }
    return;
  }
  if (msg.type === 'VOLATILE') {
    try {
      applyOp(msg.op);
    } catch {
      // Volatile ops are fire-and-forget; swallow errors so a malformed
      // telemetry event can't take the worker down.
    }
    return;
  }
  if (msg.type === 'SHUTDOWN') {
    post({ type: 'SHUTDOWN_ACK', drained: drainedCount });
    // Defer the exit so the postMessage above flushes through the worker
    // IPC channel before the thread tears down. process.exit(0) inline
    // would race the message and the main thread would hang awaiting ACK.
    setImmediate(() => process.exit(0));
  }
});

post({ type: 'READY' });
