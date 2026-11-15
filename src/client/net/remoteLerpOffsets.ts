/**
 * Post-reconcile remote-ship render lerp offsets.
 *
 * For each remote ship, compares the pre-reset pose (captured before
 * reconcile via `preResetRemoteShips`) against the post-reconcile
 * pose. The delta is the visual "snap" the reconciler just applied;
 * we hide it by smoothly easing the renderer back toward the
 * authoritative pose over a half-life proportional to drift
 * magnitude.
 *
 * Each entry stores three critically-damped spring states decaying
 * toward zero: x, y and ANGLE (RTS Part A S1: the angle axis ported from
 * the parked-hull manager so a turning remote ship doesn't rotate in
 * 20 Hz steps). `updateMirror()` applies them at render time through
 * `stepRemoteShipOffset`.
 *
 * Stage 3 — feeds per-remote correction magnitude into the
 * hysteresis guard. 3 consecutive corrections > 5 u disable forward-
 * prediction for that remote; 3 consecutive < 5 u re-enable it.
 * Sticky thresholds avoid oscillation.
 */

import type { PhysicsWorld } from '@core/physics/World';
import { springStep, type SpringState } from '@core/math/CritDampedSpring';
import {
  recordRemoteCorrection,
  type RemotePredictionGuard,
} from './remotePredictionGuard';
import {
  ANGLE_NOISE_THRESHOLD,
  REMOTE_ANGLE_OFFSET_HALF_LIFE_MS,
  REMOTE_ANGLE_SPRING_VEL_END,
  REMOTE_SPRING_POS_END,
  REMOTE_SPRING_VEL_END_MS,
  remoteOffsetHalfLifeForDrift,
} from './predictionTuning';
import type { PreResetEntry } from './snapshotRemoteSync';

export interface RemoteShipOffset {
  sx: SpringState;
  sy: SpringState;
  /** Angle offset (rad, wrapped to ±π at capture), decays to 0. */
  sa: SpringState;
  halfLifeMs: number;
}

export interface RemoteLerpOffsetCtx {
  predWorld: PhysicsWorld;
  preResetRemotePos: Map<string, PreResetEntry>;
  remoteShipOffsets: Map<string, RemoteShipOffset>;
  predGuard: RemotePredictionGuard;
  /** Optional: accumulates each remote's reset correction (print-only). */
  stats?: { remoteCorrTotalUnits: number; remoteCorrSamples: number };
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function computeRemoteLerpOffsets(ctx: RemoteLerpOffsetCtx): void {
  for (const [remoteId, preReset] of ctx.preResetRemotePos) {
    const postReconcile = ctx.predWorld.getShipState(remoteId);
    if (!postReconcile) continue;
    const ox = preReset.x - postReconcile.x;
    const oy = preReset.y - postReconcile.y;
    const oa = wrapPi(preReset.angle - postReconcile.angle);
    const dist = Math.hypot(ox, oy);
    recordRemoteCorrection(ctx.predGuard, remoteId, dist);
    if (ctx.stats) {
      ctx.stats.remoteCorrTotalUnits += dist;
      ctx.stats.remoteCorrSamples++;
    }
    const posMoved = dist > 1;
    const angMoved = Math.abs(oa) > ANGLE_NOISE_THRESHOLD;
    if (!posMoved && !angMoved) continue;
    // Re-anchor the spring at the new offset; velocity zeroed so the
    // spring's first step is governed purely by the new offset. This
    // matches Reconciler.reconcile behaviour. An axis that did not move
    // keeps decaying what it had, so the sprite stays where it was drawn.
    const existing = ctx.remoteShipOffsets.get(remoteId);
    if (existing) {
      if (posMoved) {
        existing.sx.x = ox;
        existing.sx.v = 0;
        existing.sy.x = oy;
        existing.sy.v = 0;
        existing.halfLifeMs = remoteOffsetHalfLifeForDrift(dist);
      }
      if (angMoved) {
        existing.sa.x = oa;
        existing.sa.v = 0;
      }
    } else {
      ctx.remoteShipOffsets.set(remoteId, {
        sx: { x: posMoved ? ox : 0, v: 0 },
        sy: { x: posMoved ? oy : 0, v: 0 },
        sa: { x: angMoved ? oa : 0, v: 0 },
        halfLifeMs: remoteOffsetHalfLifeForDrift(dist),
      });
    }
  }
}

/**
 * Advance one remote ship's offset springs by one render frame. The drawn
 * pose is the predWorld pose plus `off.sx.x`, `off.sy.x` and `off.sa.x`.
 * Returns false once every axis has settled at the noise floor (the caller
 * then drops the entry). Alloc-free.
 */
export function stepRemoteShipOffset(off: RemoteShipOffset, frameMs: number): boolean {
  springStep(off.sx, 0, off.halfLifeMs, frameMs);
  springStep(off.sy, 0, off.halfLifeMs, frameMs);
  springStep(off.sa, 0, REMOTE_ANGLE_OFFSET_HALF_LIFE_MS, frameMs);
  return (
    Math.abs(off.sx.x) > REMOTE_SPRING_POS_END ||
    Math.abs(off.sy.x) > REMOTE_SPRING_POS_END ||
    Math.abs(off.sx.v) > REMOTE_SPRING_VEL_END_MS ||
    Math.abs(off.sy.v) > REMOTE_SPRING_VEL_END_MS ||
    Math.abs(off.sa.x) > ANGLE_NOISE_THRESHOLD ||
    Math.abs(off.sa.v) > REMOTE_ANGLE_SPRING_VEL_END
  );
}
