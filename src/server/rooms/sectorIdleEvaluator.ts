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
 *   - `findAbandonedShips` returns the ships (active OR lingering) whose
 *     roster row has been deleted (via /dev/player-ships/:shipId/
 *     abandon). The room then shatters each into SCRAP and removes it —
 *     active hulls via `abandonShipToScrap`, lingering hulls via
 *     `abandonLingeringHullToScrap`. Galaxy-rooms only — engineering
 *     rooms have no roster and skip entirely.
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
  /** Number of connected clients. When > 0 the sector is ALWAYS
   *  non-idle: an active observer expects steady snapshot cadence
   *  for prediction reconcile + scene update, and the marginal CPU
   *  savings of suppressing broadcasts to an AFK observer don't
   *  justify the 250-1184 ms recv_gap_long freezes the suppression
   *  produces during natural play lulls (user smoke 2026-06-01,
   *  capture `2026-06-01T16-07-35Z-0bboym`). Empty-sector broadcast
   *  skipping is still handled by the room-level
   *  `clients.length === 0` short-circuit upstream. */
  connectedClientCount: number;
  /** Drone (swarm-entity) count in the sector. */
  swarmEntityCount: number;
  forceBroadcastUntilTick: number;
  idleMotionEpsilonSq: number;
  idleThresholdTicks: number;
}

export function evaluateSectorIdle(ctx: IdleEvalCtx): boolean {
  // 2026-06-01 — any connected client forces non-idle. See doc on
  // `connectedClientCount` above. The lower checks (swarm / motion /
  // projectiles) remain as a fallback for sectors that simulate
  // headlessly (galaxy rooms tick even with zero clients) so that
  // their idle tracker stays correctly frozen when nobody's
  // observing — kept for future broadcast paths that might pull state
  // from the idle tracker (e.g. presence-driven cost gating).
  if (ctx.connectedClientCount > 0) {
    noteSectorEvent(ctx.idleTracker, ctx.serverTick);
  } else if (ctx.swarmEntityCount > 0) {
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

/** A ship whose roster row has been deleted while it is still in the
 *  sector. `lingering` distinguishes a displaced/disconnected hull
 *  (`isActive=false`, owned slot lives in `lingeringSlots`) from a
 *  player's live active hull (`isActive=true`, slot in `playerToSlot`).
 *  The two need different abandon→scrap transactions. */
export interface AbandonedShip {
  shipInstanceId: string;
  playerId: string;
  lingering: boolean;
}

/**
 * Phase 4 — abandon detection. Every 30 ticks (~500 ms) we check
 * whether any ship currently in this room has had its roster row
 * deleted (via /dev/player-ships/:shipId/abandon). Returns the ships to
 * shatter into scrap.
 *
 * Intended behaviour: "an abandoned ship leaves the world." BOTH active
 * hulls AND lingering hulls are in the world (a remote observer renders
 * the lingering hull), so both shatter into scrap when abandoned. The
 * caller routes on `lingering`:
 * `abandonShipToScrap(playerId)` for active hulls (playerId-keyed),
 * `abandonLingeringHullToScrap(shipInstanceId)` for lingering hulls
 * (shipInstanceId-keyed — the owning player may be piloting a different
 * active hull, so the path must not touch playerId-keyed state).
 */
export function findAbandonedShips(
  ships: MapSchema<ShipState>,
  store: PlayerShipStore,
): AbandonedShip[] {
  const abandoned: AbandonedShip[] = [];
  for (const [, ship] of ships) {
    if (ship.shipInstanceId === '' || !ship.alive) continue;
    if (store.get(ship.shipInstanceId) === null) {
      abandoned.push({
        shipInstanceId: ship.shipInstanceId,
        playerId: ship.playerId,
        lingering: !ship.isActive,
      });
    }
  }
  return abandoned;
}
