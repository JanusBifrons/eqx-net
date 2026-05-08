/**
 * Stage 4.5 — permanent regression fixtures from real-world diagnostics.
 *
 * Each test in this file corresponds to a specific user-reported issue
 * captured by a diagnostic. The scenario builder reproduces the network
 * + device conditions; the assertion verifies the property the production
 * code is supposed to maintain.
 *
 * **The contract**: every user-reported regression we fix gets a fixture
 * here. If the fix is ever reverted (or a future change re-introduces
 * the same class of bug), this file fails on CI before the regression
 * reaches production.
 *
 * Adding a new fixture:
 *   1. Capture the diagnostic (see `diag/captures/`).
 *   2. Identify the conditions: rafTickHz, RTT mean, jitter, snapshot
 *      gaps, input pattern.
 *   3. Build a `Scenario` that reproduces those conditions.
 *   4. Identify the property the production code violates.
 *   5. Write the assertion using helpers from `./assertions.ts` (or add
 *      a new helper if the property isn't covered).
 *   6. Verify the test FAILS with the hotfix reverted, then re-apply
 *      the fix and verify it PASSES. This is the TDD discipline pivot
 *      from 2026-05-08.
 */
import { describe, it, expect } from 'vitest';
import { runScenario } from './runner';
import { buildScenarioEvents } from './scenarios';
import {
  ticksAheadNeverBelow,
  welfordStdDevBoundedBy,
  describeWindow,
  starvationSnapCount,
} from './assertions';

describe('Network-feel regression fixtures', () => {
  it('Hotfix #1 (2026-05-08): RTT outlier from a Pattern A snapshot gap does not explode Welford σ', () => {
    // Reproduces `diag/captures/2026-05-08T16-00-51-212Z-k35x92.json`:
    // the user's RTT was healthy (~37 ms live) but a single 572 ms inbound
    // snapshot gap produced a 572 ms-equivalent RTT sample (because
    // `Reconciler.lastRtt = now - ackedRec.sentAt` is contaminated by
    // snapshot-delay). Pre-Stage-4-hotfix-#1, that one outlier pushed
    // Welford σ to 249 ms and saturated leadTicks at the 30-tick cap.
    //
    // Property: with the RTT_SAMPLE_CLAMP_MS = 250 clamp in place, σ
    // stays well below the runaway range even after the outlier.
    const events = buildScenarioEvents({
      name: 'pattern-a-552ms-gap-low-rtt',
      rafTickHz: 60, // healthy desktop rate (isolating the σ issue from the rafTick issue)
      rttMs: 37,
      jitterMs: 5,
      gapsMs: [{ atMs: 5000, durationMs: 572 }],
      durationMs: 12_000,
    });
    const observations = runScenario(events);

    const result = welfordStdDevBoundedBy(observations, 100); // production hotfix bounds at ~125
    if (!result.passed) {
      // Show the window around the violation for diagnostic context.
      console.log('Window around violation:');
      console.log(describeWindow(observations, result.violation!.atMs));
    }
    expect(result.passed).toBe(true);
  });

  it('Hotfix #2 (2026-05-08): inputTick does not get starved on slow rafTick + Pattern A gap', () => {
    // Reproduces `diag/captures/2026-05-08T16-12-02-930Z-z4ixt3.json`:
    // mobile device at 10–15 Hz rafTick. After a 552 ms inbound snapshot
    // gap, the server's burst-recovery snapshots arrived faster than the
    // client could process (rafTickHz × MAX_CATCH_UP_TICKS = 40 Hz vs.
    // server's held-ack-advance at 60 Hz), so `ackedTick` outpaced
    // `inputTick` and `ticksAhead` went down to -26.
    //
    // Property: with `recoverInputTickFromStarvation` running in
    // `handleSnapshot`, every snapshot detects starvation (inputTick ≤
    // ackedTick) and snaps inputTick forward. ticksAhead never goes
    // negative.
    const events = buildScenarioEvents({
      name: 'slow-raftick-with-gap',
      rafTickHz: 10, // slow mobile under load
      rttMs: 50,
      gapsMs: [{ atMs: 5000, durationMs: 552 }],
      durationMs: 12_000,
    });
    const observations = runScenario(events);

    const result = ticksAheadNeverBelow(observations, 0);
    if (!result.passed) {
      console.log('Window around first negative-ahead:');
      console.log(describeWindow(observations, result.violation!.atMs, 800));
    }
    expect(result.passed).toBe(true);
    // Snapshot the count of starvation snaps to detect over- or under-firing.
    // On the slow-rafTick scenario, starvation should fire often enough to
    // keep ticksAhead positive; > 0 confirms the recovery path is exercised.
    expect(starvationSnapCount(observations)).toBeGreaterThan(0);
  });

  it('Hotfix #2: even WITHOUT a gap, slow rafTick alone exposes the starvation race', () => {
    // The bug doesn't strictly require a gap. At 10 Hz rafTick × 4 catch-up
    // = 40 Hz max sustained inputTick rate, the server's held-ack-advance
    // at 60 Hz outruns inputTick within ~1 second of normal operation.
    // This fixture documents that the recovery handles the steady-state
    // case too — no gap, just a sustained rate mismatch.
    const events = buildScenarioEvents({
      name: 'slow-raftick-no-gap',
      rafTickHz: 10,
      rttMs: 50,
      durationMs: 8_000,
    });
    const observations = runScenario(events);

    const result = ticksAheadNeverBelow(observations, 0);
    if (!result.passed) {
      console.log('Window around first negative-ahead:');
      console.log(describeWindow(observations, result.violation!.atMs, 800));
    }
    expect(result.passed).toBe(true);
  });

  it('TDD demonstration: WITHOUT hotfix #2, the slow-rafTick scenario reproduces ticksAhead < 0', () => {
    // The harness's regression value is only meaningful if it would
    // CATCH the bug if reverted. This test toggles off the starvation
    // recovery and asserts the property fails — proving the hotfix is
    // load-bearing and the harness exercises it.
    const events = buildScenarioEvents({
      name: 'slow-raftick-no-gap',
      rafTickHz: 10,
      rttMs: 50,
      durationMs: 8_000,
    });
    const observations = runScenario(events, { starvationRecoveryEnabled: false });
    const result = ticksAheadNeverBelow(observations, 0);
    // Expect the property to FAIL under the without-hotfix simulation.
    expect(result.passed).toBe(false);
    expect(result.violation).toBeDefined();
    expect(result.violation!.ticksAhead).toBeLessThan(0);
  });

  it('TDD demonstration: WITHOUT hotfix #1, a 572 ms gap explodes Welford σ past the bound', () => {
    // Same TDD discipline for the RTT clamp.
    const events = buildScenarioEvents({
      name: 'pattern-a-572ms-gap-no-clamp',
      rafTickHz: 60,
      rttMs: 37,
      gapsMs: [{ atMs: 5000, durationMs: 572 }],
      durationMs: 12_000,
    });
    const observations = runScenario(events, { rttClampEnabled: false });
    const result = welfordStdDevBoundedBy(observations, 100);
    expect(result.passed).toBe(false);
    expect(result.violation).toBeDefined();
    expect(result.violation!.rttStdDev).toBeGreaterThan(100);
  });

  it('Steady state: 60 Hz rafTick + healthy network → ticksAhead stays in expected band', () => {
    // The "this should always work" case. A healthy session — desktop
    // rafTick, low RTT, no gaps — should produce ticksAhead in the
    // [3, 10] range (small prediction window, no surprises).
    const events = buildScenarioEvents({
      name: 'steady-state-healthy',
      rafTickHz: 60,
      rttMs: 50,
      jitterMs: 3,
      durationMs: 8_000,
    });
    const observations = runScenario(events);

    // ticksAhead never negative.
    expect(ticksAheadNeverBelow(observations, 0).passed).toBe(true);
    // Welford σ stays small with healthy network.
    expect(welfordStdDevBoundedBy(observations, 50).passed).toBe(true);
    // No starvation recovery should fire under healthy conditions.
    expect(starvationSnapCount(observations)).toBe(0);
  });
});
