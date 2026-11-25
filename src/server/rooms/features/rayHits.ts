/**
 * The room's NPC / turret ray hits (friendly fire, owner decision 2026-11-10):
 * the first thing an AI or structure-turret beam meets, and the live target
 * shape for a drone shot's range gate. Moved verbatim out of `SectorRoom`
 * (god-file split slice 53); the room hands in live accessors.
 *
 * The two narrow phases (`playerHitscanDist`, `swarmRayHit`) read nothing from
 * the room, so they are plain functions; the line-of-fire gate
 * (`features/npcLineOfFire.ts`) and the fire resolvers use them too.
 */
import type { SwarmEntityRecord, SwarmEntityRegistry } from '../../net/SwarmEntityRegistry.js';
import { isLootPod, isWreckPiece } from '../../net/SwarmEntityRegistry.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { ShipState } from '../schema/SectorState.js';
import type { AiFireTargetShape } from '../AiFireResolver.js';
import type { PilotSwap } from './pilotSwap.js';
import { rayHitsSphere, rayHitsConvexPolygon, rayHitsBox } from '../../../core/combat/Weapons.js';
import { shipRayHit } from '../../../core/combat/shipHitShape.js';
import { wreckRayHit } from '../../../core/destruction/wreckHits.js';
import { fillRangeShape } from '../../../core/combat/fireControlBearing.js';
import { GLOBAL_SHIP_TUNING } from '../../../shared-types/shipScale/lookup.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF, SLOT_ANGLE_OFF } from '../../../shared-types/sabLayout.js';

/**
 * Player hitscan distance with the PERF GUARANTEE: the cheap
 * bounding-circle test runs FIRST. If it misses, return null (the
 * hull polygon is strictly inside the circle, so a circle miss is a
 * polygon miss). If the shield is up, return the circle distance —
 * byte-identical to the legacy single rayHitsSphere call. Only when
 * the circle WOULD hit AND the shield is down (=== 0) do we pay for
 * the exact hull-polygon refinement.
 */
export function playerHitscanDist(
  ship: ShipState,
  fx: number, fy: number, dx: number, dy: number, maxDist: number,
  cx: number, cy: number, angle: number, halfWidth = 0,
): number | null {
  // The ship's own hit shape, whoever flies it (`shipHitShape.ts`, owner's
  // rule 2026-11-13): the shield bubble (radius + shieldPad, the drawn aura)
  // while its shield is up, the hull once it is down, a capital's hull either
  // way. NPC beams and bolts on drones go through the same helper. A wide
  // beam (`halfWidth`, the heavy beam) hits by its width.
  return shipRayHit(ship.kind, ship.shield > 0, fx, fy, dx, dy, maxDist, cx, cy, angle, halfWidth);
}

/** Narrow phase for one swarm entity at (cx, cy, ca): the same shapes every
 *  NPC/turret beam uses (rock polygon, structure box, ship circle + capital
 *  hull refine). Shared by `nonPlayerRayHit` and the line-of-fire gate.
 *  `hw`: a wide beam's half-width, the same capsule on every shape. */
export function swarmRayHit(
  rec: SwarmEntityRecord, fx: number, fy: number, dx: number, dy: number, maxDist: number,
  cx: number, cy: number, ca: number, hw = 0,
): number | null {
  if (isWreckPiece(rec) || rec.wreckParts !== undefined) return wreckRayHit(rec.wreckParts, rec.radius, fx, fy, dx, dy, maxDist, cx, cy, ca, hw); // wreck piece or cut-field rock (C1b)
  if (rec.kind === 0 && rec.vertices) return rayHitsConvexPolygon(fx, fy, dx, dy, maxDist, cx, cy, ca, rec.vertices, hw);
  if (rec.halfW !== undefined && rec.halfH !== undefined) return rayHitsBox(fx, fy, dx, dy, maxDist, cx, cy, rec.halfW, rec.halfH, rec.boxes, hw, rec.turnDeg);
  // A ship: the same shape as if a player flew it (`shipHitShape.ts`).
  if (rec.kind === 1 && rec.shipKind) return shipRayHit(rec.shipKind, !rec.shieldDown, fx, fy, dx, dy, maxDist, cx, cy, ca, hw);
  return rayHitsSphere(fx, fy, dx, dy, maxDist, cx, cy, rec.radius + hw);
}

/** A ray hit: the entity id, its wire id and the distance along the ray. */
export interface RoomRayHit { id: string; wireId: string; dist: number }

/** What the ray hits need from the room; getters read the live field. */
export interface RoomRayHitsHost {
  swarmRegistry: Pick<SwarmEntityRegistry, 'all' | 'get'>;
  lingeringSlots: ReadonlyMap<string, number>;
  lingeringPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  shipPoseCache: ReadonlyMap<string, ShipPhysicsState>;
  sabF32(): Float32Array;
  playerToSlot(): ReadonlyMap<string, number>;
  /** The room state's ships (lingering hulls). */
  ships(): { get(shipInstanceId: string): ShipState | undefined };
  getActiveShip(playerId: string): ShipState | undefined;
  /** Pilot swap (built after this field), for a parked pilot's hull. */
  pilotSwap(): Pick<PilotSwap, 'engageablePilotHull'>;
  /** A swarm entity's hit shape for the hull range gate (the room's). */
  writeSwarmRangeShape(out: AiFireTargetShape, rec: SwarmEntityRecord): void;
}

export class RoomRayHits {
  /** Reused result of `nonPlayerRayHit` (#14). */
  private readonly _rayHit: RoomRayHit = { id: '', wireId: '', dist: 0 };

  constructor(private readonly h: RoomRayHitsHost) {}

  /**
   * Friendly fire (owner decision 2026-11-10) — the first non-player thing a
   * ray meets: lingering hulls and EVERY swarm entity (drones of any side,
   * structures of any owner, asteroids, scrap), skipping only `skipId` (the
   * shooter). Live SAB poses, the same shapes as the player beam
   * (`PlayerFireResolver.hitscan`). Used by the NPC beam and the structure
   * turret beam. Returns the reused `_rayHit` or null. Alloc-free.
   * `halfWidth`: a wide beam hits by its width (`beamHalfWidth`); 0 ⇒ thin.
   */
  nonPlayerRayHit(
    fx: number, fy: number, dx: number, dy: number, maxDist: number, skipId: string, halfWidth = 0,
  ): RoomRayHit | null {
    const h = this.h;
    let best = maxDist;
    let bestId: string | null = null;
    let bestEid = -1; // swarm wire id built once at the end (lingering: -1)
    const ships = h.ships();
    for (const [shipInstanceId] of h.lingeringSlots) {
      const p = h.lingeringPoseCache.get(shipInstanceId);
      if (!p) continue;
      // A parked hull is the same ship it was when flown (#18), not a fighter.
      const ls = ships.get(shipInstanceId);
      const d = ls !== undefined
        ? playerHitscanDist(ls, fx, fy, dx, dy, best, p.x, p.y, p.angle, halfWidth)
        : rayHitsSphere(fx, fy, dx, dy, best, p.x, p.y, GLOBAL_SHIP_TUNING.hitRadius + halfWidth);
      if (d !== null && d < best) { best = d; bestId = shipInstanceId; bestEid = -1; }
    }
    const sab = h.sabF32();
    for (const rec of h.swarmRegistry.all()) {
      if (rec.id === skipId) continue;
      // Nobody fights a loot pod (owner 2026-11-13): AI and turret beams pass it.
      if (isLootPod(rec)) continue;
      const b = slotBase(rec.slot);
      const d = swarmRayHit(
        rec, fx, fy, dx, dy, best,
        sab[b + SLOT_X_OFF]!, sab[b + SLOT_Y_OFF]!, sab[b + SLOT_ANGLE_OFF]!, halfWidth,
      );
      if (d !== null && d < best) { best = d; bestId = rec.id; bestEid = rec.entityId; }
    }
    if (bestId === null) return null;
    const out = this._rayHit;
    out.id = bestId;
    out.wireId = bestEid >= 0 ? `swarm-${bestEid}` : bestId;
    out.dist = best;
    return out;
  }

  /** A drone shot's target: live centre and hit shape for the per-mount range
   *  gate (`AiFireResolver.targetShape`). Reads the SAB directly, never the
   *  `swarmEntitySnapshot` scratch. */
  aiFireTargetShape(targetId: string, out: AiFireTargetShape): boolean {
    const rec = this.h.swarmRegistry.get(targetId);
    if (rec != null) {
      const b = slotBase(rec.slot);
      const sab = this.h.sabF32();
      out.x = sab[b + SLOT_X_OFF]!; out.y = sab[b + SLOT_Y_OFF]!;
      this.h.writeSwarmRangeShape(out, rec);
      return true;
    }
    const hull = this.h.pilotSwap().engageablePilotHull(targetId);
    if (!hull) return false;
    out.x = hull.pose.x; out.y = hull.pose.y;
    fillRangeShape(out, hull.pose.angle, true, hull.ship.kind, hull.ship.shield > 0, 0);
    return true;
  }

  /** The first thing a structure turret's beam meets, players included
   *  (friendly fire: its owner's own ship too). Null ⇒ nothing in reach. */
  turretBeamFirstHit(
    fx: number, fy: number, dx: number, dy: number, maxDist: number, skipId: string,
  ): RoomRayHit | null {
    const h = this.h;
    let best = maxDist;
    let bestId: string | null = null;
    for (const [pid] of h.playerToSlot()) {
      const ship = h.getActiveShip(pid);
      if (!ship || !ship.alive || ship.travelling) continue;
      const pose = h.shipPoseCache.get(pid);
      if (!pose) continue;
      const d = playerHitscanDist(ship, fx, fy, dx, dy, best, pose.x, pose.y, pose.angle);
      if (d !== null && d < best) { best = d; bestId = pid; }
    }
    const other = this.nonPlayerRayHit(fx, fy, dx, dy, best, skipId);
    if (other !== null && other.dist < best) return other;
    if (bestId === null) return null;
    const out = this._rayHit;
    out.id = bestId;
    out.wireId = bestId;
    out.dist = best;
    return out;
  }
}
