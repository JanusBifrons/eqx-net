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

/**
 * A backlog longer than this (ticks, 0.5 s) is a stall — the loading curtain
 * (`gameRafLoop` skips `tickPhysics` while it is up), a background tab, a long
 * hang — not frame jitter to catch up on. Short backlogs still catch up at
 * MAX_CATCH_UP_TICKS a frame, as the wall-clock-anchored loop intends.
 */
export const STALL_SKIP_TICKS = 30;

/**
 * Skip a stalled backlog: return the tick to resume from (one short of
 * `targetTick`, so this frame runs exactly one tick), or `inputTick` when the
 * backlog is short.
 *
 * Replaying a stalled backlog at 4 ticks a frame made the client predict far
 * ahead of the server for tens of seconds and get reconciled back every
 * snapshot: a 20 Hz sawtooth of the drawn ship (round 3 fly-by: a 15-70 s
 * loading hold while capital art baked became 20-30 s of judder). The skipped
 * ticks carry no input, which is what the player gave during the stall; the
 * server's held-ack advance already covers them.
 *
 * `maxTick` is the over-prediction ceiling (last ack + MAX_OVER_PREDICTION_TICKS;
 * Infinity before the first ack). A backlog that grew because that cap held the
 * loop (acks lagging: bufferbloat) is NOT a stall, and skipping past the cap
 * would re-open the spiral it prevents (the replay locks catch this).
 */
export function skipStalledBacklog(inputTick: number, targetTick: number, maxTick = Infinity, maxBacklog = STALL_SKIP_TICKS): number {
  const to = Math.min(targetTick - 1, maxTick - 1);
  return to - inputTick > maxBacklog ? to : inputTick;
}

/** The clock anchor is stale if no snapshot has re-synced it for this long. */
export const ANCHOR_STALE_MS = 500;
/** Longest a stalled client waits for a fresh anchor before resuming anyway. */
export const STALL_HOLD_MAX_MS = 2000;

/**
 * What to do with a stalled backlog this frame. `'run'`: not a stall, step as
 * usual. `'hold'`: a stall, but the clock anchor is stale, so the target itself
 * is a guess; don't step until a snapshot re-syncs it. `'skip'`: a stall with a
 * fresh anchor (or held too long): skip to the target (`skipStalledBacklog`).
 *
 * Why hold: the server sends a joining client no snapshots until
 * `client_ready`, which goes when the loading curtain lifts. Over a long hold
 * the welcome anchor is projected forward while the server's real tick count
 * drifts from it (it drops ticks under load), so skipping to that projection
 * lands tens of ticks off, and the first snapshot then re-syncs the clock
 * with a freeze (projection ahead) or a 4-tick-a-frame catch-up (behind). The
 * server activates the ship only after `client_ready` anyway, so standing
 * still for those first frames costs nothing.
 */
export function stallResumeAction(backlog: number, anchorAgeMs: number, heldForMs: number): 'run' | 'hold' | 'skip' {
  if (backlog <= STALL_SKIP_TICKS) return 'run';
  if (anchorAgeMs > ANCHOR_STALE_MS && heldForMs < STALL_HOLD_MAX_MS) return 'hold';
  return 'skip';
}

