import type { DatabaseSync } from 'node:sqlite';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';

/**
 * Sub-phase A bridge: implements IPersistenceSink against a synchronous
 * `node:sqlite` connection on the calling thread. No queueing, no batching —
 * each enqueue runs the matching prepared statement immediately.
 *
 * Sub-phase B replaces the production singleton with a worker-backed sink;
 * tests continue to use this adapter against `:memory:` for determinism.
 */
export class SyncSinkAdapter implements IPersistenceSink {
  private readonly stmts: {
    KILL: ReturnType<DatabaseSync['prepare']>;
    GAME_JOIN: ReturnType<DatabaseSync['prepare']>;
    GAME_LEAVE: ReturnType<DatabaseSync['prepare']>;
    LOGIN_EVENT: ReturnType<DatabaseSync['prepare']>;
    SNAPSHOT: ReturnType<DatabaseSync['prepare']>;
    USER_REGISTER: ReturnType<DatabaseSync['prepare']>;
    USER_PROVIDER: ReturnType<DatabaseSync['prepare']>;
    USER_PROVIDER_IGNORE: ReturnType<DatabaseSync['prepare']>;
    USER_UPDATE_DISPLAY_NAME: ReturnType<DatabaseSync['prepare']>;
    LIMBO_PUT: ReturnType<DatabaseSync['prepare']>;
    LIMBO_DELETE: ReturnType<DatabaseSync['prepare']>;
    PLAYER_SHIP_PUT: ReturnType<DatabaseSync['prepare']>;
    PLAYER_SHIP_DELETE: ReturnType<DatabaseSync['prepare']>;
  };

  constructor(private readonly db: DatabaseSync) {
    this.stmts = {
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
      LIMBO_PUT: db.prepare(
        'INSERT INTO limbo (player_id, user_id, sector_key, payload_json, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(player_id) DO UPDATE SET user_id=excluded.user_id, sector_key=excluded.sector_key, payload_json=excluded.payload_json, expires_at=excluded.expires_at, updated_at=excluded.updated_at',
      ),
      LIMBO_DELETE: db.prepare('DELETE FROM limbo WHERE player_id = ?'),
      PLAYER_SHIP_PUT: db.prepare(
        'INSERT INTO player_ships (ship_id, player_id, user_id, kind, kind_version, health, ' +
        'last_sector_key, last_x, last_y, last_vx, last_vy, last_angle, last_angvel, ' +
        'last_fire_client_tick, is_active, active_room_id, expires_at, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(ship_id) DO UPDATE SET ' +
        'player_id=excluded.player_id, user_id=excluded.user_id, kind=excluded.kind, ' +
        'kind_version=excluded.kind_version, health=excluded.health, ' +
        'last_sector_key=excluded.last_sector_key, last_x=excluded.last_x, last_y=excluded.last_y, ' +
        'last_vx=excluded.last_vx, last_vy=excluded.last_vy, last_angle=excluded.last_angle, ' +
        'last_angvel=excluded.last_angvel, last_fire_client_tick=excluded.last_fire_client_tick, ' +
        'is_active=excluded.is_active, active_room_id=excluded.active_room_id, ' +
        'expires_at=excluded.expires_at, updated_at=excluded.updated_at',
      ),
      PLAYER_SHIP_DELETE: db.prepare('DELETE FROM player_ships WHERE ship_id = ?'),
    };
  }

  enqueueCritical(op: PersistOp): void {
    this.applyOp(op);
  }

  enqueueVolatile(op: PersistOp): void {
    // Telemetry ops have no schema yet; swallow them in the sync adapter
    // (sub-phase B's worker will add tables and inserts).
    if (op.type === 'TELEMETRY_SHED' || op.type === 'TELEMETRY_SLEEP') return;
    this.applyOp(op);
  }

  enqueueCriticalAwaitable(op: PersistOp): Promise<{ rowId?: number }> {
    const result = this.applyOp(op);
    return Promise.resolve(result);
  }

  shutdown(_opts: { timeoutMs: number }): Promise<{ drained: number }> {
    return Promise.resolve({ drained: 0 });
  }

  private applyOp(op: PersistOp): { rowId?: number } {
    switch (op.type) {
      case 'KILL': {
        this.stmts.KILL.run(op.killerUserId, op.victimUserId, op.weapon, op.sectorId, op.ts);
        return {};
      }
      case 'GAME_JOIN': {
        const r = this.stmts.GAME_JOIN.run(op.userId, op.playId, op.sectorId, op.ts) as {
          lastInsertRowid: number | bigint;
        };
        return { rowId: Number(r.lastInsertRowid) };
      }
      case 'GAME_LEAVE': {
        this.stmts.GAME_LEAVE.run(op.ts, op.playId);
        return {};
      }
      case 'LOGIN_EVENT': {
        this.stmts.LOGIN_EVENT.run(
          op.email,
          op.userId,
          op.success ? 1 : 0,
          op.provider,
          op.ip,
          op.ts,
        );
        return {};
      }
      case 'SNAPSHOT': {
        this.stmts.SNAPSHOT.run(op.sectorId, op.payloadJson, op.ts);
        return {};
      }
      case 'USER_REGISTER': {
        const r = this.stmts.USER_REGISTER.run(
          op.userId,
          op.email,
          op.passwordHash,
          op.displayName,
          op.ts,
          op.ts,
        ) as { lastInsertRowid: number | bigint };
        return { rowId: Number(r.lastInsertRowid) };
      }
      case 'USER_PROVIDER': {
        const stmt = op.ignoreConflict ? this.stmts.USER_PROVIDER_IGNORE : this.stmts.USER_PROVIDER;
        stmt.run(op.providerRowId, op.userId, op.provider, op.providerId);
        return {};
      }
      case 'USER_UPDATE_DISPLAY_NAME': {
        this.stmts.USER_UPDATE_DISPLAY_NAME.run(op.displayName, op.ts, op.userId);
        return {};
      }
      case 'TELEMETRY_SHED':
      case 'TELEMETRY_SLEEP': {
        return {};
      }
      case 'LIMBO_PUT': {
        this.stmts.LIMBO_PUT.run(
          op.playerId,
          op.userId,
          op.sectorKey,
          op.payloadJson,
          op.expiresAt,
          op.ts,
          op.ts,
        );
        return {};
      }
      case 'LIMBO_DELETE': {
        this.stmts.LIMBO_DELETE.run(op.playerId);
        return {};
      }
      case 'LIMBO_GET': {
        // Boot hydration reads via the read-only main-thread connection.
        return {};
      }
      case 'PLAYER_SHIP_PUT': {
        this.stmts.PLAYER_SHIP_PUT.run(
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
          op.ts,
          op.ts,
        );
        return {};
      }
      case 'PLAYER_SHIP_DELETE': {
        this.stmts.PLAYER_SHIP_DELETE.run(op.shipId);
        return {};
      }
    }
  }
}
