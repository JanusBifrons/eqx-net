/**
 * Structure-restyle 3e — the goods a dock crane moves during its hold.
 *
 * Pure presentation maths, shared by the client renderer and its tests. The
 * server only adds the hold length and the cargo direction to the playing
 * clip record (`PlayingClip.holdTicks` / `.cargo`, wire `rigHold`); every
 * client derives the flow from that record and the clip's start tick, so a
 * late joiner sees it mid-way (invariant #16). The client draws it as the
 * cable look's travelling flow pulse running along the arm (owner: "act and
 * look like the cables").
 *
 *  - `craneCargoFlow(elapsed, holdTicks, flow)`: which way goods move at that
 *    point of the hold (`CRANE_CARGO_IN` ship -> dock, `CRANE_CARGO_OUT`
 *    dock -> ship, 0 none);
 *  - `craneArmPath(rig, clipIndex, pose, out)`: the arm as a polyline from
 *    the clamp (the ship) to the arm's root (the dock), host frame.
 *
 * All allocate nothing (invariant #14).
 */
import type { RigPose } from './evaluate.js';
import type { Rig } from './rig.js';

/** Goods go ship -> dock (an unload). */
export const CRANE_CARGO_IN = 1;
/** Goods go dock -> ship (a load from the dock's export goods). */
export const CRANE_CARGO_OUT = 2;
/** A mixed dock: unload first (first half of the hold), then load. */
export const CRANE_CARGO_BOTH = CRANE_CARGO_IN | CRANE_CARGO_OUT;

/**
 * Which way goods move `elapsed` ticks into a hold of `holdTicks` carrying
 * `flow` (`CRANE_CARGO_*`): `CRANE_CARGO_IN`, `CRANE_CARGO_OUT`, or 0 (no
 * flow: outside the hold, no hold length or no direction). A mixed dock
 * unloads for the first half, loads for the second.
 */
export function craneCargoFlow(elapsed: number, holdTicks: number, flow: number): number {
  if (!(holdTicks > 0) || !(elapsed >= 0) || elapsed >= holdTicks) return 0;
  const inbound = (flow & CRANE_CARGO_IN) !== 0;
  const outbound = (flow & CRANE_CARGO_OUT) !== 0;
  if (inbound && outbound) return elapsed < holdTicks / 2 ? CRANE_CARGO_IN : CRANE_CARGO_OUT;
  if (inbound) return CRANE_CARGO_IN;
  if (outbound) return CRANE_CARGO_OUT;
  return 0;
}

/**
 * Write clip `clipIndex`'s IK chain in `pose` (already evaluated) into `out`
 * as x, y pairs from the clip's tip (the clamp) back to the chain root: tip,
 * last joint, ..., root joint. Returns the point count (chain length + 1),
 * or 0 when the clip has no chain or `out` is too short.
 */
export function craneArmPath(rig: Rig, clipIndex: number, pose: RigPose, out: Float64Array): number {
  const clip = clipIndex >= 0 ? rig.clips[clipIndex] : undefined;
  if (clip === undefined || clip.chain.length === 0) return 0;
  const chain = clip.chain;
  const n = chain.length;
  if (out.length < 2 * (n + 1)) return 0;
  const last = chain[n - 1]!;
  out[0] = pose.x[last]! + clip.tipX * pose.cos[last]! - clip.tipY * pose.sin[last]!;
  out[1] = pose.y[last]! + clip.tipX * pose.sin[last]! + clip.tipY * pose.cos[last]!;
  for (let k = 0; k < n; k++) {
    const p = chain[n - 1 - k]!;
    out[2 * (k + 1)] = pose.x[p]!;
    out[2 * (k + 1) + 1] = pose.y[p]!;
  }
  return n + 1;
}
