/**
 * Per-tick lag-comp pose recording, lifted out of `SectorRoom.update()`.
 *
 * Streams every dynamic entity — ships AND swarm — into the
 * `SnapshotRing` for the current serverTick. Allocation-free: uses
 * `beginTick` + `recordEntity` instead of materializing an
 * intermediate array. Mass-independent: any moving entity benefits
 * from accurate hit attribution (the polygon-aware hit resolver can
 * rewind any obstacle's pose — position + angle — to the shooter's
 * tick).
 *
 * Asteroids stream pose unchanged from SAB. Ships read from the pose
 * cache (which was just refreshed by `mirrorSabPoses`).
 */

import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import type { SnapshotRing } from '../lagcomp/SnapshotRing.js';
import type { SwarmEntityRegistry } from '../net/SwarmEntityRegistry.js';
import type { PoseRecord } from './SabPoseMirror.js';

export interface LagCompRecordCtx {
  snapshotRing: SnapshotRing;
  serverTick: number;
  playerToSlot: Map<string, number>;
  shipPoseCache: Map<string, PoseRecord>;
  swarmRegistry: SwarmEntityRegistry;
  sabF32: Float32Array;
  /** `(playerId) => ship | undefined` — used to gate dead-ship recording. */
  getActiveShip: (playerId: string) => { alive: boolean } | undefined;
}

export function recordLagCompPoses(ctx: LagCompRecordCtx): void {
  const {
    snapshotRing, serverTick, playerToSlot, shipPoseCache,
    swarmRegistry, sabF32, getActiveShip,
  } = ctx;
  snapshotRing.beginTick(serverTick);
  for (const id of playerToSlot.keys()) {
    const ship = getActiveShip(id);
    if (!ship?.alive) continue;
    const pose = shipPoseCache.get(id);
    if (!pose) continue;
    snapshotRing.recordEntity(id, pose.x, pose.y, pose.vx, pose.vy, pose.angle, pose.angvel ?? 0);
  }
  for (const rec of swarmRegistry.all()) {
    const b = slotBase(rec.slot);
    snapshotRing.recordEntity(
      rec.id,
      sabF32[b + SLOT_X_OFF]!,
      sabF32[b + SLOT_Y_OFF]!,
      sabF32[b + SLOT_VX_OFF]!,
      sabF32[b + SLOT_VY_OFF]!,
      sabF32[b + SLOT_ANGLE_OFF]!,
      sabF32[b + SLOT_ANGVEL_OFF]!,
    );
  }
}
