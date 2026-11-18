/**
 * Fire-lane awareness (AI overhaul slice 5b, plan composed-harbor §4 + §2).
 * Every shot hits the first thing in its path, allies included, and the room's
 * LineOfFireGate holds an NPC's shot while a friendly body is on its line
 * (slice 2). Holding fire is safe but wastes the gun. This file is the
 * movement half (owner, 2026-11-13: NPCs "trying not to shoot each other"):
 *
 *  1. Blocked-fire nudge: a ship the gate keeps holding side-steps off the
 *     line, to the side AWAY from the ally in the way (`blockedNudgeSide`),
 *     for `NUDGE_TICKS`, toward a point one `combatSeparation` aside. The
 *     shot is held anyway, so a short turn of the nose costs no fire; the
 *     nose stays within `NUDGE_MAX_OFF` of the lead so it comes straight back.
 *  2. Ally fire lanes: each brain writes its current aim point into the
 *     controller's {@link AimBoard}; a ship near same-side wingmen adds context
 *     DANGER along each wingman → aim-point lane (`addAllyLaneDanger`), so it
 *     does not fly across a wingman's line of fire.
 *
 * NPC-only: players are never gated and never steered (owner rule). Every
 * brain flies only with player controls through the virtual pilot; this only
 * changes what it WANTS. Zone-pure, deterministic, allocation-free in steady
 * state (#14): board slots are assigned at register, never per tick.
 */
import type { AiEntity, IAiAimBoard, IAiNeighbourQuery } from '../../contracts/IAiBehaviour.js';
import type { AllegianceSide } from '../../../shared-types/allegiances.js';
import { addDangerFromSegment, addInterestToward, type ContextMaps } from '../contextSteering.js';
import { COMBAT_NEIGHBOUR_K, NUDGE_ARRIVED, NUDGE_SHAPE } from '../hostileDroneTuning.js';
import {
  MANOEUVRE_ATTACK_RUN,
  MANOEUVRE_HOLD,
  MANOEUVRE_KITE,
  MANOEUVRE_ORBIT,
  MANOEUVRE_TAIL,
  type ManoeuvreId,
} from './manoeuvre.js';

/** A block counts as live for this many ticks (0.5 s): the nudge runs while
 *  the last block is this recent. */
export const NUDGE_TICKS = 30;
/** Decayed recent-block count (`HostileDroneBehaviour.getRecentBlocks`) that
 *  starts a nudge: one fresh block is 1. */
export const NUDGE_MIN_BLOCKS = 0.9;
/** Nudge interest weight (beats the manoeuvre's own lobe, weight 1). */
export const NUDGE_WEIGHT = 1.5;
/** The nose may swing at most this far off the lead bearing while nudging (rad, 55°). */
export const NUDGE_MAX_OFF = (55 * Math.PI) / 180;
/** Lateral speed of the side-step, × cruise. */
export const NUDGE_SPEED_FRAC = 0.7;
/** Decayed block count that biases the picker toward a fresh attack run (a
 *  new angle): persistent blocking, not one stray. */
export const PERSISTENT_BLOCKS = 2.5;
/** Attack-run score bonus per persistent block above the threshold (capped). */
export const BLOCK_RUN_BIAS = 0.3;
export const BLOCK_RUN_BIAS_MAX = 0.9;

/** Attack-run score bonus for a decayed block count (0 below
 *  `PERSISTENT_BLOCKS`; 0 while the feature is off). */
export function persistentBlockBias(recentBlocks: number): number {
  if (!fireLaneAvoidance || recentBlocks < PERSISTENT_BLOCKS) return 0;
  const b = BLOCK_RUN_BIAS * (1 + recentBlocks - PERSISTENT_BLOCKS);
  return b > BLOCK_RUN_BIAS_MAX ? BLOCK_RUN_BIAS_MAX : b;
}

/** Wingmen whose lanes a ship reads (nearest same-side first). */
export const ALLY_LANE_K = 4;
/** Lane half-width = this × the ship's own radius + the ally's radius: the
 *  bolt is thin; it is a hull that blocks it. */
export const ALLY_LANE_RADIUS_MUL = 1.5;
/** Look ahead this long (s) at the larger of cruise and own speed for a lane crossing. */
export const ALLY_LANE_LOOKAHEAD_S = 1;
/** Lane danger weight (separation danger is 1). */
export const ALLY_LANE_WEIGHT = 0.8;
/** The lane stops this share of the way to the aim point: every lane meets
 *  at the shared target, and the last stretch is where the pack fights. */
export const ALLY_LANE_END_FRAC = 0.8;
/** An aim older than this many ticks is ignored (the wingman stopped aiming). */
export const AIM_STALE_TICKS = 3;

/** Test seam (integration A/B): false turns both halves off. */
let fireLaneAvoidance = true;
export function setFireLaneAvoidance(on: boolean): void { fireLaneAvoidance = on; }
export function fireLaneAvoidanceOn(): boolean { return fireLaneAvoidance; }

/**
 * Side of the shooter → target line to step to: +1 = the left-hand normal
 * (-uy, ux), −1 = the right. Always AWAY from the blocker; a blocker dead on
 * the line falls back to the side the ship is already drifting (no reversal),
 * else the left.
 */
export function blockedNudgeSide(
  selfX: number, selfY: number, ux: number, uy: number,
  blockerX: number, blockerY: number, vx: number, vy: number,
): 1 | -1 {
  const nx = -uy;
  const ny = ux;
  const b = (blockerX - selfX) * nx + (blockerY - selfY) * ny;
  if (b > 1e-3) return -1;
  if (b < -1e-3) return 1;
  return vx * nx + vy * ny < 0 ? -1 : 1;
}

/**
 * Per-entity "current aim point" board, owned by the AI controller: a brain
 * writes its aim each combat tick, a wingman reads it by id. Slots are
 * assigned at register and recycled at unregister; the typed arrays double
 * past the high-water mark. Reads and writes are a Map lookup, no allocation.
 */
export class AimBoard implements IAiAimBoard {
  private readonly slotOf = new Map<string, number>();
  private readonly free: number[] = [];
  private next = 0;
  private x = new Float32Array(64);
  private y = new Float32Array(64);
  private at = new Int32Array(64).fill(-1_000_000);
  /** Last read's aim (scratch for {@link read}). */
  readX = 0;
  readY = 0;

  add(id: string): void {
    if (this.slotOf.has(id)) return;
    const s = this.free.length > 0 ? this.free.pop()! : this.next++;
    if (s >= this.x.length) this.grow();
    this.at[s] = -1_000_000;
    this.slotOf.set(id, s);
  }

  remove(id: string): void {
    const s = this.slotOf.get(id);
    if (s === undefined) return;
    this.slotOf.delete(id);
    this.at[s] = -1_000_000;
    this.free.push(s);
  }

  clear(): void {
    this.slotOf.clear();
    this.free.length = 0;
    this.next = 0;
    this.at.fill(-1_000_000);
  }

  write(id: string, x: number, y: number, tick: number): void {
    const s = this.slotOf.get(id);
    if (s === undefined) return;
    this.x[s] = x;
    this.y[s] = y;
    this.at[s] = tick;
  }

  /** True (aim in `readX/readY`) when `id` aimed within `AIM_STALE_TICKS` of `tick`. */
  read(id: string, tick: number): boolean {
    const s = this.slotOf.get(id);
    if (s === undefined || tick - this.at[s]! > AIM_STALE_TICKS) return false;
    this.readX = this.x[s]!;
    this.readY = this.y[s]!;
    return true;
  }

  private grow(): void {
    const n = this.x.length * 2;
    const x = new Float32Array(n); x.set(this.x); this.x = x;
    const y = new Float32Array(n); y.set(this.y); this.y = y;
    const at = new Int32Array(n).fill(-1_000_000); at.set(this.at); this.at = at;
  }
}

/** True when (selfX, selfY) sits inside the lane `addAllyLaneDanger` writes
 *  for the same arguments (within `laneHalfWidth` of the cut segment). */
export function insideAllyLane(
  selfX: number, selfY: number,
  ax: number, ay: number, aimX: number, aimY: number,
  laneHalfWidth: number,
): boolean {
  const dx = (aimX - ax) * ALLY_LANE_END_FRAC;
  const dy = (aimY - ay) * ALLY_LANE_END_FRAC;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return false;
  const rx = selfX - ax;
  const ry = selfY - ay;
  const along = (rx * dx + ry * dy) / len;
  if (along < 0 || along > len) return false;
  const h = (rx * dy - ry * dx) / len;
  return h < laneHalfWidth && h > -laneHalfWidth;
}

/**
 * Danger along one wingman's fire lane: from the wingman at (ax, ay) toward
 * its aim point (aimX, aimY), cut at `ALLY_LANE_END_FRAC`. Headings that cross
 * it within `lookahead` score up to `weight`; inside it, the straight exit is
 * best (see `addDangerFromSegment`).
 */
export function addAllyLaneDanger(
  m: ContextMaps,
  selfX: number, selfY: number,
  ax: number, ay: number, aimX: number, aimY: number,
  laneHalfWidth: number, lookahead: number, weight: number,
): void {
  const bx = ax + (aimX - ax) * ALLY_LANE_END_FRAC;
  const by = ay + (aimY - ay) * ALLY_LANE_END_FRAC;
  addDangerFromSegment(m, selfX, selfY, ax, ay, bx, by, laneHalfWidth, lookahead, weight);
}

/** Line-of-fire feedback: the recent-block count halves every this many game
 *  ticks (0.5 s at 60 Hz). */
export const BLOCK_HALF_LIFE_TICKS = 30;

/**
 * One brain's fire-lane state, owned by `HostileDroneBehaviour` and built
 * once: the line-of-fire feedback (friendly fire; plan composed-harbor §4),
 * the blocked-fire nudge and the ally-lane danger. The room's LineOfFireGate
 * held this NPC's shot because a friendly body was on the line. Plain fields
 * only (#14); game ticks, never wall time (#20).
 */
export class FireLaneSteer {
  private _blockScore = 0;
  private _blockScoreTick = 0;
  private _lastBlockedTick = -1_000_000;
  private _blockerX = 0;
  private _blockerY = 0;
  /** Blocked-fire nudge (slice 5b): the block it was planned for and its
   *  reposition point. */
  private _nudgeFromTick = -1_000_000;
  private _nudgeGoalX = 0;
  private _nudgeGoalY = 0;
  private _nudgeCount = 0;
  private _laneExitCount = 0;

  /** At most one count per tick (a capital's barrels may each report). */
  noteBlocked(tick: number, blockerX: number, blockerY: number): void {
    this._blockerX = blockerX;
    this._blockerY = blockerY;
    if (tick === this._lastBlockedTick) return;
    this._blockScore = this.getRecentBlocks(tick) + 1;
    this._blockScoreTick = tick;
    this._lastBlockedTick = tick;
  }

  /** Decaying count of recent blocks: halves every `BLOCK_HALF_LIFE_TICKS`. */
  getRecentBlocks(tick: number): number {
    if (this._blockScore === 0) return 0;
    const age = tick - this._blockScoreTick;
    if (age <= 0) return this._blockScore;
    return this._blockScore * Math.pow(0.5, age / BLOCK_HALF_LIFE_TICKS);
  }

  /** Tick of the latest block (-1_000_000 when never blocked). */
  get lastBlockedTick(): number { return this._lastBlockedTick; }
  /** World position of the latest blocking ally. */
  get blockerX(): number { return this._blockerX; }
  get blockerY(): number { return this._blockerY; }
  /** Combat ticks spent side-stepping a blocked line. */
  get nudgeTicks(): number { return this._nudgeCount; }
  /** Combat ticks spent inside a wingman's fire lane. */
  get laneExitTicks(): number { return this._laneExitCount; }

  /**
   * Ally fire lanes (slice 5b): for up to `ALLY_LANE_K` same-side AI-flown
   * wingmen within fire range that aimed this tick or the last few, danger
   * along wingman → its aim point (lane half-width = own radius ×
   * `ALLY_LANE_RADIUS_MUL` + the wingman's radius; look-ahead 1 s at
   * max(cruise, own speed)). Same side = `sideAt === allegiance`, pilot slot
   * or not: a player-owned AI-flown hull sits in a pilot slot on the players
   * side (RTS Part B), and its squadmates keep out of its lane. AI-flown =
   * an aim on the board: a human pilot posts none, so no lane is ever made
   * from a human's nose. Returns true when this ship sits INSIDE a lane (it
   * must get out: the caller lets the nose swing toward the exit). Alloc-free
   * (reuses the brain's neighbour index scratch `idx`).
   */
  addAllyLanes(
    self: AiEntity, nb: IAiNeighbourQuery, aims: IAiAimBoard, idx: Int32Array, maps: ContextMaps, tick: number,
    fireRange: number, cruiseSpeed: number, ownRadius: number, allegiance: AllegianceSide,
  ): boolean {
    const n = nb.queryNeighbours(self.x, self.y, fireRange, COMBAT_NEIGHBOUR_K, idx, self.id);
    const sp = Math.hypot(self.vx, self.vy);
    const lookahead = ALLY_LANE_LOOKAHEAD_S * (sp > cruiseSpeed ? sp : cruiseSpeed);
    let used = 0;
    let inside = false;
    for (let k = 0; k < n && used < ALLY_LANE_K; k++) {
      const i = idx[k]!;
      if (nb.sideAt(i) !== allegiance) continue;
      // Only an AI-flown ship posts its aim; a human pilot has none.
      if (!aims.read(nb.idAt(i), tick)) continue;
      used++;
      const hw = ALLY_LANE_RADIUS_MUL * ownRadius + nb.radiusAt(i);
      const ax = nb.xAt(i);
      const ay = nb.yAt(i);
      addAllyLaneDanger(maps, self.x, self.y, ax, ay, aims.readX, aims.readY, hw, lookahead, ALLY_LANE_WEIGHT);
      if (!inside && insideAllyLane(self.x, self.y, ax, ay, aims.readX, aims.readY, hw)) inside = true;
    }
    if (inside) this._laneExitCount++;
    return inside;
  }

  /**
   * Blocked-fire nudge (slice 5b): while the line-of-fire gate held a shot in
   * the last `NUDGE_TICKS` (and the decayed count is at least
   * `NUDGE_MIN_BLOCKS`), Hold, Tail and an attack run's dive add interest toward a point one
   * `combatSeparation` aside of the target line, on the side away from the
   * ally in the way (latched per block). Ends early once there. Returns
   * whether it is nudging. A run's pull-off / extend and a break fly their own course.
   * `cur` is the running manoeuvre; `diving` / `kiteRunning` its attack-run
   * and Kite phase.
   */
  writeBlockedNudge(
    self: AiEntity, ux: number, uy: number, maps: ContextMaps, tick: number, combatSeparation: number,
    cur: ManoeuvreId, diving: boolean, kiteRunning: boolean,
  ): boolean {
    // The shooting stances side-step: Hold, Tail, a run's dive, Orbit and a
    // Kite backing off nose on (Orbit / Kite replaced Hold for gunships and
    // missile boats, slice 6b). A run's pull-off / extend, a Break, a running
    // Kite, FallBack and Flee fly their own course.
    if (cur !== MANOEUVRE_HOLD && cur !== MANOEUVRE_TAIL && cur !== MANOEUVRE_ORBIT
      && !(cur === MANOEUVRE_ATTACK_RUN && diving)
      && !(cur === MANOEUVRE_KITE && !kiteRunning)) return false;
    if (tick - this._lastBlockedTick > NUDGE_TICKS || this.getRecentBlocks(tick) < NUDGE_MIN_BLOCKS) return false;
    if (this._nudgeFromTick !== this._lastBlockedTick) {
      // A fresh block: pick the side and the reposition point.
      const side = blockedNudgeSide(self.x, self.y, ux, uy, this._blockerX, this._blockerY, self.vx, self.vy);
      this._nudgeFromTick = this._lastBlockedTick;
      this._nudgeGoalX = self.x - uy * side * combatSeparation;
      this._nudgeGoalY = self.y + ux * side * combatSeparation;
    }
    const gx = this._nudgeGoalX - self.x;
    const gy = this._nudgeGoalY - self.y;
    if (gx * gx + gy * gy < NUDGE_ARRIVED * NUDGE_ARRIVED * combatSeparation * combatSeparation) return false;
    addInterestToward(maps, gx, gy, NUDGE_WEIGHT, NUDGE_SHAPE);
    this._nudgeCount++;
    return true;
  }
}
