/**
 * Regression test for the 2026-05-09 Welford post-gap pollution pathology.
 *
 * Scenario captured in `diag/captures/2026-05-09T09-31-30-823Z-n3n9jx`
 * (mobile, fresh server with the input-queue gate fix in place):
 *
 *   - 164 snapshots over 7.6 s
 *   - srvTick − ackedTick locked at +1 (gate fix working)
 *   - But `rttMs` field in snapshots ranges 200–870 ms (real Wi-Fi RTT
 *     should be 20–50 ms)
 *   - `ticksAhead` saturates at 18–22 in steady state, spikes to 35–53
 *     after each receive gap → `leadTicks` is hitting the 30-tick
 *     CEILING_TICKS cap → client predicts ~500 ms ahead → every wire
 *     gap produces drift events the user feels as constant jitter
 *
 * Root cause: Stage 4 hotfix #3 filters the *gap* snapshot itself
 * (intervalMs > STEADY_STATE_INTERVAL_MAX_MS) but does NOT filter the
 * snapshots that follow the gap. Those follow-on snapshots have
 * `intervalMs` back in the steady-state band [35, 75] ms — looking
 * normal — but their `Reconciler.lastRtt` value is still inflated
 * because the input being acked was sent before/during the gap, so
 * `now − ackedRec.sentAt` includes the gap duration.
 *
 * Hotfix #1's RTT_SAMPLE_CLAMP_MS = 250 caps each individual sample
 * but every clamped sample still pulls the running mean toward 250 ms.
 * Over enough cycles, mean drifts upward, σ inflates, leadTicks
 * saturates, the client over-predicts.
 *
 * This test reproduces the pollution pattern with synthetic data and
 * asserts the mean stays bounded after a gap-recovery cycle. Without
 * the post-gap-skip extension, the assertion fails.
 */
import { describe, it, expect } from 'vitest';
import type { Event } from './types';
import { runScenario } from './runner';

/** A round-number "clean" RTT for synthetic events — well below clamp. */
const CLEAN_RTT_MS = 30;

/** What `Reconciler.lastRtt` reports during/after a gap. */
const GAP_LASTRTT_MS = 280;

/** Build a steady 50 ms-cadence snapshot stream with `lastRtt` = clean. */
function steadySnapshots(opts: {
  fromMs: number;
  fromTick: number;
  count: number;
  rttMs?: number;
}): Event[] {
  const events: Event[] = [];
  for (let i = 0; i < opts.count; i++) {
    events.push({
      type: 'snapshot',
      atMs: opts.fromMs + i * 50,
      serverTick: opts.fromTick + i * 3,
      ackedTick: opts.fromTick + i * 3 - 1,
      lastRtt: opts.rttMs ?? CLEAN_RTT_MS,
    });
  }
  return events;
}

describe('Welford mean — post-gap pollution', () => {
  it('mean stays bounded when a single gap is followed by recovery snapshots with inflated lastRtt', () => {
    // Build a timeline:
    //   1. 30 clean snapshots at 50 ms cadence, rtt=30 ms — establishes
    //      welford mean ≈ 30.
    //   2. ONE gap snapshot at 300 ms interval, rtt=300 ms — this is
    //      the gap snapshot itself, correctly filtered by hotfix #3.
    //   3. 20 follow-on snapshots at 50 ms cadence (in band) but with
    //      lastRtt=280 ms (clamped to 250 ms by hotfix #1). Without a
    //      post-gap skip, these get pushed into welford.
    //   4. 30 more clean snapshots — by then mean should have recovered
    //      if the system is healthy.
    const events: Event[] = [
      ...steadySnapshots({ fromMs: 0, fromTick: 100, count: 30, rttMs: CLEAN_RTT_MS }),
      // The gap snapshot — 300 ms after the last steady snapshot,
      // intervalMs=300, lastRtt=300 (covers the gap).
      {
        type: 'snapshot',
        atMs: 30 * 50 + 300,
        serverTick: 100 + 30 * 3,
        ackedTick: 100 + 30 * 3 - 1,
        lastRtt: 300,
      },
      // 20 follow-on snapshots at 50 ms cadence (in band) but with
      // inflated lastRtt — the pollution surface.
      ...steadySnapshots({
        fromMs: 30 * 50 + 300 + 50,
        fromTick: 100 + 30 * 3 + 3,
        count: 20,
        rttMs: GAP_LASTRTT_MS,
      }),
      // 30 more clean snapshots — recovery zone.
      ...steadySnapshots({
        fromMs: 30 * 50 + 300 + 50 + 20 * 50,
        fromTick: 100 + 30 * 3 + 3 + 20 * 3,
        count: 30,
        rttMs: CLEAN_RTT_MS,
      }),
    ];

    const observations = runScenario(events);

    // Final welford mean should track the actual steady-state RTT
    // (~30 ms), not the polluted value. With the bug present, the
    // 20 inflated samples drag mean to ~150 ms+ and it never recovers.
    const finalMean = observations[observations.length - 1]!.rttMean;

    // With a healthy filter, only the 60 clean samples (rtt=30) get
    // pushed; the gap snapshot is filtered by hotfix #3 and the 20
    // post-gap polluted samples should ALSO be filtered (the fix this
    // test drives). Mean should track 30 ms.
    //
    // Pre-fix: 30 clean + 20 polluted-but-pushed (clamped to 250) +
    // 30 more clean → mean ≈ 85 ms. That's the regression we're
    // catching.
    //
    // Threshold of 50 ms is well above the clean baseline (30 ms,
    // accounting for any minor variance) but well below the polluted
    // state (~85 ms+).
    expect(finalMean).toBeLessThan(50);
  });

  it('leadTicks does not saturate at the 30-tick ceiling after a single gap', () => {
    // Same scenario, asserting on leadTicks rather than mean directly.
    // The ceiling is 30; under healthy steady-state RTT (~30 ms) the
    // expected leadTicks is ~3-6. Pollution drives this up to the cap.
    const events: Event[] = [
      ...steadySnapshots({ fromMs: 0, fromTick: 100, count: 30, rttMs: CLEAN_RTT_MS }),
      {
        type: 'snapshot',
        atMs: 30 * 50 + 300,
        serverTick: 100 + 30 * 3,
        ackedTick: 100 + 30 * 3 - 1,
        lastRtt: 300,
      },
      ...steadySnapshots({
        fromMs: 30 * 50 + 300 + 50,
        fromTick: 100 + 30 * 3 + 3,
        count: 20,
        rttMs: GAP_LASTRTT_MS,
      }),
      ...steadySnapshots({
        fromMs: 30 * 50 + 300 + 50 + 20 * 50,
        fromTick: 100 + 30 * 3 + 3 + 20 * 3,
        count: 30,
        rttMs: CLEAN_RTT_MS,
      }),
    ];

    const observations = runScenario(events);
    const finalLeadTicks = observations[observations.length - 1]!.leadTicks;

    // leadTicks scales with mean + 2σ. Healthy steady state with 30 ms RTT
    // gives leadTicks ≈ 3-6. Saturated at 30 means the lookahead
    // controller has hit CEILING_TICKS — what we're trying to prevent.
    expect(finalLeadTicks).toBeLessThan(15);
  });

  it('repeated gap-pollution cycles do not progressively drift mean upward', () => {
    // Real-world mobile sessions hit multiple gaps over a session. Each
    // gap-recovery cycle should be neutral on the running mean. With the
    // bug present, the mean ratchets up with each cycle and never
    // recovers.
    const cyclesEvents: Event[] = [];
    let ms = 0;
    let tick = 100;
    const cycleDuration = (30 + 1 + 20) * 50 + 250; // approximate

    for (let cycle = 0; cycle < 5; cycle++) {
      // 30 clean snapshots
      cyclesEvents.push(...steadySnapshots({ fromMs: ms, fromTick: tick, count: 30, rttMs: CLEAN_RTT_MS }));
      ms += 30 * 50;
      tick += 30 * 3;
      // gap
      cyclesEvents.push({
        type: 'snapshot',
        atMs: ms + 250,
        serverTick: tick,
        ackedTick: tick - 1,
        lastRtt: 280,
      });
      ms += 250 + 50;
      tick += 3;
      // 20 polluted recovery snapshots
      cyclesEvents.push(...steadySnapshots({ fromMs: ms, fromTick: tick, count: 20, rttMs: GAP_LASTRTT_MS }));
      ms += 20 * 50;
      tick += 20 * 3;
    }

    const observations = runScenario(cyclesEvents);
    const finalMean = observations[observations.length - 1]!.rttMean;

    // After 5 cycles, mean should still reflect the clean steady state,
    // not have ratcheted upward toward the clamp. Pre-fix: ~85 ms. Fixed: ~30 ms.
    expect(finalMean).toBeLessThan(50);
  });
});
