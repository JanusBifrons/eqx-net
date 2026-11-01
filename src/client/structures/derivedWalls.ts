/**
 * Client-side shield walls, derived from the structure mirror (plan
 * soft-leaping-truffle v2, phase V gates). The client mirror of the server's
 * `ShieldWallManager` rules (#15), shared by the renderer (draws them) and the
 * prediction world (collides with them), so both always agree:
 *
 *   - a FENCE wall between any two connected, built shield emitters (pylons and
 *     gates), anchored on the gate post nearest the far end (`emitterAnchor`).
 *     It blocks while both ends report their walls up (STRUCTURE_FLAG_WALL_ACTIVE).
 *   - each built gate's own SPANS (one per gate, one per airlock end). A span
 *     blocks while the gate's walls are up AND that end is closed (`gateOpen`).
 *
 * Allocation-free: a visitor object (created once by the caller) receives each
 * wall with a numeric key — pairs `lo * 65536 + hi`, spans `-(id * 4 + i + 1)`.
 */
import type { StructureRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import {
  GATE_SPAN_THICKNESS,
  emitterAnchor,
  gateSpanWorld,
  gateSpans,
  gateTypeOf,
  isShieldEmitterKind,
} from '../../core/structures/gateGeometry.js';
import { SHIELD_WALL_THICKNESS } from '../../core/structures/ShieldWall.js';

export interface DerivedWallVisitor {
  /** `open`: a gate span whose end is open (not blocking by design, as opposed
   *  to a wall that is down). */
  wall(key: number, ax: number, ay: number, bx: number, by: number, blocking: boolean, thickness: number, open: boolean): void;
}

const A = { x: 0, y: 0 };
const B = { x: 0, y: 0 };

export function visitDerivedWalls(
  structures: ReadonlyMap<number, StructureRenderState>,
  swarm: ReadonlyMap<number, SwarmRenderState>,
  v: DerivedWallVisitor,
): void {
  for (const id of structures.keys()) {
    const st = structures.get(id)!;
    if (!st.built) continue;
    const e = swarm.get(id);
    if (!e || !isShieldEmitterKind(e.shipKind)) continue;
    const up = st.wallActive === true;
    // The gate's own spans.
    if (gateTypeOf(e.shipKind) !== null) {
      const n = gateSpans(e.shipKind).length;
      const open = st.gateOpen ?? 0;
      for (let i = 0; i < n; i++) {
        if (!gateSpanWorld(e.shipKind, e.x, e.y, e.angle, i, A, B)) continue;
        const isOpen = (open & (1 << i)) !== 0;
        v.wall(-(id * 4 + i + 1), A.x, A.y, B.x, B.y, up && !isOpen, GATE_SPAN_THICKNESS, isOpen);
      }
    }
    // Fence walls to connected emitters (each pair once, from the lower id).
    const conn = st.connTo;
    for (let c = 0; c < conn.length; c++) {
      const other = conn[c]!;
      if (other <= id) continue;
      const ost = structures.get(other);
      const oe = swarm.get(other);
      if (!ost || !oe || !ost.built || !isShieldEmitterKind(oe.shipKind)) continue;
      emitterAnchor(oe.shipKind, oe.x, oe.y, oe.angle, e.x, e.y, B);
      emitterAnchor(e.shipKind, e.x, e.y, e.angle, B.x, B.y, A);
      emitterAnchor(oe.shipKind, oe.x, oe.y, oe.angle, A.x, A.y, B);
      v.wall(id * 65536 + other, A.x, A.y, B.x, B.y, up && ost.wallActive === true, SHIELD_WALL_THICKNESS, false);
    }
  }
}
