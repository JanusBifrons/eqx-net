/**
 * The rig view's frame maths (moved out of structureRigs.ts for its size
 * cap; re-exported from there): a rig part's Pixi transform in its host's
 * frame, and a world point into a host's frame. Allocation-free.
 */
import type { RigPose } from '../../../core/articulation/evaluate.js';

/** A Pixi local transform (caller-owned scratch). */
export interface PixiXform { x: number; y: number; rotation: number }

/** Part `i`'s transform in the host's local Pixi frame: the Y-flip of its
 *  host-relative game pose. Allocation-free. */
export function partLocalTransform(pose: RigPose, i: number, out: PixiXform): PixiXform {
  out.x = pose.x[i]!;
  out.y = -pose.y[i]!;
  out.rotation = -pose.angle[i]!;
  return out;
}

/** Write a WORLD game point into the host frame of a host at (hx, hy)
 *  facing `ha` (game space), drawn at `scale`. Allocation-free. */
export function worldToHost(wx: number, wy: number, hx: number, hy: number, ha: number, scale: number, out: { x: number; y: number }): void {
  const dx = wx - hx, dy = wy - hy;
  const c = Math.cos(ha), s = Math.sin(ha);
  const k = scale !== 0 ? 1 / scale : 1;
  out.x = (dx * c + dy * s) * k;
  out.y = (-dx * s + dy * c) * k;
}
