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
import type { IAiAimBoard } from '../../contracts/IAiBehaviour.js';
import { addDangerFromSegment, type ContextMaps } from '../contextSteering.js';

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
