/**
 * Rigs of structure family "fences" (docs/plans/structure-restyle-stage4.md §4 0a, §6).
 * Fences + gates: shield pylon, gate, airlock, territory lock.
 * This family's moving parts live only here; `rigs` and `rigOfKind` are
 * spread into the catalogue (`rigCatalogue.ts`). Kind -> family:
 * client/render/pixi/structureFamilies.ts (core never imports it).
 */
import { box, type ClipDef, type PartDef, type RigDef } from '../rig.js';
import type { RigKindMap } from './rigFamily.js';
import { AIRLOCK_END_Y, DOOR_TRAVEL_TICKS, gateGapHalf } from '../../structures/gateGeometry.js';
import { structureOutline } from '../../../shared-types/structureKinds/outline.js';
import { SOCKET_OUTLINE_STYLE } from '../../../shared-types/structureKinds/structureSockets.js';
import type { StructureKindId } from '../../../shared-types/structureKinds/types.js';

// ── lock-beacon (territory lock) ─────────────────────────────────────────────
//
// F2: the territory lock's beacon dish, on its sweep arm over the lantern
// tower's beacon seat (the middle of the 400 × 300 footprint), is a SPINNING
// cosmetic hinge (`PartDef.spin`): the client turns it only while the lock is
// holding its sector for its owner's side (the `lockHolding` row flag) and
// holds it where it is otherwise. The server never passes a spin clock, so
// for it the dish sits at rest. No outline: no collider; the dish draws from
// the family hook (`structureStyleC.fences.ts`).

/** Beacon sweep rate (rad per game tick): one slow, calm turn every 8 s at 60 Hz. */
export const LOCK_BEACON_SPIN = (2 * Math.PI) / (8 * 60);

export const LOCK_BEACON_DEF: RigDef = {
  id: 'lock-beacon',
  parts: [{
    id: 'dish', parent: null, anchorX: 0, anchorY: 0,
    joint: { type: 'hinge', min: -Math.PI, max: Math.PI },
    rest: 0, layer: 'plane', kind: 'cosmetic', spin: LOCK_BEACON_SPIN,
  }],
  clips: [],
};

// ── gate-doors (shield gate) / airlock-doors (shield airlock) ────────────────
//
// Solid doors (docs/plans/door-power.md, "SOLID DOORS", slice 4). Each door
// is a pair of PHYSICAL slide leaves (kinematic bodies, so the gap is real
// and a shut door blocks ships and shots). A leaf is one gap-half long: shut
// (joint 0), the pair meets at the gap's centre line with its outer ends on
// the towers' (side blocks') inner faces; open (joint = the open travel),
// each leaf has slid outward into its tower's pocket as far as the
// building's outline allows (`doorOpenTravel`): its whole length on the
// gate, a little less on the airlock, whose cut corners reach the door
// lines, so an open airlock leaf keeps a short lip in the opening (the
// clear width stays wider than the gate's gap) instead of poking out
// through the corner. Clip time is door travel: 0 = shut, DOOR_TRAVEL_TICKS =
// fully open, linear, so a scrubbed clip (`PlayingClip.from` / `rate`)
// maps a door position straight to a pose. The airlock has one pair per end
// (A at local +y, B at -y) and one clip per end; each clip moves only its
// own end's pair (the other end holds at rest = shut).

/** Leaf thickness (local y): thinner than the gate's 72 depth and the
 *  airlock's 64 corner posts, so an open leaf sits inside its tower. */
export const DOOR_LEAF_THICKNESS = 22;
/** Leaf length = slide travel: the shield gate's gap half (88). */
export const GATE_DOOR_LEAF_LEN = gateGapHalf('gate');
/** Leaf length = slide travel: the airlock's gap half (96). */
export const AIRLOCK_DOOR_LEAF_LEN = gateGapHalf('airlock');

/** The x range [min, max] of convex outline `poly` along the line at y `y`. */
function outlineSpanAt(poly: readonly { x: number; y: number }[], y: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    if ((a.y - y) * (b.y - y) > 0 || a.y === b.y) continue;
    const x = a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y);
    lo = Math.min(lo, x); hi = Math.max(hi, x);
  }
  return [lo, hi];
}

/**
 * How far a door's leaves (each `len` long, on the door lines `doorYs`) slide
 * open: their own length (the opening fully clear) unless the building's
 * house-look outline (the one the art draws and clips the tower pockets to)
 * cuts in before an open leaf's outer end; then only as far as keeps both of
 * the leaf's faces, on both sides, inside the outline.
 */
export function doorOpenTravel(kind: StructureKindId, doorYs: readonly number[], len: number): number {
  const poly = structureOutline(kind, SOCKET_OUTLINE_STYLE);
  let reach = Infinity;
  for (const dy of doorYs) {
    for (const y of [dy - DOOR_LEAF_THICKNESS / 2, dy + DOOR_LEAF_THICKNESS / 2]) {
      const [lo, hi] = outlineSpanAt(poly, y);
      reach = Math.min(reach, hi, -lo);
    }
  }
  return Math.min(len, reach - len);
}
/** Open travel of the gate's leaves: the whole leaf (88); the gate's corner
 *  cuts lie beyond its door line. */
export const GATE_DOOR_OPEN_TRAVEL = doorOpenTravel('shield_gate', [0], GATE_DOOR_LEAF_LEN);
/** Open travel of the airlock's leaves (~92.4 of 96): its cut corners reach
 *  the door lines, so a leaf stops with its outer corner on the outline. */
export const AIRLOCK_DOOR_OPEN_TRAVEL = doorOpenTravel('shield_airlock', [AIRLOCK_END_Y, -AIRLOCK_END_Y], AIRLOCK_DOOR_LEAF_LEN);

/** One leaf on side `side` (-1 left, +1 right) of the gap centre, at local y
 *  `y`: `len` long, sliding outward `travel` to open. */
export function leaf(id: string, side: -1 | 1, y: number, len: number, travel: number): PartDef {
  return {
    id, parent: null, anchorX: (side * len) / 2, anchorY: y,
    joint: { type: 'slide', axisX: side, axisY: 0, min: 0, max: travel },
    rest: 0, layer: 'plane', kind: 'physical',
    outline: box(-len / 2, -DOOR_LEAF_THICKNESS / 2, len / 2, DOOR_LEAF_THICKNESS / 2),
  };
}

/** A door clip: `parts` slide linearly from shut (tick 0) to open (`travel`). */
export function doorClip(id: string, parts: readonly string[], travel: number): ClipDef {
  return {
    id,
    tracks: parts.map((part) => ({
      part, keys: [{ tick: 0, value: 0 }, { tick: DOOR_TRAVEL_TICKS, value: travel, ease: 'linear' as const }],
    })),
  };
}

export const GATE_DOORS_DEF: RigDef = {
  id: 'gate-doors',
  parts: [
    leaf('leaf-left', -1, 0, GATE_DOOR_LEAF_LEN, GATE_DOOR_OPEN_TRAVEL),
    leaf('leaf-right', 1, 0, GATE_DOOR_LEAF_LEN, GATE_DOOR_OPEN_TRAVEL),
  ],
  clips: [doorClip('door', ['leaf-left', 'leaf-right'], GATE_DOOR_OPEN_TRAVEL)],
};

export const AIRLOCK_DOORS_DEF: RigDef = {
  id: 'airlock-doors',
  parts: [
    leaf('leaf-a-left', -1, AIRLOCK_END_Y, AIRLOCK_DOOR_LEAF_LEN, AIRLOCK_DOOR_OPEN_TRAVEL),
    leaf('leaf-a-right', 1, AIRLOCK_END_Y, AIRLOCK_DOOR_LEAF_LEN, AIRLOCK_DOOR_OPEN_TRAVEL),
    leaf('leaf-b-left', -1, -AIRLOCK_END_Y, AIRLOCK_DOOR_LEAF_LEN, AIRLOCK_DOOR_OPEN_TRAVEL),
    leaf('leaf-b-right', 1, -AIRLOCK_END_Y, AIRLOCK_DOOR_LEAF_LEN, AIRLOCK_DOOR_OPEN_TRAVEL),
  ],
  clips: [
    doorClip('door-a', ['leaf-a-left', 'leaf-a-right'], AIRLOCK_DOOR_OPEN_TRAVEL),
    doorClip('door-b', ['leaf-b-left', 'leaf-b-right'], AIRLOCK_DOOR_OPEN_TRAVEL),
  ],
};

/** This family's rig defs. */
export const rigs: readonly RigDef[] = [LOCK_BEACON_DEF, GATE_DOORS_DEF, AIRLOCK_DOORS_DEF];

/** Structure kind id -> rig id, for this family's kinds. */
export const rigOfKind: RigKindMap = {
  territory_lock: 'lock-beacon', shield_gate: 'gate-doors', shield_airlock: 'airlock-doors',
};
