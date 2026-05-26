/**
 * Per-tick SAB → pose-cache mirror, lifted out of `SectorRoom.update()`.
 *
 * Three pose caches live on the main thread (plain Maps of mutable
 * records) so the snapshot path can read poses synchronously without
 * touching the SAB directly. The Colyseus schema is NOT involved —
 * mirroring spatial fields into the schema would double-broadcast on
 * top of the custom SnapshotMessage (see wire-discipline plan).
 *
 *   - `shipPoseCache` — active player ships, keyed by playerId.
 *   - `lingeringPoseCache` — disconnected players' lingering hulls,
 *     keyed by shipInstanceId. Allocated lazily here so the common
 *     "no lingering hulls" case carries an empty Map. The worker
 *     keeps stepping these bodies (drag-decayed vx/vy/angvel).
 *   - `wreckPoseCache` — destroyed hulls, keyed by shipInstanceId.
 *
 * Plus the `sabAppliedTicks` map (per-player most-recent applied
 * input tick), decoded from the SLOT_APPLIED_TICK slot
 * (`storedValue = 0` means none applied yet; `N + 1` means client
 * tick N was applied).
 *
 * Wraps the seqlock retry pattern: on every iteration we double-read
 * the seq counter; if it changed, the worker wrote concurrently and
 * we retry. `seq & 1` means a write is in progress — spin.
 */

import {
  SEQLOCK_IDX,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  SLOT_APPLIED_TICK_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';

export interface PoseRecord {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  angvel?: number;
}

export interface SabPoseMirrorCtx {
  sabF32: Float32Array;
  sabU32: Uint32Array;
  playerToSlot: Map<string, number>;
  lingeringSlots: Map<string, number>;
  wreckToSlot: Map<string, number>;
  shipPoseCache: Map<string, PoseRecord>;
  lingeringPoseCache: Map<string, PoseRecord>;
  wreckPoseCache: Map<string, PoseRecord>;
  sabAppliedTicks: Map<string, number>;
}

export function mirrorSabPoses(ctx: SabPoseMirrorCtx): void {
  const {
    sabF32, sabU32,
    playerToSlot, lingeringSlots, wreckToSlot,
    shipPoseCache, lingeringPoseCache, wreckPoseCache,
    sabAppliedTicks,
  } = ctx;

  for (;;) {
    const seq1 = Atomics.load(sabU32, SEQLOCK_IDX);
    if (seq1 & 1) continue; // odd → write in progress, spin

    for (const [playerId, slot] of playerToSlot) {
      const pose = shipPoseCache.get(playerId);
      if (!pose) continue;
      const b = slotBase(slot);
      pose.x      = sabF32[b + SLOT_X_OFF]!;
      pose.y      = sabF32[b + SLOT_Y_OFF]!;
      pose.angle  = sabF32[b + SLOT_ANGLE_OFF]!;
      pose.vx     = sabF32[b + SLOT_VX_OFF]!;
      pose.vy     = sabF32[b + SLOT_VY_OFF]!;
      pose.angvel = sabF32[b + SLOT_ANGVEL_OFF]!;
    }
    // Phase 6b — lingering hulls' pose mirror. Same SAB → cache
    // update pattern. lingeringPoseCache is allocated lazily so we
    // don't carry an empty record for the common case.
    for (const [shipInstanceId, slot] of lingeringSlots) {
      let pose = lingeringPoseCache.get(shipInstanceId);
      if (!pose) {
        pose = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0 };
        lingeringPoseCache.set(shipInstanceId, pose);
      }
      const b = slotBase(slot);
      pose.x      = sabF32[b + SLOT_X_OFF]!;
      pose.y      = sabF32[b + SLOT_Y_OFF]!;
      pose.angle  = sabF32[b + SLOT_ANGLE_OFF]!;
      pose.vx     = sabF32[b + SLOT_VX_OFF]!;
      pose.vy     = sabF32[b + SLOT_VY_OFF]!;
      pose.angvel = sabF32[b + SLOT_ANGVEL_OFF]!;
    }
    // Phase 4 — wreck pose mirror. Wrecks live in SAB slots like
    // player ships; the worker steps them every physics tick.
    for (const [shipInstanceId, slot] of wreckToSlot) {
      const pose = wreckPoseCache.get(shipInstanceId);
      if (!pose) continue;
      const b = slotBase(slot);
      pose.x      = sabF32[b + SLOT_X_OFF]!;
      pose.y      = sabF32[b + SLOT_Y_OFF]!;
      pose.angle  = sabF32[b + SLOT_ANGLE_OFF]!;
      pose.vx     = sabF32[b + SLOT_VX_OFF]!;
      pose.vy     = sabF32[b + SLOT_VY_OFF]!;
      pose.angvel = sabF32[b + SLOT_ANGVEL_OFF]!;
    }
    // appliedTicks decode kept inside the seqlock window for
    // consistency. storedTick=0 ⇒ no input applied yet; N+1 ⇒
    // client tick N applied.
    for (const [playerId, slot] of playerToSlot) {
      const b = slotBase(slot);
      const storedTick = sabU32[b + SLOT_APPLIED_TICK_OFF]!;
      sabAppliedTicks.set(playerId, storedTick === 0 ? 0 : storedTick - 1);
    }

    const seq2 = Atomics.load(sabU32, SEQLOCK_IDX);
    if (seq1 === seq2) break; // consistent read
    // seq changed during read → writer modified data, retry
  }
}
