/**
 * Regression lock — Phase 1 of perf-floor session 3 (plan: perf-floor).
 *
 * Streams on-device captures (vg9hon idle-bufferbloat, ers7xy active-
 * bufferbloat) through the deterministic scenario harness and asserts
 * the prediction-stat pipeline produces a bounded `ticksAhead`. On
 * `f59b9ac` (current HEAD) the harness produces sustained
 * meanTicksAhead 138-186 and maxTicksAhead 228-371 — these tests
 * SHOULD FAIL. A fix that turns them green is the load-bearing change.
 *
 * Why these tests exist: the user-reported "worse than ever" mobile
 * spiral was not reproduced by the existing keyboard-only desktop
 * specs (spiral-joystick-flicker, spiral-in-pack-density,
 * spiral-disconnect-reconnect, prediction-idle-bounded). The on-device
 * captures' snapshot streams ARE the deterministic load signature; the
 * existing tests/scenarios/runner.ts state machine consumes them
 * verbatim and reproduces the same ticksAhead climb the user observed.
 *
 * Phase 0.3 finding: on-device intervalMs clusters at 50-75 ms (within
 * hotfix #3's filter band, NOT outside it) — so the spiral happens
 * despite Welford being fed valid samples. The leadTicks output stays
 * at ~25 (below CEILING_TICKS=30); the dominant cause of ticksAhead
 * growth is the wall-clock-anchored inputTick advancing faster than
 * the server's ackedTick can keep up under mobile burst-transit.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { replayOndeviceSnapshots } from './ondeviceReplay';

const ROOT = process.cwd();

function loadCapture(dirName: string): string {
  return readFileSync(
    join(ROOT, 'diag', 'captures', dirName, 'snapshots.ndjson'),
    'utf8',
  );
}

const VG9HON = '2026-05-20T22-37-34-348Z-vg9hon';
const ERS7XY = '2026-05-20T22-47-58-606Z-ers7xy';

describe('on-device spiral replay (perf-floor session 3, Phase 1 regression lock)', () => {
  it('vg9hon idle-bufferbloat: ticksAhead stays bounded post-warmup', () => {
    const raw = loadCapture(VG9HON);
    const stats = replayOndeviceSnapshots(raw, { warmupMs: 5_000 });

    // Liveness: harness consumed the capture
    expect(stats.snapshotCount, 'capture must have snapshots').toBeGreaterThan(40);
    expect(
      stats.postWarmupObservationCount,
      'post-warmup window must have observations',
    ).toBeGreaterThan(100);

    // The regression lock — on f59b9ac max~228 / mean~138; with the
    // MAX_TICKS_AHEAD=50 cap, steady-state under spiral is at the cap,
    // so both metrics land just above 50.
    expect(
      stats.maxTicksAhead,
      `vg9hon maxTicksAhead must stay <60 (was ${stats.maxTicksAhead}) — sustained ticksAhead climb under idle mobile load`,
    ).toBeLessThan(60);
    expect(
      stats.meanTicksAhead,
      `vg9hon meanTicksAhead must stay <55 (was ${stats.meanTicksAhead.toFixed(1)}) — sustained spiral, not at-cap steady-state`,
    ).toBeLessThan(55);
  });

  it('ers7xy active-bufferbloat: ticksAhead stays bounded post-warmup', () => {
    const raw = loadCapture(ERS7XY);
    const stats = replayOndeviceSnapshots(raw, { warmupMs: 5_000 });

    expect(stats.snapshotCount, 'capture must have snapshots').toBeGreaterThan(40);
    expect(
      stats.postWarmupObservationCount,
      'post-warmup window must have observations',
    ).toBeGreaterThan(100);

    // On f59b9ac max~371 / mean~186; with the MAX_TICKS_AHEAD=50 cap,
    // steady-state under spiral is at the cap.
    expect(
      stats.maxTicksAhead,
      `ers7xy maxTicksAhead must stay <60 (was ${stats.maxTicksAhead}) — sustained ticksAhead climb under active mobile load`,
    ).toBeLessThan(60);
    expect(
      stats.meanTicksAhead,
      `ers7xy meanTicksAhead must stay <55 (was ${stats.meanTicksAhead.toFixed(1)}) — sustained spiral, not at-cap steady-state`,
    ).toBeLessThan(55);
  });
});
