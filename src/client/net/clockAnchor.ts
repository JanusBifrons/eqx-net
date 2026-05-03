/**
 * Pure helper for EWMA-smoothing the client-side input clock anchor.
 *
 * The client derives `targetTick` from `(now - anchorPerfNow) / FIXED_MS +
 * anchorServerTick + leadTicks` (Phase 5 sub-phase A wall-clock-anchored
 * input loop). Snapping the anchor to every snapshot's wall-clock arrival
 * time yanks `targetTick` back and forth on jittered networks; the
 * reconciler then replays the difference each time → 90 % `corr` rate
 * observed under server-clock skew.
 *
 * This helper rebases `anchorServerTick` to the current server tick (the
 * tick number itself is a hard counter — not noisy) and EWMA-smooths
 * `anchorPerfNow` toward the snapshot's arrival time. A coarse hard-snap
 * kicks in when the implied drift exceeds CLOCK_ANCHOR_HARD_SNAP_MS so we
 * don't take many snapshots to recover from a network freeze.
 */

const FIXED_MS = 1000 / 60;

/** Smoothing weight applied to each new snapshot's implied perfNow. α=0.1
 *  ≈ ten-snapshot moving average — long enough to absorb ±30 ms jitter,
 *  short enough that genuine clock drift is corrected within ~500 ms. */
export const CLOCK_ANCHOR_EWMA_ALPHA = 0.1;

/** Drift threshold (ms) past which the EWMA gives up and snaps. Set so a
 *  brief network freeze (≤ 200 ms — within Phase 4's 12-tick lag-comp
 *  buffer) still smooths, but a multi-second pause snaps cleanly. */
export const CLOCK_ANCHOR_HARD_SNAP_MS = 200;

export interface AnchorState {
  anchorServerTick: number;
  anchorPerfNow: number;
}

/**
 * Compute the next anchor state given a fresh snapshot. Pure: returns a
 * brand-new object so tests can compare reference snapshots.
 *
 * @param prev The current (anchorServerTick, anchorPerfNow) pair.
 * @param snapServerTick Server tick the snapshot is from.
 * @param snapPerfNow Wall-clock time (`performance.now()`) the snapshot arrived.
 */
export function updateAnchor(
  prev: AnchorState,
  snapServerTick: number,
  snapPerfNow: number,
): AnchorState {
  // Rebase anchor onto the new server tick along the existing clock-line —
  // the line itself is unchanged, just expressed in (snapServerTick, ?).
  const equivalentAnchorPerfNow = prev.anchorPerfNow
    + (snapServerTick - prev.anchorServerTick) * FIXED_MS;
  const driftMs = snapPerfNow - equivalentAnchorPerfNow;
  if (Math.abs(driftMs) > CLOCK_ANCHOR_HARD_SNAP_MS) {
    return { anchorServerTick: snapServerTick, anchorPerfNow: snapPerfNow };
  }
  const blended = equivalentAnchorPerfNow * (1 - CLOCK_ANCHOR_EWMA_ALPHA)
    + snapPerfNow * CLOCK_ANCHOR_EWMA_ALPHA;
  return { anchorServerTick: snapServerTick, anchorPerfNow: blended };
}
