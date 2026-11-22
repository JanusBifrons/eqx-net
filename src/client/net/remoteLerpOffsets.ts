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
 *
 * Netgap S2-3 — a real teleport SNAPS. A correction no ship could fly
 * (`isImplausibleJump`, the bound shared with drone interpolation) or one
 * landing while the ship's PUBLIC warp phase says it is on the run / just
 * arrived drops the offset, so the drawn ship jumps in one frame instead of
 * gliding across the screen.
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
import { isImplausibleJump } from './plausibleSpeed.js';

/** Game ms per server tick (fixed 60 Hz sim). */
const TICK_MS = 1000 / 60;
/** Wire warp phases that mean "moved by warp, not flight": on the run (2)
 *  and just dropped out (3). The build-up (1) is still flown in place. */
const WARP_RUN = 2;
const WARP_ARRIVED = 3;

/** The previous correction's authoritative sample, per client (keyed by its
 *  offsets map, so this module owns the state; one object per client). */
interface LastCorrection {
  serverTick: number;
  gameMs: number;
}
const lastCorrectionByClient = new WeakMap<Map<string, RemoteShipOffset>, LastCorrection>();

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
  /** The snapshot's server tick, and the game clock (ms) it is applied at:
   *  together with the previous correction's they give the span the
   *  teleport bound is measured over (GAME ms, so time scale cancels).
   *  Absent (unit rigs): no teleport snap on distance. */
  serverTick?: number;
  gameNowMs?: number;
  /** The snapshot's ship states, for each remote's public warp phase. */
  states?: Readonly<Record<string, { warp?: 1 | 2 | 3 } | undefined>>;
}

function wrapPi(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function computeRemoteLerpOffsets(ctx: RemoteLerpOffsetCtx): void {
  // Span the bound is measured over: the larger of the server-time span
  // between the two authoritative samples and the game time the client has
  // been predicting since the last one was applied (a gap's held snapshot
  // carries the whole gap's prediction error), so legitimate motion never
  // reads as a teleport. First correction: no previous sample, span 0.
  let spanMs = Infinity;
  if (ctx.serverTick !== undefined && ctx.gameNowMs !== undefined) {
    let last = lastCorrectionByClient.get(ctx.remoteShipOffsets);
    if (last) {
      spanMs = Math.max((ctx.serverTick - last.serverTick) * TICK_MS, ctx.gameNowMs - last.gameMs);
    } else {
      spanMs = 0;
      last = { serverTick: 0, gameMs: 0 };
      lastCorrectionByClient.set(ctx.remoteShipOffsets, last);
    }
    last.serverTick = ctx.serverTick;
    last.gameMs = ctx.gameNowMs;
  }
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
    // A teleport (a jump no ship could fly, or a warp run / arrival) snaps:
    // drop the offset and its spring velocity, so the drawn pose is the new
    // physics pose this frame. The guard above still got the raw distance.
    const warp = ctx.states?.[remoteId]?.warp;
    if (isImplausibleJump(dist, spanMs) || warp === WARP_RUN || warp === WARP_ARRIVED) {
      ctx.remoteShipOffsets.delete(remoteId);
      continue;
    }
    const posMoved = dist > 1;
    const angMoved = Math.abs(oa) > ANGLE_NOISE_THRESHOLD;
    if (!posMoved && !angMoved) continue;
    // Re-anchor the spring at the new offset; velocity zeroed so the
    // spring's first step is governed purely by the new offset. This
    // matches Reconciler.reconcile behaviour. An axis that did not move
    // keeps decaying what it had, so the sprite stays where it was drawn.
    // Netgap S2-1 (plan 3.3): the new offset carries the part of the old
    // one still decaying (drawn before - physics after), so a correction
    // landing mid-ease does not step the drawn ship. The guard above keeps
    // the RAW correction distance.
    const existing = ctx.remoteShipOffsets.get(remoteId);
    if (existing) {
      if (posMoved) {
        existing.sx.x = ox + existing.sx.x;
        existing.sx.v = 0;
        existing.sy.x = oy + existing.sy.x;
        existing.sy.v = 0;
        existing.halfLifeMs = remoteOffsetHalfLifeForDrift(dist);
      }
      if (angMoved) {
        existing.sa.x = wrapPi(oa + existing.sa.x);
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
