/**
 * Recovery from inputTick starvation — Stage 4 hotfix #2 of the network-
 * feel roadmap. Pure-function module; tested in inputTickRecovery.test.ts.
 *
 * The client's input loop advances `inputTick` once per rafTick, capped at
 * MAX_CATCH_UP_TICKS per frame. On a slow-rafTick device (mobile under
 * load: 10–15 Hz observed), the input loop's max sustained advance rate
 * is rafTickHz × MAX_CATCH_UP_TICKS. The server's `inputQueue.ts`
 * held-ack-advance contract advances `ackedTick` at the full server tick
 * rate (60 Hz) regardless of how fast the client sends. After a Pattern A
 * snapshot gap, when the server burst-sends recovery snapshots faster
 * than the client can process them, `ackedTick` outpaces `inputTick` and
 * crosses zero — the client's prediction window collapses and every
 * subsequent reconcile produces a position correction (the diff between
 * the client's stale predWorld and the server's authoritative state).
 *
 * The 2026-05-08 user diagnostic recorded
 * `ticksAhead: min=-26, max=34` and a 13-correction-per-500ms storm.
 *
 * This function detects the pathology (`inputTick <= ackedTick`) and
 * snaps `inputTick` forward to `ackedTick + leadTicks`, restoring a
 * sane prediction window. The replay buffer entries between the old and
 * new inputTick are lost — but the server already synthesized acks for
 * those ticks via held-ack-advance, so they were never going to be
 * physically meaningful client-side anyway.
 */

/**
 * Compute the recovered inputTick. Returns `inputTick` unchanged when
 * the client is normally ahead of the server; snaps forward to
 * `ackedTick + leadTicks` when starved.
 */
export function recoverInputTickFromStarvation(
  inputTick: number,
  ackedTick: number,
  leadTicks: number,
): number {
  if (inputTick <= ackedTick) {
    return ackedTick + leadTicks;
  }
  return inputTick;
}
