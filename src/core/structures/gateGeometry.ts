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
import { PAD_SPECS, TELEPORTER_KINDS, isTeleporterKind, padPostCenters } from '../../shared-types/teleport.js';

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

/** Teleporter pads (v4 T1): only the posts are solid; the pad is open. */
const PAD_BOXES: Readonly<Record<string, readonly LocalBox[]>> = Object.freeze(
  Object.fromEntries(
    TELEPORTER_KINDS.map((k) => [
      k,
      Object.freeze(padPostCenters(k).map(([cx, cy]) => ({ cx, cy, hw: PAD_SPECS[k].post / 2, hh: PAD_SPECS[k].post / 2 }))),
    ]),
  ),
);

/** The solid collider parts of a gate (its posts and walls) or a teleporter
 *  pad (its posts), local frame. null ⇒ the structure is its footprint box. */
export function gateColliderBoxes(kind: string | null | undefined): readonly LocalBox[] | null {
  const t = gateTypeOf(kind);
  if (t === 'gate') return GATE_BOXES;
  if (t === 'airlock') return AIRLOCK_BOXES;
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
 */
export function emitterAnchor(
  kind: string | null | undefined,
  x: number, y: number, angle: number,
  towardX: number, towardY: number,
  out: MutPoint,
): MutPoint {
  const t = gateTypeOf(kind);
  if (t === null) { out.x = x; out.y = y; return out; }
  const posts = t === 'gate' ? GATE_POSTS : AIRLOCK_POSTS;
  let bestX = x, bestY = y, best = Infinity;
  for (const [lx, ly] of posts) {
    localToWorld(x, y, angle, lx, ly, out);
    const d = (out.x - towardX) * (out.x - towardX) + (out.y - towardY) * (out.y - towardY);
    if (d < best) { best = d; bestX = out.x; bestY = out.y; }
  }
  out.x = bestX;
  out.y = bestY;
  return out;
}

/**
 * World-axis collider boxes for a gate rotated by a quarter turn, as flat
 * `[offsetX, offsetY, halfW, halfH, ...]` relative to the structure centre.
 * Weapon hits test these instead of the full footprint box, so a shot through
 * an open gate's gap passes. null ⇒ not a gate.
 */
export function gateWorldAxisBoxes(kind: string | null | undefined, angle: number): Float32Array | null {
  const boxes = gateColliderBoxes(kind);
  if (!boxes) return null;
  const q = (((Math.round(angle / (Math.PI / 2)) % 4) + 4) % 4);
  const out = new Float32Array(boxes.length * 4);
  const c = q === 0 ? 1 : q === 2 ? -1 : 0;
  const s = q === 1 ? 1 : q === 3 ? -1 : 0;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    out[i * 4] = b.cx * c - b.cy * s;
    out[i * 4 + 1] = b.cx * s + b.cy * c;
    out[i * 4 + 2] = q % 2 === 0 ? b.hw : b.hh;
    out[i * 4 + 3] = q % 2 === 0 ? b.hh : b.hw;
  }
  return out;
}

/** The gate collider parts as polygons (local frame), for the physics body. */
export function gateColliderPolygons(kind: string | null | undefined): Array<Array<{ x: number; y: number }>> | null {
  const boxes = gateColliderBoxes(kind);
  if (!boxes) return null;
  return boxes.map((b) => [
    { x: b.cx - b.hw, y: b.cy - b.hh },
    { x: b.cx + b.hw, y: b.cy - b.hh },
    { x: b.cx + b.hw, y: b.cy + b.hh },
    { x: b.cx - b.hw, y: b.cy + b.hh },
  ]);
}

/** Type-only guard so callers can pass a catalogue id. */
export function isGateKind(kind: StructureKindId | string | null | undefined): boolean {
  return gateTypeOf(kind) !== null;
}
