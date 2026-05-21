/**
 * Recovery from inputTick OVER-prediction — Stage 4 hotfix-class change
 * (perf-floor session 3). Symmetric counterpart to
 * `inputTickRecovery.recoverInputTickFromStarvation`. Pure function;
 * deterministic over synthetic inputs.
 *
 * The 2026-05-20 on-device captures (vg9hon, ers7xy) document the
 * mirror-image pathology of hotfix #2: under sustained mobile burst-
 * transit, the server's TCP input queue grows deep — `ackedTick` lags
 * `serverTick` by 100-300+ ticks — while the client's wall-clock-
 * anchored input loop keeps advancing `inputTick` at 60 Hz. The result:
 *
 *   inputTick:  inputTick advancing at 60 Hz (wall-clock)
 *   ackedTick:  ackedTick advancing at server-queue-drain rate (slower)
 *   ticksAhead: 100-300+ (sustained spiral; ers7xy captured 327)
 *
 * Each subsequent snapshot triggers a Reconciler replay capped at
 * BUFFER_SIZE=128 ticks of physics, costing 50-1000+ ms of main-thread
 * time on a mobile device. The user perceives this as the ship being
 * unresponsive (predicting state 1-5 seconds in the future) and as
 * frame-rate degradation (rafP50 climbing to 88.8 ms = 11 fps in
 * ers7xy).
 *
 * `leadTicks` is irrelevant here — it stays saturated at ~25 throughout
 * the captures (CEILING_TICKS=30 caps it from going higher). The
 * dominant variable is the inputTick-ackedTick gap, not the lookahead.
 *
 * Fix: when handleSnapshot observes `inputTick - ackedTick >
 * MAX_TICKS_AHEAD`, snap `inputTick` BACK to `ackedTick + leadTicks`.
 * Symmetric to hotfix #2 (starvation snaps forward, this snaps back).
 *
 * Trade-off: the inputs in the discarded `[ackedTick + leadTicks + 1,
 * old inputTick]` window are visually lost — the player will see a
 * one-time snap-back of position when the recovery fires. But those
 * inputs were already buffered on the server (or in the TCP send queue)
 * and were never going to be applied in real-time anyway — the user's
 * "ship unresponsive" experience is precisely those inputs never
 * landing. Better one visible snap-back than continuous 5-second-ahead
 * prediction.
 *
 * Threshold rationale: `MAX_TICKS_AHEAD = 60` ≈ 1 s wall-clock. Well
 * above the steady-state ticksAhead (~25, matching leadTicks ceiling)
 * so it never fires under healthy conditions. Far enough above to
 * absorb short bursts before triggering. The Phase 1 ndjson replay
 * regression lock asserts `< 60`; the recovery threshold matches.
 */

/** Hard cap on (inputTick - ackedTick). Set above the steady-state
 *  ticksAhead (~25 = CEILING_TICKS) with 25 ticks of headroom for
 *  short bursts, and below the spiral regression lock's <60 threshold
 *  so the cap engages BEFORE the lock would trip. 50 = ~833 ms wall-
 *  clock at 60 Hz. */
export const MAX_TICKS_AHEAD = 50;

/**
 * Compute the recovered inputTick. Returns `inputTick` unchanged when
 * the over-prediction gap is within bounds; snaps back to
 * `ackedTick + leadTicks` when the gap exceeds MAX_TICKS_AHEAD.
 *
 * Mirrors `recoverInputTickFromStarvation` shape: same return target
 * (`ackedTick + leadTicks`), same pure-function pattern, opposite
 * trigger condition.
 */
export function recoverInputTickFromOverPrediction(
  inputTick: number,
  ackedTick: number,
  leadTicks: number,
): number {
  if (inputTick - ackedTick > MAX_TICKS_AHEAD) {
    return ackedTick + leadTicks;
  }
  return inputTick;
}
