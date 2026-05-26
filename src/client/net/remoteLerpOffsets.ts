/**
 * Post-reconcile remote-ship render lerp offsets.
 *
 * For each remote ship, compares the pre-reset pose (captured before
 * reconcile via `preResetRemoteShips`) against the post-reconcile
 * pose. The delta is the visual "snap" the reconciler just applied;
 * we hide it by smoothly easing the renderer back toward the
 * authoritative position over a half-life proportional to drift
 * magnitude.
 *
 * Each entry stores two critically-damped spring states (one per
 * axis) decaying toward zero. `updateMirror()` applies them at
 * render time.
 *
 * Stage 3 — feeds per-remote correction magnitude into the
 * hysteresis guard. 3 consecutive corrections > 5 u disable forward-
 * prediction for that remote; 3 consecutive < 5 u re-enable it.
 * Sticky thresholds avoid oscillation.
 */

import type { PhysicsWorld } from '@core/physics/World';
import type { SpringState } from '@core/math/CritDampedSpring';
import {
  recordRemoteCorrection,
  type RemotePredictionGuard,
} from './remotePredictionGuard';
import { remoteOffsetHalfLifeForDrift } from './predictionTuning';
import type { PreResetEntry } from './snapshotRemoteSync';

export interface RemoteShipOffset {
  sx: SpringState;
  sy: SpringState;
  halfLifeMs: number;
}

export interface RemoteLerpOffsetCtx {
  predWorld: PhysicsWorld;
  preResetRemotePos: Map<string, PreResetEntry>;
  remoteShipOffsets: Map<string, RemoteShipOffset>;
  predGuard: RemotePredictionGuard;
}

export function computeRemoteLerpOffsets(ctx: RemoteLerpOffsetCtx): void {
  for (const [remoteId, preReset] of ctx.preResetRemotePos) {
    const postReconcile = ctx.predWorld.getShipState(remoteId);
    if (!postReconcile) continue;
    const ox = preReset.x - postReconcile.x;
    const oy = preReset.y - postReconcile.y;
    const dist = Math.hypot(ox, oy);
    recordRemoteCorrection(ctx.predGuard, remoteId, dist);
    if (dist <= 1) continue;
    const halfLifeMs = remoteOffsetHalfLifeForDrift(dist);
    // Re-anchor the spring at the new offset; velocity zeroed so the
    // spring's first step is governed purely by the new offset. This
    // matches Reconciler.reconcile behaviour.
    const existing = ctx.remoteShipOffsets.get(remoteId);
    if (existing) {
      existing.sx.x = ox;
      existing.sx.v = 0;
      existing.sy.x = oy;
      existing.sy.v = 0;
      existing.halfLifeMs = halfLifeMs;
    } else {
      ctx.remoteShipOffsets.set(remoteId, {
        sx: { x: ox, v: 0 },
        sy: { x: oy, v: 0 },
        halfLifeMs,
      });
    }
  }
}
