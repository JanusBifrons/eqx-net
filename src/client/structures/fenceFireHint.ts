/**
 * A fence blocks every shot, its owner's own turret fire included (user ruling
 * 2026-11-02). While placing a turret, warn when a shield wall lies within its
 * range: fire that crosses it stops there. Any wall counts (yours or anyone's).
 *
 * Pure + allocation-free: walls come from the same `visitDerivedWalls` the
 * renderer and the prediction world use (#15); the visitor is a reused object.
 */
import type { StructureRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { getStructureKind, isStructureKindId } from '../../shared-types/structureKinds.js';
import { visitDerivedWalls, type DerivedWallVisitor } from './derivedWalls.js';

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

const probe = { x: 0, y: 0, r: 0, hit: false };
const visitor: DerivedWallVisitor = {
  wall(_key, ax, ay, bx, by) {
    if (!probe.hit && distToSegment(probe.x, probe.y, ax, ay, bx, by) <= probe.r) probe.hit = true;
  },
};

/** The weapon range of a structure kind that fires shots, else 0. */
export function turretRangeOf(kind: string): number {
  if (!isStructureKindId(kind)) return 0;
  return getStructureKind(kind).weaponRange ?? 0;
}

/** Would a turret of `kind` at (x, y) have a shield wall within its range? */
export function turretFireCrossesWall(
  kind: string,
  x: number,
  y: number,
  structures: ReadonlyMap<number, StructureRenderState> | undefined,
  swarm: ReadonlyMap<number, SwarmRenderState> | undefined,
): boolean {
  const r = turretRangeOf(kind);
  if (r <= 0 || !structures || !swarm || structures.size === 0) return false;
  probe.x = x;
  probe.y = y;
  probe.r = r;
  probe.hit = false;
  visitDerivedWalls(structures, swarm, visitor);
  return probe.hit;
}
