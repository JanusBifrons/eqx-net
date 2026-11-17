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
import { FREIGHT_DOCK } from '../../shared-types/structureKinds.js';
import { buildRig, type PartDef, type Rig, type RigDef } from './rig.js';

/** Axis-aligned box outline [x0, x1] × [y0, y1] in a part's frame, CCW. */
function box(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

// ── dock-crane (freight_dock) ────────────────────────────────────────────────
//
// Medium dock (structure-restyle 2c++, Ladder A "M"): the footprint comes from
// the kind catalogue (`FREIGHT_DOCK.footprint`, 1000 × 400, half extents
// 500 × 200), so the server collider, outline, art and this rig all follow
// one size source. The footprint is SOLID (plane layer, collides), so the
// loading pad is OUTSIDE it, beyond the dock's open long edge. Host frame is
// game space, y-up.
//
// Open side = +y. Evidence: style C `dock()` (structureStyleC.ts) draws in
// pixi space (`outlinePx` maps game (x, y) -> (x, -y)); its open-edge hazard
// strip and crane tower sit at pixi y < 0 (game +y), the dock house fills
// the rest (game -y). The server has no berth side today.
//
// Pad (bay): 900 × 500 (x in ±450, 90 % of the dock width; y in 210..710):
// a 10 u gap past the +y edge (y = 200), then 500 deep. Centre (0, 460).
// A trader-hauler draws ≈ 136 long (extent 68) and ≈ 80 wide: three park
// side by side nose-in with room between (3 × 80 ≪ 900), or one ship up to
// ~850 long broadside.
//
// Deposit relation: `DOCK_DEPOSIT_RANGE` (below) is the freight dock's own
// deposit circle around its CENTRE: the far apron corners (±462, 722) are
// ≈ 857 out, so 900 covers the whole pad. `StorageService.depositRangeOf`
// uses it for docks; other storage keeps `DEPOSIT_RANGE` (400).
//
// Crane: the pivot is the centre of the crane tower on the roof, 60 in from
// the open edge, at its middle: (0, 140). Boom 390 + jib 390: max reach 780;
// the jib may fold right over its boom (limits 0 .. 2π, see the path note at
// CRANE_IK), so there is no minimum reach. The far corners (±450, 710) are
// ≈ 726 from the pivot (54 spare), so the whole pad is in reach. Boom limits
// -2.8 .. 2.4 about the plinth's +π/2 facing. The elbow folds to whichever
// side keeps it out over the pad (swing side +y); for a target just off the
// open edge in front of the tower the boom lies almost flat over the roof
// strip, the jib folded back down to the target.
// Stowed (rest): boom along the roof toward -x (shoulder +π/2, elbow at
// (-390, 140), inside the ±500 width), jib folded back over it (elbow 3.0)
// so the clamp tucks INTO the dock, ≈ 55 below the pivot: every part origin
// sits inside the footprint.
//
// The `lip` under-layer part is the painted landing apron: the pad floor
// (pad + 12 margin on x and at the far end), from the open edge out to
// y = 722. Cosmetic, no collider; the arm parts are over-layer cosmetic.

export const FREIGHT_DOCK_HALF_W = FREIGHT_DOCK.footprint.w / 2;
export const FREIGHT_DOCK_HALF_H = FREIGHT_DOCK.footprint.h / 2;
/** Crane pivot inset from the open edge: the roof tower's centre. */
export const DOCK_CRANE_TOWER_INSET = 60;
export const DOCK_CRANE_PIVOT_X = 0;
export const DOCK_CRANE_PIVOT_Y = FREIGHT_DOCK_HALF_H - DOCK_CRANE_TOWER_INSET;
export const DOCK_CRANE_BOOM = 390;
export const DOCK_CRANE_JIB = 390;
/** The pad comes from the kind catalogue (`FREIGHT_DOCK.keepClear`, the dock's
 *  reserved landing pad, which placement keeps clear of other structures):
 *  ONE definition, so the crane, the bay rule and placement agree. */
const DOCK_PAD = FREIGHT_DOCK.keepClear!;
/** Pad half-extents the crane is sized to reach (450 × 250). */
export const DOCK_BAY_HALF_W = DOCK_PAD.w / 2;
export const DOCK_BAY_HALF_H = DOCK_PAD.h / 2;
/** Bay centre in the dock's host frame (game units, y-up): outside the open edge. */
export const DOCK_BAY_CX = DOCK_PAD.cx;
export const DOCK_BAY_CY = DOCK_PAD.cy;
/** Gap between the dock's open (+y) edge and the bay's near edge (10). */
const DOCK_BAY_GAP = DOCK_BAY_CY - DOCK_BAY_HALF_H - FREIGHT_DOCK_HALF_H;
/** Clip reach / retract time: ~1 s of game time. */
export const DOCK_CRANE_REACH_TICKS = 60;

// ── Bay service rule: "stop = go" (structure-restyle 3a) ─────────────────────
//
// A ship is served when its centre is on the pad and it has come to rest.
// These are pure host-frame helpers; the server (3b) transforms the ship into
// the dock's frame and calls them.

/** Inset from the pad edge a ship's centre must clear to count as parked.
 *  40 = half a trader-hauler's beam (≈ 80 wide): a centre that far in puts
 *  most of the hull on the pad, so a ship nosing the edge or drifting off it
 *  is not served, while the pad still holds three haulers side by side. */
export const DOCK_BAY_INSET = 40;

/** True when host-frame point (lx, ly) is on the landing bay, at least
 *  `DOCK_BAY_INSET` inside its edges. The dock body (y ≤ 200) and the 10 u
 *  gap are never in the bay. A plain box test: the bay is axis-aligned in the
 *  host frame. */
export function inDockBay(lx: number, ly: number): boolean {
  return Math.abs(lx - DOCK_BAY_CX) <= DOCK_BAY_HALF_W - DOCK_BAY_INSET
    && Math.abs(ly - DOCK_BAY_CY) <= DOCK_BAY_HALF_H - DOCK_BAY_INSET;
}

/** Speed (game units / s) below which a ship on the bay counts as stopped.
 *  Ship top speeds run 420 (trader-hauler) .. 950; the helm's own "arrived"
 *  gate is 5 % of top speed (21 .. 48). 25 is met by a ship hovering on the
 *  pad (linear damping 0.45 takes a hauler from full speed to 25 in ≈ 6 s
 *  hands-off, faster on reverse thrust), but a ship crossing the 500-deep pad
 *  at 25 would take 20 s: nothing flying through qualifies. Fixed, the same
 *  for every ship. */
export const DOCK_STILL_SPEED = 25;

/** True when velocity (vx, vy) is below `DOCK_STILL_SPEED` (strict). */
export function isStillForDock(vx: number, vy: number): boolean {
  return vx * vx + vy * vy < DOCK_STILL_SPEED * DOCK_STILL_SPEED;
}

/** Settle before the crane reaches: a ship must sit still on the bay this
 *  long (0.75 s of game time) first, so a ship braking through doesn't. */
export const DOCK_SETTLE_TICKS = 45;

/** Unload hold base: 3 s of game time (60 ticks / s). */
export const DOCK_UNLOAD_HOLD_MIN_TICKS = 3 * 60;
/** Extra hold for a full hold: +7 s (so 3 .. 10 s). */
export const DOCK_UNLOAD_HOLD_LOAD_TICKS = 7 * 60;

/** Ticks the crane holds at the ship before retracting (owner: "slow, scales
 *  with load"): 3 s + 7 s × clamp(load / capacity, 0, 1), rounded to a whole
 *  tick. A non-positive or non-finite capacity, or a non-finite load, counts
 *  as empty (3 s). The full cycle is reach (~1 s) + this + retract (~1 s). */
export function dockUnloadHoldTicks(load: number, capacity: number): number {
  let f = capacity > 0 && Number.isFinite(capacity) ? load / capacity : 0;
  if (!(f > 0)) f = 0; // NaN, negatives
  else if (f > 1) f = 1;
  return Math.round(DOCK_UNLOAD_HOLD_MIN_TICKS + DOCK_UNLOAD_HOLD_LOAD_TICKS * f);
}
const BOOM_REST = Math.PI / 2;
const JIB_FOLD = 3.0;
const APRON_MARGIN = 12;
const APRON_X = DOCK_BAY_HALF_W + APRON_MARGIN;
const APRON_DEPTH = DOCK_BAY_GAP + 2 * DOCK_BAY_HALF_H + APRON_MARGIN;
/** A freight dock's deposit circle (around its centre): covers the whole
 *  landing apron, rounded up to 50 (= 900 at 1000 × 400). */
export const DOCK_DEPOSIT_RANGE = Math.ceil(Math.hypot(DOCK_BAY_CX + APRON_X, FREIGHT_DOCK_HALF_H + APRON_DEPTH) / 50) * 50;

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
  // Plinth: the fixed slewing base on top of the roof crane tower (the
  // style C dock art draws the tower under it), facing out over the pad (+y).
  {
    id: 'plinth', parent: null, anchorX: DOCK_CRANE_PIVOT_X, anchorY: DOCK_CRANE_PIVOT_Y,
    baseAngle: Math.PI / 2, joint: lockedHinge, rest: 0, layer: 'over', kind: 'cosmetic',
    outline: [-24, -24, 24, -24, 30, 0, 24, 24, -24, 24, -30, 0],
  },
  {
    id: 'boom', parent: 'plinth', anchorX: 0, anchorY: 0,
    joint: { type: 'hinge', min: -2.8, max: 2.4 }, rest: BOOM_REST, layer: 'over', kind: 'cosmetic',
    outline: box(-10, -17, DOCK_CRANE_BOOM + 8, 17),
  },
  {
    id: 'jib', parent: 'boom', anchorX: DOCK_CRANE_BOOM, anchorY: 0,
    joint: { type: 'hinge', min: 0, max: 2 * Math.PI }, rest: JIB_FOLD, layer: 'over', kind: 'cosmetic',
    outline: box(-8, -13, DOCK_CRANE_JIB, 13),
  },
  // Clamp head at the jib tip (its origin IS the IK end effector).
  {
    id: 'clamp', parent: 'jib', anchorX: DOCK_CRANE_JIB, anchorY: 0,
    joint: lockedHinge, rest: 0, layer: 'over', kind: 'cosmetic',
    outline: [-6, -18, 15, -18, 21, -9, 12, -9, 12, 9, 21, 9, 15, 18, -6, 18],
  },
];

// Path (structure-restyle 2g). A crane never passes through its own dock:
//  - swing side +y: per target the elbow takes the fold that puts it out over
//    the pad (CCW for targets left of the pivot, CW right of it). A fixed fold
//    sent the boom back across the roof for targets on the other side;
//  - the jib may slew over its boom (limits [0, 2π]), so going from the
//    stowed CCW fold to a CW reach passes the fold (tip over the tower), never
//    straight out (780 long always pokes past the apron or the dock);
//  - a READY waypoint halfway: the boom first swings up from the roof to +y
//    with the jib still folded, then reaches. A straight blend from the stow
//    unfolded the jib while the boom swung, so the jib swept down through the
//    dock house (the far-corner bug). The jib eases 'out' into the reach (and
//    'in' back to ready on retract, the same curve), so it clears the edge
//    before the boom leans over and its tip never swings past the apron.
//  holds the zone property for reach, retract and abort.
const CRANE_IK = {
  chain: ['boom', 'jib'], tipX: DOCK_CRANE_JIB, tipY: 0, bend: 1, swingSide: { x: 0, y: 1 },
} as const;
const READY = DOCK_CRANE_REACH_TICKS / 2;
const BOOM_READY = 0;

export const DOCK_CRANE_DEF: RigDef = {
  id: 'dock-crane',
  parts: DOCK_CRANE_PARTS,
  clips: [
    {
      id: 'arm-reach', ik: CRANE_IK,
      tracks: [
        { part: 'boom', keys: [{ tick: READY, value: BOOM_READY }, { tick: DOCK_CRANE_REACH_TICKS, fromTarget: true }] },
        { part: 'jib', keys: [{ tick: READY, value: JIB_FOLD }, { tick: DOCK_CRANE_REACH_TICKS, fromTarget: true, ease: 'out' }] },
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
        { part: 'boom', keys: [{ tick: 0, fromTarget: true }, { tick: READY, value: BOOM_READY }, { tick: DOCK_CRANE_REACH_TICKS, value: BOOM_REST }] },
        { part: 'jib', keys: [{ tick: 0, fromTarget: true }, { tick: READY, value: JIB_FOLD, ease: 'in' }, { tick: DOCK_CRANE_REACH_TICKS, value: JIB_FOLD }] },
      ],
    },
  ],
};

// ── sandbox-door-turret (turret) ─────────────────────────────────────────────
//
// On the 140 × 140 `turret` kind: a pop-up gun in a socket at the centre
// (0, 0) under a two-leaf hatch.
//  - The riser is a LIFT part: it rises out of the plane and never moves in
//    it, so its kinematic collider stays put (only the drawn rise changes).
//    It carries the kind's `barrel` mount (`mountBridge.ts`).
//  - The hatch leaves sit over the socket: closed, they meet at x = 0 and
//    cover the riser's top (the riser outline is 36 × 40, drawn up to
//    `liftScaleUp` ≈ 1.14× risen, so ±20.5 × ±22.8); open, each slides 30
//    out, its meeting edge at |x| = 30, clear of the risen riser.
// The riser is listed first so the leaves draw over it.
// With no clip record the turret idles DEPLOYED (`idleClip`: hatch open, gun
// up): every turret in the game fires today, and a stowed one holds fire
// (`rigDeployed`), so "never clipped" must read as deployed on every side.

export const DOOR_TURRET_LEAF_HALF_W = 12;
export const DOOR_TURRET_LEAF_HALF_H = 24;
export const DOOR_TURRET_LEAF_TRAVEL = 30;
/** Lift height at full rise (progress 1); the unit is only a scale. */
export const DOOR_TURRET_LIFT = 1;
/** The part that carries the turret kind's mount (via `mountBridge.ts`). */
export const DOOR_TURRET_MOUNT = { mountId: 'barrel', partId: 'turret-lift' } as const;

const LEAF_OUTLINE = box(-DOOR_TURRET_LEAF_HALF_W, -DOOR_TURRET_LEAF_HALF_H, DOOR_TURRET_LEAF_HALF_W, DOOR_TURRET_LEAF_HALF_H);

export const SANDBOX_DOOR_TURRET_DEF: RigDef = {
  id: 'sandbox-door-turret',
  idleClip: 'turret-deploy',
  parts: [
    {
      id: 'turret-lift', parent: null, anchorX: 0, anchorY: 0,
      joint: { type: 'lift', min: 0, max: DOOR_TURRET_LIFT },
      rest: 0, layer: 'plane', kind: 'physical',
      outline: [-18, -14, -12, -20, 12, -20, 18, -14, 18, 14, 12, 20, -12, 20, -18, 14],
    },
    {
      id: 'door-left', parent: null, anchorX: -DOOR_TURRET_LEAF_HALF_W, anchorY: 0,
      joint: { type: 'slide', axisX: -1, axisY: 0, min: 0, max: DOOR_TURRET_LEAF_TRAVEL },
      rest: 0, layer: 'plane', kind: 'physical', outline: LEAF_OUTLINE,
    },
    {
      id: 'door-right', parent: null, anchorX: DOOR_TURRET_LEAF_HALF_W, anchorY: 0,
      joint: { type: 'slide', axisX: 1, axisY: 0, min: 0, max: DOOR_TURRET_LEAF_TRAVEL },
      rest: 0, layer: 'plane', kind: 'physical', outline: LEAF_OUTLINE,
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
        { part: 'turret-lift', keys: [{ tick: 15, value: 0 }, { tick: 60, value: DOOR_TURRET_LIFT }] },
      ],
    },
    {
      // The turret sinks, then the hatch closes over it.
      id: 'turret-retract',
      tracks: [
        { part: 'turret-lift', keys: [{ tick: 0, value: DOOR_TURRET_LIFT }, { tick: 45, value: 0 }] },
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
