/**
 * Phase 6b lingering-hull predWorld bridge.
 *
 * Lingering hulls (the parked ship a player leaves behind on
 * disconnect / sector-transit / fresh-spawn-displace) need a body in the
 * client's predWorld so:
 *   - the local player can collide with parked hulls
 *   - predicted ghost projectiles have a body to test against
 *
 * Server-side projectile sweep handles authoritative damage; this
 * predWorld body is local-only and identifies with the `linger-`
 * prefix so it can't collide with the playerId namespace.
 *
 * Owns:
 *   - `predLingeringIds: Set<string>` — which bodyIds are spawned
 *   - `_lingeringShipOffsets: Map<shipInstanceId, SpringOffset>` —
 *     per-frame visual lerp toward the authoritative pose (avoids
 *     the visible teleport when the snapshot reconciles a body
 *     that's been free-running).
 *
 * Two write sites (snapshot pose + Colyseus schema diff with `kind`)
 * race; `ensure()` is a no-op when the mirror entry isn't fully
 * populated and the OTHER site re-fires when its piece arrives.
 * Closes the "colliding through my hulk" regression (2026-05-13).
 */

import { springStep, type SpringState } from '@core/math/CritDampedSpring';
import type { PhysicsWorld } from '@core/physics/World';
import type { RenderMirror } from '@core/contracts/IRenderer';
import {
  REMOTE_SPRING_POS_END,
  REMOTE_SPRING_VEL_END_MS,
  remoteOffsetHalfLifeForDrift,
} from './predictionTuning.js';

interface LingerOffset {
  sx: SpringState;
  sy: SpringState;
  halfLifeMs: number;
}

export class LingeringPredBodyManager {
  /** bodyIds (`linger-${shipInstanceId}`) currently spawned in predWorld. */
  private readonly predLingeringIds = new Set<string>();
  /** Per-lingering-hull render lerp offsets, keyed by shipInstanceId. */
  private readonly shipOffsets = new Map<string, LingerOffset>();

  /**
   * Spawn / update the predWorld body for a lingering hull, given that
   * both `kind` and pose have been populated in the mirror. No-op when
   * the mirror entry isn't fully populated — the other call site (the
   * one carrying the missing piece) re-fires `ensure()` once available.
   */
  ensure(shipInstanceId: string, predWorld: PhysicsWorld, mirror: RenderMirror): void {
    const entry = mirror.lingeringShips?.get(shipInstanceId);
    if (!entry || !entry.kind) return;
    const bodyId = `linger-${shipInstanceId}`;
    const isFresh = !predWorld.hasShip(bodyId);
    if (isFresh) {
      predWorld.spawnShip(bodyId, entry.x, entry.y, entry.kind);
      this.predLingeringIds.add(bodyId);
    }
    // Phase 6b reconciliation (2026-05-13): capture the body's current
    // predicted pose BEFORE we teleport it to the server-authoritative
    // snapshot pose, so we can store the diff as a spring-decayed sprite
    // offset and avoid a visible teleport.
    if (!isFresh) {
      const before = predWorld.getShipState(bodyId);
      predWorld.setShipState(bodyId, {
        x: entry.x, y: entry.y, angle: entry.angle,
        vx: entry.vx, vy: entry.vy,
        angvel: 0,
      });
      if (before) {
        const ox = before.x - entry.x;
        const oy = before.y - entry.y;
        const dist = Math.hypot(ox, oy);
        if (dist > 1) {
          const halfLifeMs = remoteOffsetHalfLifeForDrift(dist);
          const existing = this.shipOffsets.get(shipInstanceId);
          if (existing) {
            existing.sx.x = ox; existing.sx.v = 0;
            existing.sy.x = oy; existing.sy.v = 0;
            existing.halfLifeMs = halfLifeMs;
          } else {
            this.shipOffsets.set(shipInstanceId, {
              sx: { x: ox, v: 0 },
              sy: { x: oy, v: 0 },
              halfLifeMs,
            });
          }
        }
      }
    } else {
      predWorld.setShipState(bodyId, {
        x: entry.x, y: entry.y, angle: entry.angle,
        vx: entry.vx, vy: entry.vy,
        angvel: 0,
      });
    }
  }

  /**
   * Despawn a lingering body the snapshot evictor removed. The caller
   * (SnapshotApplier eviction loop) has already deleted the mirror
   * entry; this just drops the predWorld body + the bookkeeping Set.
   */
  despawn(shipInstanceId: string, predWorld: PhysicsWorld): void {
    const bodyId = `linger-${shipInstanceId}`;
    if (this.predLingeringIds.has(bodyId)) {
      predWorld.despawnShip(bodyId);
      this.predLingeringIds.delete(bodyId);
    }
  }

  /** True when the bodyId (`linger-${...}`) is tracked here. */
  has(bodyId: string): boolean {
    return this.predLingeringIds.has(bodyId);
  }

  /**
   * Per-frame visual lerp: step each spring offset toward zero, write
   * the resolved pose (predWorld pose + offset) onto the mirror entry.
   * Drops a spring once it has settled below the end thresholds.
   *
   * The pattern is identical to the remote-ship offset apply loop in
   * updateMirror — pulled out here so the lingering family of state
   * lives in one place.
   */
  applyPerFrameOffsets(
    predWorld: PhysicsWorld,
    mirror: RenderMirror,
    lastFrameMs: number,
  ): void {
    if (!mirror.lingeringShips) return;
    for (const [shipInstanceId, entry] of mirror.lingeringShips) {
      const bodyId = `linger-${shipInstanceId}`;
      if (!predWorld.hasShip(bodyId)) continue;
      const pose = predWorld.getShipState(bodyId);
      if (!pose) continue;
      const off = this.shipOffsets.get(shipInstanceId);
      let ox = 0, oy = 0;
      if (off) {
        springStep(off.sx, 0, off.halfLifeMs, lastFrameMs);
        springStep(off.sy, 0, off.halfLifeMs, lastFrameMs);
        ox = off.sx.x;
        oy = off.sy.x;
        const stillMoving =
          Math.abs(off.sx.x) > REMOTE_SPRING_POS_END ||
          Math.abs(off.sy.x) > REMOTE_SPRING_POS_END ||
          Math.abs(off.sx.v) > REMOTE_SPRING_VEL_END_MS ||
          Math.abs(off.sy.v) > REMOTE_SPRING_VEL_END_MS;
        if (!stillMoving) this.shipOffsets.delete(shipInstanceId);
      }
      entry.x = pose.x + ox;
      entry.y = pose.y + oy;
      entry.angle = pose.angle;
      entry.vx = pose.vx;
      entry.vy = pose.vy;
    }
  }

  /** For room-teardown — iterate every tracked bodyId. */
  *trackedBodyIds(): IterableIterator<string> {
    for (const id of this.predLingeringIds) yield id;
  }
}
