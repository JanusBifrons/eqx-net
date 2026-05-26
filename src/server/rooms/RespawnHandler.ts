/**
 * Handles a player's `respawn` message — reset SAB pose to the
 * spawn anchor, despawn + respawn the worker body, reset shield/hull,
 * clear cooldowns + mount angles, send `respawn_ack`.
 *
 * Composes the room's worker proxy + the SAB writer (`shipPoseCache`
 * seeded so consumers running on the same client.send turn don't see
 * the corpse pose) + the room's spawn-position policy (testMode
 * preserves the original join position; engineering rooms have a
 * defaultSpawn anchor; otherwise random scatter).
 *
 * Extracted from SectorRoom (commit 21 partial).
 */

import type { Client } from 'colyseus';
import type { Logger } from 'pino';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  TICK_IDX,
  slotBase,
} from '../../shared-types/sabLayout.js';
import {
  SHIP_MAX_HEALTH,
} from '../../core/combat/Weapons.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { RespawnAckMessage } from '../../shared-types/messages.js';
import type { ShipState } from './schema/SectorState.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { WeaponMountTicker } from './WeaponMountTicker.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';

export interface RespawnHandlerDeps {
  sabF32: Float32Array;
  sabU32: Uint32Array;
  serverTick: () => number;
  testMode: boolean;
  defaultSpawnX: number | null;
  defaultSpawnY: number | null;
  sessionToPlayer: Map<string, string>;
  playerToSlot: Map<string, number>;
  getActiveShip: (pid: string) => ShipState | undefined;
  initialSpawnPositions: Map<string, { x: number; y: number }>;
  shipPoseCache: Map<string, ShipPhysicsState>;
  lastFireClientTick: Map<string, number>;
  mountTicker: WeaponMountTicker;
  postToWorker: (cmd: WorkerCmd) => void;
  logger: Logger;
}

export class RespawnHandler {
  constructor(private readonly deps: RespawnHandlerDeps) {}

  handle(client: Client): void {
    const d = this.deps;
    const playerId = d.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    const ship = d.getActiveShip(playerId);
    if (!ship || ship.alive) return; // only dead ships may respawn

    const slot = d.playerToSlot.get(playerId);
    if (slot === undefined) return;

    const storedPos = d.initialSpawnPositions.get(playerId);
    const spawnX = (d.testMode && storedPos)
      ? storedPos.x
      : (d.defaultSpawnX ?? (Math.random() - 0.5) * 400);
    const spawnY = (d.testMode && storedPos)
      ? storedPos.y
      : (d.defaultSpawnY ?? (Math.random() - 0.5) * 400);

    // Reset physics body in worker to new spawn position. Preserve
    // the ship's existing `kind` — respawn keeps the same vehicle.
    d.postToWorker({ type: 'DESPAWN', slot, playerId });
    d.postToWorker({ type: 'SPAWN', slot, playerId, x: spawnX, y: spawnY, kindId: ship.kind });

    // Pre-populate SAB so update() reads a sane position before the
    // worker responds.
    const base = slotBase(slot);
    d.sabF32[base + SLOT_X_OFF]  = spawnX;
    d.sabF32[base + SLOT_Y_OFF]  = spawnY;
    d.sabF32[base + SLOT_VX_OFF] = 0;
    d.sabF32[base + SLOT_VY_OFF] = 0;

    // Reset authoritative ship state.
    ship.health = SHIP_MAX_HEALTH;
    ship.alive  = true;
    // Shield refills on respawn; force the body back to its cheap circle
    // collider (SET_HULL_EXPOSED is idempotent — no-op if already circle).
    ship.shield = getShipKind(ship.kind).shieldMax;
    ship.shieldLastDamageTick = d.serverTick();
    d.postToWorker({ type: 'SET_HULL_EXPOSED', id: playerId, exposed: false, kindId: ship.kind, tick: d.serverTick() });

    // Seed the pose cache so any consumer that runs before the next
    // update() tick (e.g. an in-flight fire request resolved on this
    // same client.send turn) sees the respawn position rather than
    // the corpse pose.
    const pose = d.shipPoseCache.get(playerId);
    if (pose) {
      pose.x = spawnX; pose.y = spawnY;
      pose.vx = 0; pose.vy = 0;
      // angle/angvel left as-is — the worker will overwrite both
      // before the next SAB→cache mirror.
    } else {
      d.shipPoseCache.set(playerId, { x: spawnX, y: spawnY, vx: 0, vy: 0, angle: 0, angvel: 0 });
    }

    // Clear fire cooldown so first shot after respawn isn't rejected.
    d.lastFireClientTick.delete(playerId);
    d.mountTicker.clearPlayer(playerId);

    const currentServerTick = Atomics.load(d.sabU32, TICK_IDX);
    const ack: RespawnAckMessage = { type: 'respawn_ack', x: spawnX, y: spawnY, serverTick: currentServerTick };
    client.send('respawn_ack', ack);

    d.logger.info({ playerId, spawnX, spawnY }, 'player respawned');
  }
}
