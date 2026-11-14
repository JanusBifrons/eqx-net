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
 *   - `shipOffsets: Map<shipInstanceId, LingerOffset>` — per-frame
 *     visual lerp (position AND angle) toward the authoritative pose
 *     (avoids the visible teleport when the snapshot reconciles a body
 *     that's been free-running).
 *   - `motion: Map<shipInstanceId, LingerMotion>` — the hull's last
 *     snapshot angvel + input bits (RTS slice 4c).
 *
 * RTS slice 4c — a lingering hull is FLOWN by a server-side wingman with
 * player control bits, so it is a remote moving ship and follows the
 * remote-ship recipe (src/client/CLAUDE.md "ONE PARADIGM"): each snapshot
 * resets the body to the authoritative pose INCLUDING its angvel, then the
 * hull's `lastInput` is applied every predicted tick (bounded by
 * `STAGE_3_MAX_LOOKAHEAD_TICKS`, like `applyRemoteInputs`), so the body
 * turns and thrusts between snapshots instead of freezing its angle and
 * jumping at 20 Hz. The residual reconcile delta (position and angle) is
 * hidden by decaying spring offsets.
 *
 * Two write sites (snapshot pose + Colyseus schema diff with `kind`)
 * race; `ensure()` is a no-op when the mirror entry isn't fully
 * populated and the OTHER site re-fires when its piece arrives.
 * Closes the "colliding through my hulk" regression (2026-05-13).
 */

import { springStep, type SpringState } from '@core/math/CritDampedSpring';
import type { PhysicsWorld, ShipInput } from '@core/physics/World';
import type { RenderMirror } from '@core/contracts/IRenderer';
import {
  ANGLE_NOISE_THRESHOLD,
  REMOTE_SPRING_POS_END,
  REMOTE_SPRING_VEL_END_MS,
  STAGE_3_MAX_LOOKAHEAD_TICKS,
  remoteOffsetHalfLifeForDrift,
} from './predictionTuning.js';

interface LingerOffset {
  sx: SpringState;
  sy: SpringState;
  /** Angle offset (rad, wrapped to ±π at capture), decays to 0. */
  sa: SpringState;
  halfLifeMs: number;
}

/** Per-hull motion state from the latest snapshot (RTS slice 4c). */
interface LingerMotion {
  /** `linger-${shipInstanceId}`, built once (no per-tick key alloc, #14). */
  bodyId: string;
  angvel: number;
  /** Reused input object; mutated in place on a snapshot carrying bits. */
  input: ShipInput;
  /** True once the wire has carried bits for this hull. */
  hasInput: boolean;
  /** Ticks of input applied since the last snapshot reset. */
  forwardTicks: number;
}

/** Half-life for the angle offset spring. A little longer than the
 *  position one: a 20 Hz rotation residual reads as a twitch, not a slide. */
const ANGLE_OFFSET_HALF_LIFE_MS = 40;
const ANGLE_SPRING_VEL_END = 0.05; // rad/s

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** The wire's input bits as they reach the router (optional on the wire). */
export interface LingerInputBits {
  thrust: boolean;
  turnLeft: boolean;
  turnRight: boolean;
  boost: boolean;
  reverse: boolean;
}

export class LingeringPredBodyManager {
  /** bodyIds (`linger-${shipInstanceId}`) currently spawned in predWorld. */
  private readonly predLingeringIds = new Set<string>();
  /** Per-lingering-hull render lerp offsets, keyed by shipInstanceId. */
  private readonly shipOffsets = new Map<string, LingerOffset>();
  /** Per-lingering-hull angvel + input bits, keyed by shipInstanceId. */
  private readonly motion = new Map<string, LingerMotion>();

  /**
   * Record the hull's snapshot angvel and (when the wire carried them) its
   * input bits. Absent bits mean "unchanged" (the server's idle-bits dedupe),
   * so the previous bits are kept. Call BEFORE `ensure()` for the same
   * snapshot. Returns the hull's current thrust bit (for the renderer).
   */
  noteSnapshot(shipInstanceId: string, angvel: number, bits: LingerInputBits | undefined): boolean {
    let m = this.motion.get(shipInstanceId);
    if (!m) {
      m = {
        bodyId: `linger-${shipInstanceId}`,
        angvel: 0,
        input: { thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false },
        hasInput: false,
        forwardTicks: 0,
      };
      this.motion.set(shipInstanceId, m);
    }
    m.angvel = Number.isFinite(angvel) ? angvel : 0;
    if (bits) {
      m.input.thrust = bits.thrust;
      m.input.turnLeft = bits.turnLeft;
      m.input.turnRight = bits.turnRight;
      m.input.boost = bits.boost;
      m.input.reverse = bits.reverse;
      m.hasInput = true;
    }
    return m.input.thrust;
  }

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
    const m = this.motion.get(shipInstanceId);
    const angvel = m ? m.angvel : 0;
    if (m) m.forwardTicks = 0;
    // Phase 6b reconciliation (2026-05-13): capture the body's current
    // predicted pose BEFORE we teleport it to the server-authoritative
    // snapshot pose, so we can store the diff as a spring-decayed sprite
    // offset and avoid a visible teleport.
    if (!isFresh) {
      const before = predWorld.getShipState(bodyId);
      predWorld.setShipState(bodyId, {
        x: entry.x, y: entry.y, angle: entry.angle,
        vx: entry.vx, vy: entry.vy,
        angvel,
      });
      if (before) {
        const ox = before.x - entry.x;
        const oy = before.y - entry.y;
        const oa = wrapPi(before.angle - entry.angle);
        const dist = Math.hypot(ox, oy);
        const posMoved = dist > 1;
        const angMoved = Math.abs(oa) > ANGLE_NOISE_THRESHOLD;
        if (posMoved || angMoved) {
          const halfLifeMs = remoteOffsetHalfLifeForDrift(dist);
          const existing = this.shipOffsets.get(shipInstanceId);
          if (existing) {
            // Re-anchor on the new delta, ADDING to what's still decaying on
            // the axes that didn't move: the sprite stays where it was drawn.
            if (posMoved) {
              existing.sx.x = ox; existing.sx.v = 0;
              existing.sy.x = oy; existing.sy.v = 0;
              existing.halfLifeMs = halfLifeMs;
            }
            if (angMoved) { existing.sa.x = oa; existing.sa.v = 0; }
          } else {
            this.shipOffsets.set(shipInstanceId, {
              sx: { x: posMoved ? ox : 0, v: 0 },
              sy: { x: posMoved ? oy : 0, v: 0 },
              sa: { x: angMoved ? oa : 0, v: 0 },
              halfLifeMs,
            });
          }
        }
      }
    } else {
      predWorld.setShipState(bodyId, {
        x: entry.x, y: entry.y, angle: entry.angle,
        vx: entry.vx, vy: entry.vy,
        angvel,
      });
    }
  }

  /**
   * Forward-predict every lingering hull one tick with its last input bits
   * (the remote-ship Stage-3 rule, `applyRemoteInputs`): called once per
   * reconcile replay tick and once per `tickPhysics` input-loop tick, before
   * `predWorld.tick`. Bounded by `STAGE_3_MAX_LOOKAHEAD_TICKS` per snapshot;
   * past that the body integrates with damping only. Alloc-free (#14).
   */
  applyInputs(predWorld: PhysicsWorld): void {
    for (const m of this.motion.values()) {
      if (!m.hasInput) continue;
      if (m.forwardTicks >= STAGE_3_MAX_LOOKAHEAD_TICKS) continue;
      if (!this.predLingeringIds.has(m.bodyId)) continue;
      predWorld.applyInput(m.bodyId, m.input);
      m.forwardTicks++;
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
    this.motion.delete(shipInstanceId);
    this.shipOffsets.delete(shipInstanceId);
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
      let ox = 0, oy = 0, oa = 0;
      if (off) {
        springStep(off.sx, 0, off.halfLifeMs, lastFrameMs);
        springStep(off.sy, 0, off.halfLifeMs, lastFrameMs);
        springStep(off.sa, 0, ANGLE_OFFSET_HALF_LIFE_MS, lastFrameMs);
        ox = off.sx.x;
        oy = off.sy.x;
        oa = off.sa.x;
        const stillMoving =
          Math.abs(off.sx.x) > REMOTE_SPRING_POS_END ||
          Math.abs(off.sy.x) > REMOTE_SPRING_POS_END ||
          Math.abs(off.sx.v) > REMOTE_SPRING_VEL_END_MS ||
          Math.abs(off.sy.v) > REMOTE_SPRING_VEL_END_MS ||
          Math.abs(off.sa.x) > ANGLE_NOISE_THRESHOLD ||
          Math.abs(off.sa.v) > ANGLE_SPRING_VEL_END;
        if (!stillMoving) this.shipOffsets.delete(shipInstanceId);
      }
      entry.x = pose.x + ox;
      entry.y = pose.y + oy;
      entry.angle = pose.angle + oa;
      entry.vx = pose.vx;
      entry.vy = pose.vy;
    }
  }

  /** For room-teardown — iterate every tracked bodyId. */
  *trackedBodyIds(): IterableIterator<string> {
    for (const id of this.predLingeringIds) yield id;
  }
}
