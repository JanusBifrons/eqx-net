/**
 * Gate geometry — zone-pure (plan soft-leaping-truffle v2, phase V gates).
 *
 * Two gate kinds, both ONE structure:
 *   - Shield Gate (`shield_gate`, 416×72): two 120-wide towers with a shield span between
 *     them. Ships pass through the gap when the span is open.
 *   - Shield Airlock (`shield_airlock`, 392×260): a chamber. Solid side walls,
 *     a post at each corner, and a shield span across each end (A = local +y,
 *     B = local −y). Ships travel along local y; it opens one end or the other,
 *     never both.
 *
 * Everything here is in the structure's GAME-local frame (y up, before the
 * body's rotation). Server and client both read it, so the colliders, the
 * span walls, the approach zones and the drawing all agree (invariant #15).
 */
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import {
  AIRLOCK_END_Y as AL_END_Y,
  AIRLOCK_OPENING,
  AIRLOCK_POST_D,
  AIRLOCK_POST_W,
  AIRLOCK_POSTS,
  AIRLOCK_POST_X as AL_POST_X,
  AIRLOCK_W,
  GATE_DEPTH,
  GATE_OPENING,
  GATE_POST_W,
  GATE_POSTS,
  GATE_W,
} from '../../shared-types/structureKinds/gatePosts.js';
import { PAD_SPECS, TELEPORTER_KINDS, isPadChamberKind, isTeleporterKind, padPostCenters } from '../../shared-types/teleport.js';
import { padChamberWalls } from './padChamber.js';
import { STRUCTURE_KINDS } from '../../shared-types/structureKinds/lookup.js';
import { structureLocalToWorld } from '../../shared-types/structureKinds/geometry.js';
import { SHIPYARD_SLIP_HALF_W, SHIPYARD_SLIP_X0 } from '../articulation/rigs/heavyIndustry.js';
import { getShipKind, isShipKindId } from '../../shared-types/shipKinds.js';
import { tuningFor } from '../../shared-types/shipScale/lookup.js';

export type GateType = 'gate' | 'airlock';

// Post sizes, widths and post centres live in shared-types (one copy for the
// gate geometry here and the cable sockets).
export { GATE_POST_W, GATE_DEPTH, AIRLOCK_POST_W, AIRLOCK_POST_D } from '../../shared-types/structureKinds/gatePosts.js';
/** Airlock side-wall thickness. */
export const AIRLOCK_WALL = 40;
/** Collider thickness of a thin static gate-wall cuboid (the teleporter iris uses it). */
export const GATE_SPAN_THICKNESS = 22;
/** How far in front of / behind a gate (local y) an admitted ship opens it.
 *  Deep enough that the open state reaches a client before its ship meets the
 *  span: ~300 u covers a fast ship over a 200 ms round trip plus the 100 ms
 *  gate tick. */
export const GATE_APPROACH_DEPTH = 300;
/** A gate closes this long after its approach zone empties. */
export const GATE_CLOSE_HOLD_MS = 1200;
/** An airlock closes the entry end this long after the ship is fully inside. */
export const AIRLOCK_CYCLE_HOLD_MS = 350;

/** Solid gate doors (plan door-power): seconds a door takes to travel fully
 *  open or shut at full power. */
export const DOOR_TRAVEL_S = 3;
/** The same travel in game ticks (fixed 60 Hz step, as the crane rig counts). */
export const DOOR_TRAVEL_TICKS = DOOR_TRAVEL_S * 60;
/** Power levels a moving door runs at: 0 (frozen) .. 15 (full speed). */
export const DOOR_POWER_LEVELS = 15;
/** Door position is an integer 0 (shut) .. DOOR_POS_MAX (open). At level L it
 *  moves L units per tick, so full power crosses it in exactly DOOR_TRAVEL_TICKS. */
export const DOOR_POS_MAX = DOOR_TRAVEL_TICKS * DOOR_POWER_LEVELS;
/** A moving door re-segments for a power-level change at most this often, so a
 *  grid hovering on a level boundary cannot make it stutter. A new target
 *  (open / shut) re-segments at once. */
export const DOOR_RESEGMENT_MIN_MS = 500;

/** The clear gap a ship flies through (between the posts): gate / airlock.
 *  The ship-scale fit table checks every playable hull against these. */
export const GATE_GAP = GATE_OPENING;
export const AIRLOCK_GAP = AIRLOCK_OPENING;

/** A box in the structure's local frame. */
export interface LocalBox {
  readonly cx: number;
  readonly cy: number;
  readonly hw: number;
  readonly hh: number;
}

/** Which gate type a structure kind is (null ⇒ not a gate). */
export function gateTypeOf(kind: string | null | undefined): GateType | null {
  if (kind === 'shield_gate') return 'gate';
  if (kind === 'shield_airlock') return 'airlock';
  return null;
}

/** Shield emitters: kinds whose connections to each other form shield walls. */
export function isShieldEmitterKind(kind: string | null | undefined): boolean {
  return kind === 'shield_pylon' || gateTypeOf(kind) !== null;
}

const GATE_BOXES: readonly LocalBox[] = Object.freeze([
  { cx: -(GATE_W / 2 - GATE_POST_W / 2), cy: 0, hw: GATE_POST_W / 2, hh: GATE_DEPTH / 2 },
  { cx: GATE_W / 2 - GATE_POST_W / 2, cy: 0, hw: GATE_POST_W / 2, hh: GATE_DEPTH / 2 },
]);

const AIRLOCK_BOXES: readonly LocalBox[] = Object.freeze([
  { cx: -AL_POST_X, cy: AL_END_Y, hw: AIRLOCK_POST_W / 2, hh: AIRLOCK_POST_D / 2 },
  { cx: AL_POST_X, cy: AL_END_Y, hw: AIRLOCK_POST_W / 2, hh: AIRLOCK_POST_D / 2 },
  { cx: -AL_POST_X, cy: -AL_END_Y, hw: AIRLOCK_POST_W / 2, hh: AIRLOCK_POST_D / 2 },
  { cx: AL_POST_X, cy: -AL_END_Y, hw: AIRLOCK_POST_W / 2, hh: AIRLOCK_POST_D / 2 },
  // Side walls, flush with the outer edge, between the end posts.
  { cx: -(AIRLOCK_W / 2 - AIRLOCK_WALL / 2), cy: 0, hw: AIRLOCK_WALL / 2, hh: AL_END_Y },
  { cx: AIRLOCK_W / 2 - AIRLOCK_WALL / 2, cy: 0, hw: AIRLOCK_WALL / 2, hh: AL_END_Y },
]);

/** Teleporter pads: the posts (towers) are solid; a chamber
 *  (`isPadChamberKind`, `padChamberWalls`) also has solid walls, all but the
 *  two doorways. The Ancients' gate has no posts (redesign A3): an EMPTY list,
 *  so nothing at it is solid (its body has no collider, `createObstacleBody`)
 *  until its inner ring seals as iris walls (`padIrisSpanLocal`). */
const PAD_BOXES: Readonly<Record<string, readonly LocalBox[]>> = Object.freeze(
  Object.fromEntries(
    TELEPORTER_KINDS.map((k) => {
      const towers = padPostCenters(k).map(([cx, cy]) => ({ cx, cy, hw: PAD_SPECS[k].post / 2, hh: PAD_SPECS[k].post / 2 }));
      return [k, Object.freeze(isPadChamberKind(k) ? [...towers, ...padChamberWalls(k)] : towers)];
    }),
  ),
);

/** Shipyard (loop 3M): the stern headhouse and the two sides are solid; the
 *  slipway down the middle (|y| < SHIPYARD_SLIP_HALF_W, stern end of the slip
 *  to the bow edge) is open, like a teleporter pad, so a finished hull printed
 *  on the keel flies out of the bow mouth (+x) without touching the frame. */
const SHIPYARD_BOXES: readonly LocalBox[] = (() => {
  const { w, h } = STRUCTURE_KINDS.shipyard.footprint;
  const hw = w / 2, hh = h / 2, sideH = (hh - SHIPYARD_SLIP_HALF_W) / 2, sideW = (hw - SHIPYARD_SLIP_X0) / 2;
  return Object.freeze([
    { cx: (-hw + SHIPYARD_SLIP_X0) / 2, cy: 0, hw: (SHIPYARD_SLIP_X0 + hw) / 2, hh },
    { cx: SHIPYARD_SLIP_X0 + sideW, cy: SHIPYARD_SLIP_HALF_W + sideH, hw: sideW, hh: sideH },
    { cx: SHIPYARD_SLIP_X0 + sideW, cy: -(SHIPYARD_SLIP_HALF_W + sideH), hw: sideW, hh: sideH },
  ]);
})();

/** Does a `hullKind` hull, shield bubble and all (#18: its tuning's
 *  `shieldPad`), fit down the Shipyard's open slipway? The sub-caps do; a
 *  capital the yard builds (the Barge) is far wider than the whole frame. */
export function shipyardSlipFits(hullKind: string): boolean {
  return isShipKindId(hullKind) && getShipKind(hullKind).radius + tuningFor(hullKind).shieldPad < SHIPYARD_SLIP_HALF_W;
}

/** The solid collider parts of a gate (its posts and walls), a teleporter
 *  pad (its posts) or the Shipyard (all but its slipway), local frame.
 *  null ⇒ the structure is its footprint box. */
export function gateColliderBoxes(kind: string | null | undefined): readonly LocalBox[] | null {
  const t = gateTypeOf(kind);
  if (t === 'gate') return GATE_BOXES;
  if (t === 'airlock') return AIRLOCK_BOXES;
  if (kind === 'shipyard') return SHIPYARD_BOXES;
  return isTeleporterKind(kind) ? PAD_BOXES[kind]! : null;
}

/** Half-width of the passable gap between the posts. */
export function gateGapHalf(type: GateType): number {
  return type === 'gate' ? GATE_W / 2 - GATE_POST_W : AIRLOCK_W / 2 - AIRLOCK_POST_W;
}

/** Local y of an airlock end span (A at +, B at −). */
export const AIRLOCK_END_Y = AL_END_Y;

/** A world-space point (caller-owned output, alloc-free). */
export interface MutPoint { x: number; y: number }

/** Local → world for a structure at (x, y) rotated by `angle` (radians). */
export function localToWorld(x: number, y: number, angle: number, lx: number, ly: number, out: MutPoint): MutPoint {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  out.x = x + lx * c - ly * s;
  out.y = y + lx * s + ly * c;
  return out;
}

/** World → local for a structure at (x, y) rotated by `angle` (radians). */
export function worldToLocal(x: number, y: number, angle: number, px: number, py: number, out: MutPoint): MutPoint {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const dx = px - x;
  const dy = py - y;
  out.x = dx * c + dy * s;
  out.y = -dx * s + dy * c;
  return out;
}

/**
 * Where a shield wall attaches to this emitter, given the wall's far end at
 * (towardX, towardY): a pylon's centre, or the gate post nearest the far end.
 * Both sides compute fence-to-gate walls with this, so the server collider,
 * the client prediction wall and the drawn span meet at the same post.
 * `mirror` (build mirror): the posts go through `structureLocalToWorld`.
 */
export function emitterAnchor(
  kind: string | null | undefined,
  x: number, y: number, angle: number,
  towardX: number, towardY: number,
  out: MutPoint,
  mirror?: boolean,
): MutPoint {
  const t = gateTypeOf(kind);
  if (t === null) { out.x = x; out.y = y; return out; }
  const posts = t === 'gate' ? GATE_POSTS : AIRLOCK_POSTS;
  let bestX = x, bestY = y, best = Infinity;
  const c = Math.cos(angle), s = Math.sin(angle);
  for (const [lx, ly] of posts) {
    structureLocalToWorld(lx, ly, x, y, c, s, mirror, out);
    const d = (out.x - towardX) * (out.x - towardX) + (out.y - towardY) * (out.y - towardY);
    if (d < best) { best = d; bestX = out.x; bestY = out.y; }
  }
  out.x = bestX;
  out.y = bestY;
  return out;
}

/** A gate turn's cos/sin (`out`, returned): exact 0/±1 at a quarter turn (a
 *  gate's usual turn, `isStructureQuarterTurnOnly`), else the real turn (a
 *  deck fence gate along a 30° seam, base platforms slice 21). Alloc-free. */
export function gateTurnCosSinInto(angle: number, out: { cos: number; sin: number }): { cos: number; sin: number } {
  const qf = angle / (Math.PI / 2), qr = Math.round(qf);
  if (Math.abs(qf - qr) < 1e-6) {
    const q = ((qr % 4) + 4) % 4;
    out.cos = q === 0 ? 1 : q === 2 ? -1 : 0;
    out.sin = q === 1 ? 1 : q === 3 ? -1 : 0;
  } else {
    out.cos = Math.cos(angle);
    out.sin = Math.sin(angle);
  }
  return out;
}

const TURN = { cos: 1, sin: 0 };

/**
 * World-axis collider boxes for a gate at turn `angle`, as flat
 * `[offsetX, offsetY, halfW, halfH, ...]` relative to the structure centre.
 * Weapon hits test these instead of the full footprint box, so a shot through
 * an open gate's gap passes. null ⇒ not a gate. `mirror` flips each box
 * centre's local x first (build mirror, as `structureLocalToWorld`).
 */
export function gateWorldAxisBoxes(kind: string | null | undefined, angle: number, mirror?: boolean): Float32Array | null {
  const boxes = gateColliderBoxes(kind);
  if (!boxes) return null;
  // A quarter turn is exact (byte-identical); a deck fence gate turned along
  // a 30° seam (`gateTurnCosSinInto`) gets each part's world-axis bound.
  gateTurnCosSinInto(angle, TURN);
  const out = new Float32Array(boxes.length * 4);
  const c = TURN.cos, s = TURN.sin;
  const f = mirror === true ? -1 : 1;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    out[i * 4] = f * b.cx * c - b.cy * s;
    out[i * 4 + 1] = f * b.cx * s + b.cy * c;
    out[i * 4 + 2] = Math.abs(b.hw * c) + Math.abs(b.hh * s);
    out[i * 4 + 3] = Math.abs(b.hw * s) + Math.abs(b.hh * c);
  }
  return out;
}

/** The gate collider parts as polygons (local frame), for the physics body.
 *  `mirror` flips local x (build mirror; the Shipyard's parts are lopsided). */
export function gateColliderPolygons(kind: string | null | undefined, mirror?: boolean): Array<Array<{ x: number; y: number }>> | null {
  const boxes = gateColliderBoxes(kind);
  if (!boxes) return null;
  const f = mirror === true ? -1 : 1;
  return boxes.map((b) => [
    { x: f * b.cx - b.hw, y: b.cy - b.hh },
    { x: f * b.cx + b.hw, y: b.cy - b.hh },
    { x: f * b.cx + b.hw, y: b.cy + b.hh },
    { x: f * b.cx - b.hw, y: b.cy + b.hh },
  ]);
}

/** Type-only guard so callers can pass a catalogue id. */
export function isGateKind(kind: StructureKindId | string | null | undefined): boolean {
  return gateTypeOf(kind) !== null;
}
