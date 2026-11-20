/**
 * Solid gate door motion (plan door-power, slice 2). Pure and integer-exact:
 * the server, the physics worker and client prediction all read a door's
 * position from the same segment through `doorPosAt`, so there is one door
 * clock, not three.
 *
 * A segment is "from position p0 at tick t0, moving in dir at power level".
 * Position is an integer 0 (shut) .. DOOR_POS_MAX (open); a door at level L
 * moves L units per tick, so full power (15) crosses the whole travel in
 * DOOR_TRAVEL_TICKS and level 0 holds the door still wherever it is.
 */
import { DOOR_POS_MAX, DOOR_POWER_LEVELS, DOOR_RESEGMENT_MIN_MS } from './gateGeometry.js';

/** +1 opens, -1 shuts. */
export type DoorDir = 1 | -1;

export interface DoorSegment {
  /** Position at t0, integer 0..DOOR_POS_MAX. */
  readonly p0: number;
  /** Game tick the segment starts. */
  readonly t0: number;
  readonly dir: DoorDir;
  /** Power level, integer 0..DOOR_POWER_LEVELS. */
  readonly level: number;
}

function clampPos(p: number): number {
  return p < 0 ? 0 : p > DOOR_POS_MAX ? DOOR_POS_MAX : p;
}

/** Door position at `tick` (integer; ticks before t0 read as p0). */
export function doorPosAt(seg: DoorSegment, tick: number): number {
  const dt = tick > seg.t0 ? tick - seg.t0 : 0;
  return clampPos(seg.p0 + seg.dir * seg.level * dt);
}

/** True once the door has reached the end it is moving toward. */
export function doorArrived(seg: DoorSegment, tick: number): boolean {
  return doorPosAt(seg, tick) === (seg.dir > 0 ? DOOR_POS_MAX : 0);
}

/** Power level from the grid's supply fraction: round(clamp01(frac) * 15).
 *  NaN reads as no power. */
export function doorLevelFromSupply(frac: number): number {
  const f = frac > 0 ? (frac < 1 ? frac : 1) : 0;
  return Math.round(f * DOOR_POWER_LEVELS);
}

/** Rig clip time (clip ticks) for a door position. A segment scrubs its rig
 *  with from = doorClipTime(p0), rate = dir * level / DOOR_POWER_LEVELS. */
export function doorClipTime(pos: number): number {
  return pos / DOOR_POWER_LEVELS;
}

/** A door's live motion: its current segment (mutated in place, never
 *  reallocated, so the structure tick stays allocation-free) and when it last
 *  re-segmented. The segment is the door's ONLY clock: position is always
 *  `doorPosAt(track.seg, tick)`, never integrated separately. */
export interface DoorTrack {
  readonly seg: { p0: number; t0: number; dir: DoorDir; level: number };
  /** Wall time (ms) of the last re-segment, for the level-change throttle. */
  segMs: number;
}

/** A shut, still door. */
export function newDoorTrack(): DoorTrack {
  return { seg: { p0: 0, t0: 0, dir: -1, level: 0 }, segMs: Number.NEGATIVE_INFINITY };
}

/** Steer a door toward `open` at power `level` (0..15). A new target starts a
 *  new segment at once from where the door is now; a level change does so only
 *  while the door is still travelling and at most once per
 *  DOOR_RESEGMENT_MIN_MS. Level 0 freezes the door where it is. Returns true
 *  when the segment changed (later slices post it to the rig and the wire). */
export function driveDoor(d: DoorTrack, open: boolean, level: number, tick: number, nowMs: number): boolean {
  const seg = d.seg;
  const dir: DoorDir = open ? 1 : -1;
  if (dir === seg.dir) {
    if (level === seg.level || doorArrived(seg, tick)) return false;
    if (nowMs - d.segMs < DOOR_RESEGMENT_MIN_MS) return false;
  }
  seg.p0 = doorPosAt(seg, tick);
  seg.t0 = tick;
  seg.dir = dir;
  seg.level = level;
  d.segMs = nowMs;
  return true;
}

/** The door is not yet at the end it is heading for. A door frozen at level 0
 *  mid-travel still counts: it wants power (full draw while moving). */
export function doorMoving(d: DoorTrack, tick: number): boolean {
  return !doorArrived(d.seg, tick);
}

/** The door is all the way open (deck light green only then). */
export function doorFullyOpen(d: DoorTrack, tick: number): boolean {
  return doorPosAt(d.seg, tick) === DOOR_POS_MAX;
}
