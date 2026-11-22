/**
 * The tick a snapshot reconcile replays up to (exclusive; `Reconciler.reconcile`'s
 * `currentTick`).
 *
 * While the loading curtain is up, `gameRafLoop` skips `tickPhysics`: the input
 * tick is frozen, nothing is sent (`ackedTick` stays 0) and the predWorld is not
 * stepped live, so there is no live prediction to replay. Replaying anyway spun
 * the capped 128 input-less ticks of the whole sector on every snapshot: ~340 ms
 * a snapshot on a Pixel-class phone in a 178-structure field, ~3 fps behind the
 * curtain for 20 s (phone capture p7uotg, 2026-11-22). Paused → replay up to
 * `ackedTick`, an empty window: the reconcile just snaps to the server pose.
 */
export function reconcileReplayTick(physicsPaused: boolean, inputTick: number, ackedTick: number): number {
  return physicsPaused ? ackedTick : inputTick;
}
