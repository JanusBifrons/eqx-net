/**
 * Structure-restyle 3e — the cargo a dock crane carries during its hold.
 *
 * Pure presentation maths, shared by the client renderer and its tests. The
 * server only adds the hold length and the cargo direction to the playing
 * clip record (`PlayingClip.holdTicks` / `.cargo`, wire `rigHold`); every
 * client derives where the crate is from that record and the clip's start
 * tick, so a late joiner sees it mid-way (invariant #16).
 *
 *  - `craneCargoAlong(elapsed, holdTicks, flow)`: how far along the arm the
 *    crate is, 0 = at the clamp (the ship) .. 1 = at the arm's root (the
 *    dock), or -1 when no crate shows;
 *  - `craneCargoPoint(rig, clipIndex, pose, along, out)`: that fraction as a
 *    host-frame point (and heading) on the clip's IK chain, by arc length
 *    from the tip back to the root.
 *
 * Both allocate nothing (invariant #14).
 */
import type { RigPose } from './evaluate.js';
import type { Rig } from './rig.js';

/** Cargo goes ship -> dock (an unload). */
export const CRANE_CARGO_IN = 1;
/** Cargo goes dock -> ship (a load from the dock's export goods). */
export const CRANE_CARGO_OUT = 2;
/** A mixed dock: unload first (first half of the hold), then load. */
export const CRANE_CARGO_BOTH = CRANE_CARGO_IN | CRANE_CARGO_OUT;

/** Share of a leg the crate waits in the clamp / at the root before and
 *  after it travels (the grab and the hand-over read as beats). */
const GRIP = 0.12;
/** Share of a leg it travels for. */
const TRAVEL = 0.73;

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** One inbound leg at phase t (0..1): grip at the clamp, travel to the
 *  root, then gone into the dock for the leg's last beat. */
function inLeg(t: number): number {
  if (t < GRIP) return 0;
  if (t >= GRIP + TRAVEL) return -1;
  return smooth((t - GRIP) / TRAVEL);
}

/** One outbound leg: the exact reverse (appears at the root, travels out,
 *  sits in the clamp until the hold ends). */
function outLeg(t: number): number {
  return inLeg(1 - t);
}

/**
 * Crate position along the arm `elapsed` ticks into a hold of `holdTicks`
 * moving `flow` (`CRANE_CARGO_*`): 0 = clamp (ship) .. 1 = arm root (dock),
 * -1 = no crate (outside the hold, no hold length, no flow, or the beat it
 * is inside the dock).
 */
export function craneCargoAlong(elapsed: number, holdTicks: number, flow: number): number {
  if (!(holdTicks > 0) || !(elapsed >= 0) || elapsed >= holdTicks) return -1;
  const t = elapsed / holdTicks;
  const inbound = (flow & CRANE_CARGO_IN) !== 0;
  const outbound = (flow & CRANE_CARGO_OUT) !== 0;
  if (inbound && outbound) return t < 0.5 ? inLeg(t * 2) : outLeg(t * 2 - 1);
  if (inbound) return inLeg(t);
  if (outbound) return outLeg(t);
  return -1;
}

/** A host-frame point on the arm and the arm's heading there (rad). */
export interface ArmPoint { x: number; y: number; angle: number }

/**
 * The point `along` (0 = tip .. 1 = root, clamped) of clip `clipIndex`'s IK
 * chain in `pose` (already evaluated), by arc length over the chain's
 * segments (root -> each joint -> the clip's tip offset). False (and `out`
 * untouched) when the clip has no chain.
 */
export function craneCargoPoint(rig: Rig, clipIndex: number, pose: RigPose, along: number, out: ArmPoint): boolean {
  const clip = clipIndex >= 0 ? rig.clips[clipIndex] : undefined;
  if (clip === undefined || clip.chain.length === 0) return false;
  const chain = clip.chain;
  const n = chain.length;
  const last = chain[n - 1]!;
  const tipX = pose.x[last]! + clip.tipX * pose.cos[last]! - clip.tipY * pose.sin[last]!;
  const tipY = pose.y[last]! + clip.tipX * pose.sin[last]! + clip.tipY * pose.cos[last]!;
  // Total length: joint k -> joint k+1, then the last joint -> the tip.
  let total = 0;
  for (let k = 0; k < n; k++) {
    const p = chain[k]!;
    const nx = k + 1 < n ? pose.x[chain[k + 1]!]! : tipX;
    const ny = k + 1 < n ? pose.y[chain[k + 1]!]! : tipY;
    total += Math.hypot(nx - pose.x[p]!, ny - pose.y[p]!);
  }
  const a = along <= 0 ? 0 : along >= 1 ? 1 : along;
  // Walk from the tip inward `a * total`.
  let left = a * total;
  for (let k = n - 1; k >= 0; k--) {
    const p = chain[k]!;
    const ax = k + 1 < n ? pose.x[chain[k + 1]!]! : tipX;
    const ay = k + 1 < n ? pose.y[chain[k + 1]!]! : tipY;
    const bx = pose.x[p]!, by = pose.y[p]!;
    const len = Math.hypot(bx - ax, by - ay);
    if (left <= len || k === 0) {
      const f = len > 0 ? Math.min(1, left / len) : 0;
      out.x = ax + (bx - ax) * f;
      out.y = ay + (by - ay) * f;
      out.angle = Math.atan2(ay - by, ax - bx); // root -> tip heading
      return true;
    }
    left -= len;
  }
  return false;
}
