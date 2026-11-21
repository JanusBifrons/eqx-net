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
 * Root cause then: the lead was sized from `Reconciler.lastRtt`, and the
 * snapshots after a gap carry an inflated `lastRtt` (the acked input was
 * sent before/during the gap, so `now − ackedRec.sentAt` includes it).
 *
 * The lead is now sized from the server-measured input margin, which is
 * taken when the input reaches the server — a receive gap never reaches it
 * and `lastRtt` is telemetry only. The lock: the same timeline with and
 * without the inflated `lastRtt` sizes the lead identically, and the lead
 * stays near the clean link's.
 */
import { describe, it, expect } from 'vitest';
import type { Event } from './types';
import { runScenario } from './runner';

/** A round-number "clean" RTT for synthetic events — well below clamp. */
const CLEAN_RTT_MS = 30;

/** What `Reconciler.lastRtt` reports during/after a gap. */
const GAP_LASTRTT_MS = 280;

const RAF_MS = 1000 / 60;

/** Build a steady 50 ms-cadence snapshot stream. Every input took the
 *  clean path; only `lastRtt` carries the pollution. */
function steadySnapshots(opts: {
  fromMs: number;
  fromTick: number;
  count: number;
  rttMs?: number;
}): Event[] {
  const events: Event[] = [];
  for (let i = 0; i < opts.count; i++) {
    const atMs = opts.fromMs + i * 50;
    events.push({
      type: 'snapshot',
      atMs,
      serverTick: opts.fromTick + i * 3,
      ackedTick: opts.fromTick + i * 3 - 1,
      lastRtt: opts.rttMs ?? CLEAN_RTT_MS,
      inputSentAtMs: atMs - CLEAN_RTT_MS,
    });
  }
  return events;
}

/** One gap snapshot, 300 ms after the last steady one. */
function gapSnapshot(atMs: number, serverTick: number, lastRtt: number): Event {
  return { type: 'snapshot', atMs, serverTick, ackedTick: serverTick - 1, lastRtt, inputSentAtMs: atMs - CLEAN_RTT_MS };
}

/** The device keeps rendering at 60 Hz through the timeline. */
function withRafTicks(snapshots: Event[]): Event[] {
  const endMs = snapshots[snapshots.length - 1]!.atMs;
  const events: Event[] = [...snapshots];
  for (let t = RAF_MS; t < endMs; t += RAF_MS) events.push({ type: 'rafTick', atMs: t, dtMs: RAF_MS });
  return events.sort((a, b) => a.atMs - b.atMs);
}

/** 30 clean → gap → 20 with inflated `lastRtt` → 30 clean. */
function singleGapTimeline(pollutedRttMs: number): Event[] {
  const gapAt = 30 * 50 + 300;
  return withRafTicks([
    ...steadySnapshots({ fromMs: 0, fromTick: 100, count: 30 }),
    gapSnapshot(gapAt, 100 + 30 * 3, pollutedRttMs === CLEAN_RTT_MS ? CLEAN_RTT_MS : 300),
    ...steadySnapshots({ fromMs: gapAt + 50, fromTick: 100 + 30 * 3 + 3, count: 20, rttMs: pollutedRttMs }),
    ...steadySnapshots({ fromMs: gapAt + 50 + 20 * 50, fromTick: 100 + 30 * 3 + 3 + 20 * 3, count: 30 }),
  ]);
}

/** Five cycles of 30 clean → gap → 20 polluted. */
function cyclesTimeline(pollutedRttMs: number): Event[] {
  const snaps: Event[] = [];
  let ms = 0;
  let tick = 100;
  for (let cycle = 0; cycle < 5; cycle++) {
    snaps.push(...steadySnapshots({ fromMs: ms, fromTick: tick, count: 30 }));
    ms += 30 * 50;
    tick += 30 * 3;
    snaps.push(gapSnapshot(ms + 250, tick, pollutedRttMs));
    ms += 250 + 50;
    tick += 3;
    snaps.push(...steadySnapshots({ fromMs: ms, fromTick: tick, count: 20, rttMs: pollutedRttMs }));
    ms += 20 * 50;
    tick += 20 * 3;
  }
  return withRafTicks(snaps);
}

const leadsAndMeans = (events: Event[]): string =>
  runScenario(events).map((o) => `${o.leadTicks}:${o.rttMean.toFixed(6)}`).join(' ');

describe('Welford mean — post-gap pollution', () => {
  it('an inflated lastRtt after a single gap does not move the lead at all', () => {
    expect(leadsAndMeans(singleGapTimeline(GAP_LASTRTT_MS))).toBe(leadsAndMeans(singleGapTimeline(CLEAN_RTT_MS)));
  });

  it('leadTicks does not saturate at the 30-tick ceiling after a single gap', () => {
    // Healthy 30 ms link: the lead sits at a few ticks; pollution used to
    // drive it to CEILING_TICKS.
    const observations = runScenario(singleGapTimeline(GAP_LASTRTT_MS));
    expect(observations[observations.length - 1]!.leadTicks).toBeLessThan(15);
  });

  it('repeated gap-pollution cycles do not move the lead or ratchet the mean', () => {
    expect(leadsAndMeans(cyclesTimeline(GAP_LASTRTT_MS))).toBe(leadsAndMeans(cyclesTimeline(CLEAN_RTT_MS)));
    const observations = runScenario(cyclesTimeline(GAP_LASTRTT_MS));
    // Clean path 30 ms + the 1-tick margin slop + up to a frame of claim
    // quantisation: well below the polluted ~85 ms+ of the old signal.
    expect(observations[observations.length - 1]!.rttMean).toBeLessThan(70);
  });
});
