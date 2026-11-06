/**
 * Regression test for the 2026-05-08 inputTick-starvation pathology
 * (network-feel hotfix #2).
 *
 * Symptom captured in `diag/captures/2026-05-08T16-12-02-930Z-z4ixt3.json`:
 * after a 552 ms Pattern A snapshot gap on a slow-rafTick mobile device
 * (15 Hz rafTick observed dropping to 10 Hz under load), the server
 * burst-sends snapshots at ~30 Hz to catch the client up, the held-ack-
 * advance contract in `inputQueue.ts` advances `ackedTick` at full server
 * rate (60 Hz), and the client's input loop — bounded by
 * MAX_CATCH_UP_TICKS × rafTickHz — can't keep up. Result:
 *
 *   inputTick:  386788  (client-side, advancing at ~40 Hz on slow device)
 *   ackedTick:  386814  (server-acked at ~60 Hz from held-ack synthesis)
 *   ticksAhead: -26     (pathological — server's view is "in the future")
 *
 * The reconciler's replay range becomes empty (replayStart > currentTick),
 * predWorld is reset to serverState (which is "ahead" of where the client
 * thinks it is), drift = pre-reset position − server position = many units
 * → cascading 14u/30u corrections every 30 ms during the storm.
 *
 * Fix: when handleSnapshot observes ackedTick > inputTick, snap inputTick
 * forward to (ackedTick + leadTicks). This is a "recovery hard-reset"
 * analogous to clockAnchor's > 200 ms hard-snap path. Loses the gap's
 * input replay buffer entries (server already synthesized them anyway)
 * but stops the cascading correction storm.
 */
import { describe, it, expect } from 'vitest';
import { recoverInputTickFromStarvation } from './inputTickRecovery.js';

describe('inputTickRecovery', () => {
  it('returns inputTick unchanged when client is normally ahead', () => {
    expect(recoverInputTickFromStarvation(120, 110, 5)).toBe(120);
  });

  it('returns inputTick unchanged when client is exactly at the threshold (ahead = leadTicks)', () => {
    // Normal steady state: inputTick = ackedTick + leadTicks.
    expect(recoverInputTickFromStarvation(115, 110, 5)).toBe(115);
  });

  it('snaps inputTick forward when ackedTick races past it (the pathology)', () => {
    // The exact diagnostic numbers: ackedTick=386814, inputTick=386788, leadTicks=5.
    // Recovered inputTick = ackedTick + leadTicks = 386819.
    expect(recoverInputTickFromStarvation(386788, 386814, 5)).toBe(386819);
  });

  it('snaps inputTick forward at the boundary (ackedTick === inputTick)', () => {
    // No prediction window left — client is in lockstep with server, not
    // ahead of it. About to enter the pathological negative-ahead state
    // on the next tick. Snap forward to preserve the lead.
    expect(recoverInputTickFromStarvation(110, 110, 5)).toBe(115);
  });

  it('respects the leadTicks parameter when snapping', () => {
    // leadTicks=10 → snap target = ackedTick + 10
    expect(recoverInputTickFromStarvation(100, 110, 10)).toBe(120);
    // leadTicks=3 → snap target = ackedTick + 3
    expect(recoverInputTickFromStarvation(100, 110, 3)).toBe(113);
  });

  it('handles small leadTicks (degenerate) without crashing', () => {
    expect(recoverInputTickFromStarvation(100, 110, 1)).toBe(111);
    expect(recoverInputTickFromStarvation(100, 110, 0)).toBe(110);
  });
});

import { skipStalledBacklog, STALL_SKIP_TICKS } from './inputTickRecovery.js';

describe('skipStalledBacklog (round 3 fly-by judder: backlog replay after the loading hold)', () => {
  it('a short backlog (frame jitter) still catches up tick by tick', () => {
    expect(skipStalledBacklog(100, 106)).toBe(100);
    expect(skipStalledBacklog(100, 100 + STALL_SKIP_TICKS)).toBe(100);
  });

  it('a stall is skipped to one tick short of the target, so the frame runs one tick', () => {
    expect(skipStalledBacklog(18, 4018)).toBe(4017);
    expect(skipStalledBacklog(100, 100 + STALL_SKIP_TICKS + 2)).toBe(100 + STALL_SKIP_TICKS + 1);
  });

  it('never skips past the over-prediction ceiling (a backlog the cap held is not a stall)', () => {
    // Acks lagging (bufferbloat): cap at ack 100 + 60 = 160; target far ahead.
    expect(skipStalledBacklog(150, 400, 160)).toBe(150);
    // A genuine stall below the ceiling still skips, but only up to it.
    expect(skipStalledBacklog(18, 4018, 1000)).toBe(999);
  });

  it('never moves the tick backwards', () => {
    expect(skipStalledBacklog(500, 490)).toBe(500);
  });
});

import { stallResumeAction, ANCHOR_STALE_MS, STALL_HOLD_MAX_MS } from './inputTickRecovery.js';

describe('stallResumeAction (resume a stall from a fresh clock, not a 12 s-old projection)', () => {
  it('a short backlog just runs', () => {
    expect(stallResumeAction(STALL_SKIP_TICKS, 10_000, 0)).toBe('run');
  });
  it('a stall with a stale anchor holds until a snapshot re-syncs the clock', () => {
    expect(stallResumeAction(4000, ANCHOR_STALE_MS + 1, 0)).toBe('hold');
  });
  it('a stall with a fresh anchor skips', () => {
    expect(stallResumeAction(4000, 20, 0)).toBe('skip');
  });
  it('never holds forever: after STALL_HOLD_MAX_MS it skips anyway', () => {
    expect(stallResumeAction(4000, 10_000, STALL_HOLD_MAX_MS)).toBe('skip');
  });
});

