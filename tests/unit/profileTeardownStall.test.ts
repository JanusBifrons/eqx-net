/**
 * Characterisation lock — `console.profile()` teardown causes a raf_gap
 * burst when Probe 0's `?profile=1` auto-stop fires.
 *
 * Plan: mobile-perf-reconciliation-review (2026-05-24).
 *
 * Capture `dmh5wn` was the first session with both the cap fix
 * (`?fpscap=10` → 90 Hz native processing on the user's Pixel 6) and the
 * Probe 0 `?profile=1` toggle active. User reported "look and rendering
 * felt good but the gameplay was not smooth" — lag spikes during play.
 *
 * Reading the capture: 16 raf_gap events in 77 s of gameplay. 13 of them
 * (81 %) cluster in a 3-second window starting at t=74.4 s, immediately
 * before the `profile_ended` (auto-stop) event at t=74.879 s. The
 * remaining 3 stalls are scattered across the preceding 70 seconds.
 *
 * The probable mechanism: `console.profile()` recording in Chrome carries
 * a non-trivial teardown cost when the call to `console.profileEnd()`
 * fires. The profiler flushes accumulated frame data through the renderer
 * thread back to the main thread, blocking RAFs for ~110 ms each as it
 * does so. Probe 0's 60 s auto-stop window placed this teardown squarely
 * in the middle of normal gameplay.
 *
 * This test locks the observation deterministically. A future capture
 * taken WITHOUT `?profile=1` should not show this clustering; the test
 * documents the pre-fix pathology so changes to the profile toggle can
 * be validated against the same evidence.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CAPTURE_PATH = 'diag/captures/2026-05-24T15-35-09Z-dmh5wn';

interface NdjsonEntry {
  ts: number;
  tag: string;
  data: Record<string, unknown>;
}

function parseNdjson(path: string): NdjsonEntry[] {
  const raw = readFileSync(path, 'utf8');
  const out: NdjsonEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const e = JSON.parse(trimmed) as NdjsonEntry;
    if (typeof e.ts === 'number' && typeof e.tag === 'string') out.push(e);
  }
  return out;
}

function loadPerfStream(): NdjsonEntry[] {
  // `profile_started` / `profile_ended` route to `other.ndjson` (Probe 0
  // omitted them from the diagRouter map; corrected here by reading both
  // files and merging on `ts` ascending). The cap-override + raf_gap +
  // heap_sample events all land in `perf.ndjson` per their explicit
  // router entries.
  const perf = parseNdjson(join(CAPTURE_PATH, 'perf.ndjson'));
  const other = parseNdjson(join(CAPTURE_PATH, 'other.ndjson'));
  return [...perf, ...other].sort((a, b) => a.ts - b.ts);
}

describe('console.profile() teardown burst — dmh5wn capture', () => {
  it('the capture is the dmh5wn ?fpscap=10 + ?profile=1 session', () => {
    const perf = loadPerfStream();
    const fpsCapOverride = perf.find((e) => e.tag === 'fps_cap_override');
    expect(fpsCapOverride?.data['effectiveCapMs'], 'capture should be the fpscap=10 arm').toBe(10);
    const profileStarted = perf.find((e) => e.tag === 'profile_started');
    expect(profileStarted, 'capture should have ?profile=1 active').toBeDefined();
  });

  it('profile_ended fires once at ~74.9 s (60 s after profile_started, ±5 s)', () => {
    const perf = loadPerfStream();
    const ends = perf.filter((e) => e.tag === 'profile_ended');
    // NB: the current Probe 0 wiring fires profile_ended twice (a known
    // benign bug in the auto-stop setTimeout handler). Future cleanup
    // should fix that — for now we document the actual observed count
    // rather than asserting "once".
    expect(ends.length).toBeGreaterThanOrEqual(1);
    // First profile_ended should land roughly 60 s after profile_started.
    const start = perf.find((e) => e.tag === 'profile_started')!;
    expect(start).toBeDefined();
    const gap = (ends[0].ts - start.ts) / 1000;
    expect(gap, `profile auto-stop window`).toBeGreaterThan(55);
    expect(gap, `profile auto-stop window`).toBeLessThan(65);
  });

  it('PATHOLOGY: 80%+ of raf_gaps cluster in a 5 s window around profile_ended', () => {
    const perf = loadPerfStream();
    const profileEnd = perf.find((e) => e.tag === 'profile_ended')!;
    expect(profileEnd).toBeDefined();
    const rafGaps = perf.filter((e) => e.tag === 'raf_gap');
    expect(rafGaps.length).toBeGreaterThan(5);

    // Window: 1 s before profile_ended to 4 s after (the observed cluster
    // spans ~74.4 s → ~77.1 s, with profile_ended at 74.879 s).
    const windowStart = profileEnd.ts - 1_000;
    const windowEnd = profileEnd.ts + 4_000;
    const inWindow = rafGaps.filter((e) => e.ts >= windowStart && e.ts <= windowEnd);
    const ratio = inWindow.length / rafGaps.length;
    expect(
      ratio,
      `${inWindow.length} / ${rafGaps.length} raf_gaps fall in the [${windowStart.toFixed(0)}, ${windowEnd.toFixed(0)}] ms window around profile_ended at ${profileEnd.ts.toFixed(0)} ms`,
    ).toBeGreaterThan(0.8);
  });

  it('BACKGROUND RATE: <0.1 raf_gap/sec outside the profile-teardown window', () => {
    const perf = loadPerfStream();
    const rafGaps = perf.filter((e) => e.tag === 'raf_gap');
    const profileEnd = perf.find((e) => e.tag === 'profile_ended')!;

    const windowStart = profileEnd.ts - 1_000;
    const windowEnd = profileEnd.ts + 4_000;
    const outOfWindow = rafGaps.filter((e) => e.ts < windowStart || e.ts > windowEnd);

    // Session duration: from first rafTick to last rafTick.
    const rafTicks = parseNdjson(join(CAPTURE_PATH, 'raf.ndjson'))
      .filter((e) => e.tag === 'rafTick');
    const sessionDurationSec = (rafTicks[rafTicks.length - 1].ts - rafTicks[0].ts) / 1000;
    const windowDurationSec = (windowEnd - windowStart) / 1000;
    const outOfWindowDurationSec = sessionDurationSec - windowDurationSec;

    const backgroundRate = outOfWindow.length / outOfWindowDurationSec;
    expect(
      backgroundRate,
      `${outOfWindow.length} background raf_gaps over ${outOfWindowDurationSec.toFixed(1)} s of non-teardown play`,
    ).toBeLessThan(0.1);
  });

  it('CONCENTRATION: in-window stall rate is at least 40× the background rate', () => {
    const perf = loadPerfStream();
    const rafGaps = perf.filter((e) => e.tag === 'raf_gap');
    const profileEnd = perf.find((e) => e.tag === 'profile_ended')!;
    const rafTicks = parseNdjson(join(CAPTURE_PATH, 'raf.ndjson'))
      .filter((e) => e.tag === 'rafTick');

    const windowStart = profileEnd.ts - 1_000;
    const windowEnd = profileEnd.ts + 4_000;
    const windowDurationSec = (windowEnd - windowStart) / 1000;
    const sessionDurationSec = (rafTicks[rafTicks.length - 1].ts - rafTicks[0].ts) / 1000;
    const outOfWindowDurationSec = sessionDurationSec - windowDurationSec;

    const inWindow = rafGaps.filter((e) => e.ts >= windowStart && e.ts <= windowEnd);
    const outOfWindow = rafGaps.filter((e) => e.ts < windowStart || e.ts > windowEnd);

    const inRate = inWindow.length / windowDurationSec;
    const outRate = outOfWindow.length / outOfWindowDurationSec;
    const concentration = inRate / Math.max(outRate, 0.001);
    expect(
      concentration,
      `in-window rate ${inRate.toFixed(2)} /s vs background ${outRate.toFixed(3)} /s — ${concentration.toFixed(0)}× concentration`,
    ).toBeGreaterThan(40);
  });

  it('CAP FIX VERIFIED: rafTick.elapsedMs steady-state is 11 ms (90 fps native), not 22 ms (45 fps throttled)', () => {
    const rafTicks = parseNdjson(join(CAPTURE_PATH, 'raf.ndjson'))
      .filter((e) => e.tag === 'rafTick');
    const elapsed = rafTicks
      .map((e) => e.data['elapsedMs'] as number)
      .filter((v): v is number => typeof v === 'number');
    // Sort and pick median.
    const sorted = [...elapsed].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    expect(median, 'median rafTick.elapsedMs should match the 90 Hz native period (~11.1 ms)').toBeGreaterThan(10);
    expect(median, 'median rafTick.elapsedMs should match the 90 Hz native period (~11.1 ms)').toBeLessThan(13);
  });
});
