/**
 * Client-side shield walls, derived from the structure mirror (plan
 * soft-leaping-truffle v2, phase V gates). The client mirror of the server's
 * `ShieldWallManager` rules (#15), shared by the renderer (draws them) and the
 * prediction world (collides with them), so both always agree:
 *
 *   - a FENCE wall between any two connected, built shield emitters (pylons and
 *     gates), anchored on the gate post nearest the far end (`emitterAnchor`).
 *     It blocks while both ends report their walls up (STRUCTURE_FLAG_WALL_ACTIVE).
 *   - the Ancients' gate's iris spans (solid only while SEALED). A chamber
 *     pad (`isPadChamberKind`) has no iris: its blast doors are rig leaves
 *     (teleporter redesign T3), like a gate's.
 *   Gates and airlocks have no shield span across their gap any more: their
 *   SOLID sliding doors are rig leaves (docs/plans/door-power.md, slice 11).
 *
 * Allocation-free: a visitor object (created once by the caller) receives each
 * wall with a numeric key — pairs `lo * 65536 + hi`, iris spans negative.
 */
import type { StructureRenderState, SwarmRenderState } from '../../core/contracts/IRenderer.js';
import { GATE_SPAN_THICKNESS, emitterAnchor, isShieldEmitterKind } from '../../core/structures/gateGeometry.js';
import { SHIELD_WALL_THICKNESS } from '../../core/structures/ShieldWall.js';
import { PAD_SPECS, TP_PHASE, isPadChamberKind, isTeleporterKind, padIrisSpanLocal } from '../../shared-types/teleport.js';

export interface DerivedWallVisitor {
  /** `open`: an unsealed teleporter iris (the Ancients' gate; not blocking by design, as opposed
   *  to a wall that is down). */
  wall(key: number, ax: number, ay: number, bx: number, by: number, blocking: boolean, thickness: number, open: boolean): void;
}

const A = { x: 0, y: 0 };
const B = { x: 0, y: 0 };
const IRIS = { ax: 0, ay: 0, bx: 0, by: 0 };
/** Iris span keys: -(IRIS_KEY_BASE + id * 16 + i + 1). */
const IRIS_KEY_BASE = 2_000_000_000;

export function visitDerivedWalls(
  structures: ReadonlyMap<number, StructureRenderState>,
  swarm: ReadonlyMap<number, SwarmRenderState>,
  v: DerivedWallVisitor,
): void {
  for (const id of structures.keys()) {
    const st = structures.get(id)!;
    if (!st.built) continue;
    const e = swarm.get(id);
    if (!e) continue;
    // v4 T2 — the Ancients' gate's iris: the spans between its posts, solid
    // only while SEALED (the server's iris walls, #15). Drawn as open
    // otherwise. A chamber pad has none (redesign T3): its doors are leaves.
    if (isPadChamberKind(e.shipKind)) continue;
    if (st.teleport !== undefined && isTeleporterKind(e.shipKind)) {
      const sealed = st.teleport.phase === TP_PHASE.SEALED;
      const n = PAD_SPECS[e.shipKind].posts;
      for (let i = 0; i < n; i++) {
        padIrisSpanLocal(e.shipKind, i, IRIS);
        v.wall(-(IRIS_KEY_BASE + id * 16 + i + 1), e.x + IRIS.ax, e.y + IRIS.ay, e.x + IRIS.bx, e.y + IRIS.by, sealed, GATE_SPAN_THICKNESS, !sealed);
      }
      continue;
    }
    if (!isShieldEmitterKind(e.shipKind)) continue;
    const up = st.wallActive === true;
    // Fence walls to connected emitters (each pair once, from the lower id).
    const conn = st.connTo;
    for (let c = 0; c < conn.length; c++) {
      const other = conn[c]!;
      if (other <= id) continue;
      const ost = structures.get(other);
      const oe = swarm.get(other);
      if (!ost || !oe || !ost.built || !isShieldEmitterKind(oe.shipKind)) continue;
      emitterAnchor(oe.shipKind, oe.x, oe.y, oe.angle, e.x, e.y, B, ost.mirror);
      emitterAnchor(e.shipKind, e.x, e.y, e.angle, B.x, B.y, A, st.mirror);
      emitterAnchor(oe.shipKind, oe.x, oe.y, oe.angle, A.x, A.y, B, ost.mirror);
      v.wall(id * 65536 + other, A.x, A.y, B.x, B.y, up && ost.wallActive === true, SHIELD_WALL_THICKNESS, false);
    }
  }
}
