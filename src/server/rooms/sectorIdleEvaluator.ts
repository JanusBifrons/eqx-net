/**
 * Stage 5 sector-idle evaluation + Phase 4 abandon detection — the
 * two per-tick checks that lived inline in SectorRoom.update().
 *
 *   - `evaluateSectorIdle` updates the idle tracker from motion +
 *     projectile-in-flight signals and returns `true` when the sector
 *     should be treated as idle (= 1 s of no activity AND not inside
 *     the post-join broadcast-grace window). The snapshot broadcast
 *     short-circuits when this returns true.
 *
 *   - `findAbandonedPlayers` returns the playerIds whose ship's
 *     roster row has been deleted (via /dev/player-ships/:shipId/
 *     abandon). The room then converts each to an ownerless wreck.
 *     Galaxy-rooms only — engineering rooms have no roster and skip
 *     entirely.
 */

import type { PlayerShipStore } from '../playerShips/PlayerShipStore.js';
import {
  noteSectorEvent,
  isSectorIdle,
  type IdleTracker,
} from '../net/snapshotScheduler.js';
import type { PoseRecord } from './SabPoseMirror.js';
import type { MapSchema } from '@colyseus/schema';
import type { ShipState } from './schema/SectorState.js';

export interface IdleEvalCtx {
  idleTracker: IdleTracker;
  serverTick: number;
  shipPoseCache: Map<string, PoseRecord>;
  liveProjectiles: { size: number };
  /** Drone (swarm-entity) count in the sector. Drones aren't in
   *  `shipPoseCache` and their hitscan beams aren't in
   *  `liveProjectiles`, so without this signal a sector with bots
   *  attacking a momentarily-stationary player can enter idle
   *  suppression — the 2026-06-01 phone-stall repro mechanism (see
   *  `tests/mobile-perf/phone-galaxy-stall-repro.spec.ts`). */
  swarmEntityCount: number;
  forceBroadcastUntilTick: number;
  idleMotionEpsilonSq: number;
  idleThresholdTicks: number;
}

export function evaluateSectorIdle(ctx: IdleEvalCtx): boolean {
  // Stage 5 — sector idle tracking. Updated every tick from motion +
  // projectile-in-flight signals; when no activity in
  // IDLE_THRESHOLD_TICKS (= 1 s at 60 Hz), the snapshot broadcast
  // block short-circuits.
  if (ctx.swarmEntityCount > 0) {
    // Drones present → sector is meaningfully active for any
    // connected client (player sees them in the binary swarm wire and
    // expects snapshot-rate updates of their interactions with the
    // player's hull / shield). Skip motion + projectile checks.
    noteSectorEvent(ctx.idleTracker, ctx.serverTick);
  } else if (ctx.liveProjectiles.size > 0) {
    noteSectorEvent(ctx.idleTracker, ctx.serverTick);
  } else {
    for (const [, pose] of ctx.shipPoseCache) {
      const speedSq = pose.vx * pose.vx + pose.vy * pose.vy;
      if (speedSq > ctx.idleMotionEpsilonSq) {
        noteSectorEvent(ctx.idleTracker, ctx.serverTick);
        break;
      }
      if (Math.abs(pose.angvel ?? 0) > 0.05) {
        noteSectorEvent(ctx.idleTracker, ctx.serverTick);
        break;
      }
    }
  }
  // A freshly-joined client needs a steady snapshot stream to
  // reconcile its prediction before idle-suppression can quiet the
  // sector. `forceBroadcastUntilTick` is set on every join/spawn;
  // while the current tick is inside that window the sector is
  // treated as non-idle regardless of motion. See
  // JOIN_BROADCAST_GRACE_TICKS for the full rationale.
  const inJoinGrace = ctx.serverTick < ctx.forceBroadcastUntilTick;
  return (
    !inJoinGrace &&
    isSectorIdle(ctx.idleTracker, ctx.serverTick, ctx.idleThresholdTicks)
  );
}

/**
 * Phase 4 — abandon detection. Every 30 ticks (~500 ms) we check
 * whether any ship currently in this room has had its roster row
 * deleted (via /dev/player-ships/:shipId/abandon). Returns the
 * playerIds to convert to ownerless wrecks.
 *
 * Phase 6b — schema key is shipInstanceId; convertShipToWreck still
 * takes playerId, so we read `ship.playerId` from the schema field.
 * Inactive (lingering) hulls are skipped: a player can abandon a
 * lingering hull from the roster panel, but that path goes through
 * a different code branch.
 */
export function findAbandonedPlayers(
  ships: MapSchema<ShipState>,
  store: PlayerShipStore,
): string[] {
  const abandoned: string[] = [];
  for (const [, ship] of ships) {
    if (ship.shipInstanceId === '' || !ship.alive || !ship.isActive) continue;
    if (store.get(ship.shipInstanceId) === null) abandoned.push(ship.playerId);
  }
  return abandoned;
}
