/**
 * Real rig definitions (structure-restyle 2b+, plan §3 layers, §5 clips).
 *
 * Rigs are keyed by rig id; `rigForStructureKind` maps a structure kind id to
 * its rig. The structure kind catalogue is append-only wire format, so the
 * mapping lives HERE by kind id string, never as a field on the kind.
 *
 * Each rig is built once, lazily, and cached: lookups allocate nothing after
 * the first call.
 *
 * Frames: host frame = the structure's local frame (origin at its centre,
 * +x along its footprint width, +y along its height), as `structureOutline`
 * uses. Angles: `a` -> `(cos a, sin a)` (same as `ik.ts`).
 */
import { buildRig, type PartDef, type Rig, type RigDef } from './rig.js';

/** Axis-aligned box outline [x0, x1] × [y0, y1] in a part's frame, CCW. */
function box(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

// ── dock-crane (freight_dock) ────────────────────────────────────────────────
//
// freight_dock footprint: 520 × 240 (half extents 260 × 120). The footprint is
// SOLID (plane layer, collides), so the parking bay is OUTSIDE it, beyond the
// dock's open long edge. Host frame is game space, y-up.
//
// Open side = +y. Evidence: style C `dock()` (structureStyleC.ts) draws in
// pixi space (`outlinePx` maps game (x, y) -> (x, -y)); its hazard apron,
// chevrons and bay-mouth truss sit at pixi y < 0 (-hh .. lipY), i.e. game
// +y, and the dock house fills the rest (game -y). Styles A/B say the same
// ("floor strips on the -y side", pixi). The server has no berth side today.
//
// Bay: x in ±208 (±40 % of the dock width, DOCK_BAY_HALF_W), y in 130..290:
// a 10 u gap past the +y edge (y = 120), then 160 deep. Centre
// (DOCK_BAY_CX, DOCK_BAY_CY) = (0, 210), half extents 208 × 80. Sized for a
// hauler (trader-hauler extent 68, i.e. 136 long: fits nose-in or broadside)
// and ships up to ~300 long parked broadside (416 wide).
//
// Deposit relation: `StorageService.DEPOSIT_RANGE` = 400 is a circle around
// the dock CENTRE (any side). The bay's farthest corners (±208, 290) are
// ≈ 357 from the centre, so the whole bay lies inside today's deposit range,
// and parking in the bay already triggers the 2 s dwell
// (`DEPOSIT_DWELL_TICKS`). Stage 3 retargets the dwell to this bay zone.
//
// Crane: pivot on the plinth 24 in from the open edge, at its middle:
// (0, 96). Boom 165 + jib 165: max reach 330; min reach (jib folded to its
// 3.0 rad limit) = 330·sin(0.07) ≈ 23. From the pivot the nearest bay point
// (0, 130) is 34 away (11 spare) and the far corners (±208, 290) ≈ 284
// (46 spare), so the whole bay is inside the reach annulus. Boom limits
// -2.8 .. 2.4 about the plinth's +π/2 facing: the elbow only bends CCW, so
// near-edge targets put the boom up to ≈ 53° below the edge line (relative
// ≈ -2.5); it can never swing straight back into the dock (-π/2).
// Stowed (rest): boom along the edge toward -x (shoulder +π/2), jib folded
// back over it (elbow 3.0) so the clamp tucks INTO the dock, ≈ 23 below the
// pivot: every part origin sits inside the footprint.
//
// The `lip` under-layer part is the painted landing apron: the bay floor
// (bay + 12 margin on x and at the far end), from the open edge out to
// y = 302. Cosmetic, no collider; the arm parts are over-layer cosmetic.

export const FREIGHT_DOCK_HALF_W = 260;
export const FREIGHT_DOCK_HALF_H = 120;
export const DOCK_CRANE_PIVOT_X = 0;
export const DOCK_CRANE_PIVOT_Y = FREIGHT_DOCK_HALF_H - 24;
export const DOCK_CRANE_BOOM = 165;
export const DOCK_CRANE_JIB = 165;
/** Bay half-extents the crane is sized to reach (±40 % of the dock width × 80). */
export const DOCK_BAY_HALF_W = 0.4 * 2 * FREIGHT_DOCK_HALF_W;
export const DOCK_BAY_HALF_H = 80;
/** Gap between the dock's open (+y) edge and the bay's near edge. */
const DOCK_BAY_GAP = 10;
/** Bay centre in the dock's host frame (game units, y-up): outside the open edge. */
export const DOCK_BAY_CX = 0;
export const DOCK_BAY_CY = FREIGHT_DOCK_HALF_H + DOCK_BAY_GAP + DOCK_BAY_HALF_H;
/** Clip reach / retract time: ~1 s of game time. */
export const DOCK_CRANE_REACH_TICKS = 60;
const BOOM_REST = Math.PI / 2;
const JIB_FOLD = 3.0;
const APRON_MARGIN = 12;

const lockedHinge = { type: 'hinge', min: 0, max: 0 } as const;

const DOCK_CRANE_PARTS: readonly PartDef[] = [
  // Under band: the painted landing apron over the bay floor, from the open
  // (+y) edge outward (no collider, no motion).
  {
    id: 'lip', parent: null, anchorX: 0, anchorY: FREIGHT_DOCK_HALF_H,
    joint: lockedHinge, rest: 0, layer: 'under', kind: 'cosmetic',
    outline: box(
      DOCK_BAY_CX - DOCK_BAY_HALF_W - APRON_MARGIN, 0,
      DOCK_BAY_CX + DOCK_BAY_HALF_W + APRON_MARGIN, DOCK_BAY_GAP + 2 * DOCK_BAY_HALF_H + APRON_MARGIN,
    ),
  },
  // Plinth: the fixed slewing base near the open edge, facing out over the bay (+y).
  {
    id: 'plinth', parent: null, anchorX: DOCK_CRANE_PIVOT_X, anchorY: DOCK_CRANE_PIVOT_Y,
    baseAngle: Math.PI / 2, joint: lockedHinge, rest: 0, layer: 'over', kind: 'cosmetic',
    outline: [-14, -14, 14, -14, 18, 0, 14, 14, -14, 14, -18, 0],
  },
  {
    id: 'boom', parent: 'plinth', anchorX: 0, anchorY: 0,
    joint: { type: 'hinge', min: -2.8, max: 2.4 }, rest: BOOM_REST, layer: 'over', kind: 'cosmetic',
    outline: box(-8, -7, DOCK_CRANE_BOOM + 6, 7),
  },
  {
    id: 'jib', parent: 'boom', anchorX: DOCK_CRANE_BOOM, anchorY: 0,
    joint: { type: 'hinge', min: 0, max: JIB_FOLD }, rest: JIB_FOLD, layer: 'over', kind: 'cosmetic',
    outline: box(-6, -5, DOCK_CRANE_JIB, 5),
  },
  // Clamp head at the jib tip (its origin IS the IK end effector).
  {
    id: 'clamp', parent: 'jib', anchorX: DOCK_CRANE_JIB, anchorY: 0,
    joint: lockedHinge, rest: 0, layer: 'over', kind: 'cosmetic',
    outline: [-4, -12, 10, -12, 14, -6, 8, -6, 8, 6, 14, 6, 10, 12, -4, 12],
  },
];

const CRANE_IK = { chain: ['boom', 'jib'], tipX: DOCK_CRANE_JIB, tipY: 0, bend: 1 } as const;

export const DOCK_CRANE_DEF: RigDef = {
  id: 'dock-crane',
  parts: DOCK_CRANE_PARTS,
  clips: [
    {
      id: 'arm-reach', ik: CRANE_IK,
      tracks: [
        { part: 'boom', keys: [{ tick: DOCK_CRANE_REACH_TICKS, fromTarget: true }] },
        { part: 'jib', keys: [{ tick: DOCK_CRANE_REACH_TICKS, fromTarget: true }] },
      ],
    },
    {
      id: 'arm-hold', ik: CRANE_IK,
      tracks: [
        { part: 'boom', keys: [{ tick: 0, fromTarget: true }] },
        { part: 'jib', keys: [{ tick: 0, fromTarget: true }] },
      ],
    },
    {
      id: 'arm-retract', ik: CRANE_IK,
      tracks: [
        { part: 'boom', keys: [{ tick: 0, fromTarget: true }, { tick: DOCK_CRANE_REACH_TICKS, value: BOOM_REST }] },
        { part: 'jib', keys: [{ tick: 0, fromTarget: true }, { tick: DOCK_CRANE_REACH_TICKS, value: JIB_FOLD }] },
      ],
    },
  ],
};

// ── sandbox-door-turret (turret) ─────────────────────────────────────────────
//
// On the 140 × 140 `turret` kind: a hatch in the +y face whose two leaves
// slide apart (30 each), and a pop-up slide that carries the kind's `barrel`
// mount out through it (60 along +y). Both plane layer, physical.

export const DOOR_TURRET_LEAF_TRAVEL = 30;
export const DOOR_TURRET_SLIDE_TRAVEL = 60;
/** The part that carries the turret kind's mount (via `mountBridge.ts`). */
export const DOOR_TURRET_MOUNT = { mountId: 'barrel', partId: 'turret-slide' } as const;

export const SANDBOX_DOOR_TURRET_DEF: RigDef = {
  id: 'sandbox-door-turret',
  parts: [
    {
      id: 'door-left', parent: null, anchorX: -15, anchorY: 62,
      joint: { type: 'slide', axisX: -1, axisY: 0, min: 0, max: DOOR_TURRET_LEAF_TRAVEL },
      rest: 0, layer: 'plane', kind: 'physical', outline: box(-15, -6, 15, 6),
    },
    {
      id: 'door-right', parent: null, anchorX: 15, anchorY: 62,
      joint: { type: 'slide', axisX: 1, axisY: 0, min: 0, max: DOOR_TURRET_LEAF_TRAVEL },
      rest: 0, layer: 'plane', kind: 'physical', outline: box(-15, -6, 15, 6),
    },
    {
      id: 'turret-slide', parent: null, anchorX: 0, anchorY: 0,
      joint: { type: 'slide', axisX: 0, axisY: 1, min: 0, max: DOOR_TURRET_SLIDE_TRAVEL },
      rest: 0, layer: 'plane', kind: 'physical',
      outline: [-18, -14, -12, -20, 12, -20, 18, -14, 18, 14, 12, 20, -12, 20, -18, 14],
    },
  ],
  clips: [
    {
      id: 'door-open',
      tracks: [
        { part: 'door-left', keys: [{ tick: 20, value: DOOR_TURRET_LEAF_TRAVEL, ease: 'out' }] },
        { part: 'door-right', keys: [{ tick: 20, value: DOOR_TURRET_LEAF_TRAVEL, ease: 'out' }] },
      ],
    },
    {
      id: 'door-close',
      tracks: [
        { part: 'door-left', keys: [{ tick: 0, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 20, value: 0 }] },
        { part: 'door-right', keys: [{ tick: 0, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 20, value: 0 }] },
      ],
    },
    {
      // Self-contained: opens the hatch first, then the turret rises through it.
      id: 'turret-deploy',
      tracks: [
        { part: 'door-left', keys: [{ tick: 20, value: DOOR_TURRET_LEAF_TRAVEL, ease: 'out' }] },
        { part: 'door-right', keys: [{ tick: 20, value: DOOR_TURRET_LEAF_TRAVEL, ease: 'out' }] },
        { part: 'turret-slide', keys: [{ tick: 15, value: 0 }, { tick: 60, value: DOOR_TURRET_SLIDE_TRAVEL }] },
      ],
    },
    {
      // The turret sinks, then the hatch closes over it.
      id: 'turret-retract',
      tracks: [
        { part: 'turret-slide', keys: [{ tick: 0, value: DOOR_TURRET_SLIDE_TRAVEL }, { tick: 45, value: 0 }] },
        { part: 'door-left', keys: [{ tick: 0, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 45, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 65, value: 0 }] },
        { part: 'door-right', keys: [{ tick: 0, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 45, value: DOOR_TURRET_LEAF_TRAVEL }, { tick: 65, value: 0 }] },
      ],
    },
  ],
};

// ── Catalogue ────────────────────────────────────────────────────────────────

export const RIG_DEFS: readonly RigDef[] = [DOCK_CRANE_DEF, SANDBOX_DOOR_TURRET_DEF];

/** Structure kind id -> rig id. Kind ids are strings from `structureKinds.ts`. */
const RIG_ID_OF_KIND: Readonly<Record<string, string>> = {
  freight_dock: 'dock-crane',
  turret: 'sandbox-door-turret',
};

const built = new Map<string, Rig>();

/** The built rig for `rigId`, or null. Built on first use, then cached. */
export function rigById(rigId: string): Rig | null {
  const hit = built.get(rigId);
  if (hit !== undefined) return hit;
  for (let i = 0; i < RIG_DEFS.length; i++) {
    const def = RIG_DEFS[i]!;
    if (def.id === rigId) {
      const rig = buildRig(def);
      built.set(rigId, rig);
      return rig;
    }
  }
  return null;
}

/** The rig a structure kind carries, or null when it has none. */
export function rigForStructureKind(kindId: string): Rig | null {
  const rigId = Object.prototype.hasOwnProperty.call(RIG_ID_OF_KIND, kindId) ? RIG_ID_OF_KIND[kindId] : undefined;
  return rigId === undefined ? null : rigById(rigId);
}
