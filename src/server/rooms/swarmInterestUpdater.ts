/**
 * Per-tick swarm spatial-grid update + drone runaway-bounds clamp.
 * Lifted out of `SectorRoom.update()`.
 *
 * `interestGrid.move()` is mostly free — most entities don't cross a
 * 2048-unit cell boundary in a single tick at typical drone/asteroid
 * speeds (~30-100 u/s), so it returns early without touching the
 * bucket map.
 *
 * Phase 1 AI backstop: while we iterate, also catch any drone that
 * has drifted past `DRONE_MAX_BOUNDS` and post a SET_POSITION worker
 * command to teleport it back. Patrol behaviour pulls drones home in
 * normal play; this is a "should never fire" guard against runaway
 * pursuits and the long-session drift bug (real diag: drones at
 * (4 133 782, -1 093 669) on 2026-05-10). Asteroids unaffected.
 */

import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_ANGLE_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { SpatialGrid } from '../interest/SpatialGrid.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import pino from 'pino';

const logger = pino({
  name: 'swarmInterestUpdater',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

export interface SwarmInterestCtx {
  swarmRegistry: SwarmEntityRegistry;
  interestGrid: SpatialGrid;
  sabF32: Float32Array;
  postToWorker: (cmd: WorkerCmd) => void;
  droneMaxBounds: number;
}

export function updateSwarmInterestGrid(ctx: SwarmInterestCtx): void {
  const { swarmRegistry, interestGrid, sabF32, postToWorker, droneMaxBounds } = ctx;
  for (const rec of swarmRegistry.all()) {
    const b = slotBase(rec.slot);
    const sx = sabF32[b + SLOT_X_OFF]!;
    const sy = sabF32[b + SLOT_Y_OFF]!;
    interestGrid.move(rec.entityId, sx, sy);
    if (rec.kind === 1 && (Math.abs(sx) > droneMaxBounds || Math.abs(sy) > droneMaxBounds)) {
      const clampedX = Math.max(-droneMaxBounds, Math.min(droneMaxBounds, sx));
      const clampedY = Math.max(-droneMaxBounds, Math.min(droneMaxBounds, sy));
      postToWorker({
        type: 'SET_POSITION',
        entityId: rec.id,
        x: clampedX, y: clampedY,
        angle: sabF32[b + SLOT_ANGLE_OFF]!,
        vx: 0, vy: 0, angvel: 0,
      });
      logger.warn({ entityId: rec.id, sx, sy }, 'drone position clamped to bounds');
    }
  }
}
