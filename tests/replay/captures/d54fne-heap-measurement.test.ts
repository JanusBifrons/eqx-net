/**
 * Heap-measurement replay — drives `d54fne` (the capture the user just
 * analysed; 48 s of real combat play, diag=0 / autocapture=1) through the
 * real `ColyseusGameClient` via the replay harness and reports the
 * resulting allocation profile.
 *
 * Why this exists (2026-05-26): the existing E2E `combat-heap-growth.spec`
 * runs Playwright against `feel-test-25` (25 hostile drones). The
 * drones kill the player before they land hits, so
 * `damageNumberSpawnCount` is 0 in both arms — the spec measures the
 * snapshot-handling overhead, not the combat-path allocations the
 * d54fne capture actually exhibited. The pooling fixes (2026-05-26
 * heap-growth gate step 11) are invisible in that spec because both
 * runs use `?diag=1` (which keeps HIGH_VOLUME_TAGS) and the combat
 * surface never engages.
 *
 * This test drives the real production code path through real captured
 * inputs + snapshots in Node, with the default Node env (no URL → diag
 * resolves to `false`, identical to a phone with no flag). The numbers
 * it reports DIRECTLY measure the gate-inversion + scratch-pooling
 * effect on the production code path.
 *
 * Not a regression gate — pure measurement. Prints per-tag ring counts
 * + heap delta. Run with `--expose-gc` for cleaner heap numbers, but
 * the per-tag count is GC-free and always reliable.
 *
 * Comparison protocol: run once with HEAD, stash the pooling fixes,
 * run baseline, pop the stash, diff the printouts.
 */
import { describe, it, expect } from 'vitest';
import { replayCapture } from '../captureHarness';
import {
  getRingEntries,
  __resetDiagCache,
  isDiagEnabled,
} from '../../../src/client/debug/ClientLogger';

const CAPTURE_PATH = 'diag/captures/2026-05-25T21-45-49Z-d54fne';

// V8 exposes `global.gc()` only with `--expose-gc`. We probe and
// fall back silently — the ring-entry counts remain authoritative.
function tryGc(): boolean {
  const g = (global as unknown as { gc?: () => void }).gc;
  if (typeof g === 'function') {
    g();
    return true;
  }
  return false;
}

interface TagCount {
  tag: string;
  count: number;
}

function countByTag(entries: readonly { tag: string }[]): TagCount[] {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.tag, (m.get(e.tag) ?? 0) + 1);
  return [...m.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

describe('d54fne heap-measurement replay (2026-05-26 pooling fix verification)', () => {
  it('replays the captured session, prints per-tag ring counts + heap delta', async () => {
    // Reset diag latches so the default-Node (no `window`, no URL)
    // resolution path is reproducible. In Node, `isDiagEnabled()`
    // returns `false` and `isFullDiagMode()` returns `false`, which is
    // the production-parity path my gate inversion is supposed to
    // benefit. Confirm before measuring.
    __resetDiagCache();
    // In Node (no window, no navigator.webdriver) isDiagEnabled() resolves
    // to false — production-parity mode. The gate-inversion fix changes
    // logEvent's HIGH_VOLUME_TAGS behaviour in this mode; baseline does not.
    expect(isDiagEnabled(), 'measurement runs in production-parity mode (no URL params, no webdriver)').toBe(false);

    // Clear the ring buffer so we measure only the replay's emissions.
    (getRingEntries() as unknown as { length: number }).length = 0;

    // Force GC if available, then snapshot heap.
    const gcAvailable = tryGc();
    const heapBeforeMb = process.memoryUsage().heapUsed / 1024 / 1024;
    const startWallMs = performance.now();

    // Drive the real ColyseusGameClient through the captured timeline.
    // d54fne is ~48 s of real combat play (43 fires, 21 predicted hits,
    // 1 cancellation, ~760 snapshots, ~3000 rafTicks on the original
    // device). The replay reproduces the snapshot + input streams
    // through the real handleSnapshot / tickPhysics / updateMirror
    // path. Combat events (DamageEvent, hit_ack) are NOT replayed —
    // the harness uses MockRoom which doesn't carry them — but the
    // 80%+ of allocation pressure that's snapshot/RAF-driven IS
    // exercised here, including all four of the 2026-05-26 fixes
    // that touch the snapshot path:
    //   - HIGH_VOLUME_TAGS gate inversion (rafTick / input_intent /
    //     local_pose_*/inputSent dropped in prod mode)
    //   - recPositions scratch pooling
    //   - px/pa closure hoist
    //   - setDevData drawer-tab gate

    // Sample heap during the replay. Without --expose-gc we can't force
    // a clean baseline between samples, so the per-sample delta is
    // contaminated by V8's incremental GC scheduling — but the SHAPE of
    // the curve (where spikes happen, how many large jumps occur) is
    // still meaningful. Sample every 50 captured events (~1.5 sec of
    // simulated time at ~30 events/sec average) so the sample density
    // matches the original capture's heap_sample rate (~12 Hz).
    interface HeapSample { eventIndex: number; tsMs: number; heapMb: number; }
    const heapSamples: HeapSample[] = [];
    const SAMPLE_EVERY_N_EVENTS = 50;
    const trace = await replayCapture(CAPTURE_PATH, {
      onEvent: (eventIndex, ev) => {
        if (eventIndex % SAMPLE_EVERY_N_EVENTS === 0) {
          heapSamples.push({
            eventIndex,
            tsMs: ev.ts,
            heapMb: process.memoryUsage().heapUsed / 1024 / 1024,
          });
        }
      },
    });

    const wallMs = performance.now() - startWallMs;
    tryGc();
    const heapAfterMb = process.memoryUsage().heapUsed / 1024 / 1024;

    const entries = getRingEntries();
    const tagCounts = countByTag(entries);

    // Synthesised RAFs / snapshots from the trace.
    const rafTickCount = trace.events.filter((e) => e.kind === 'rafTick').length;
    const snapshotCount = trace.events.filter((e) => e.kind === 'snapshot').length;
    const inputIntentCount = trace.events.filter((e) => e.kind === 'input_intent').length;
    const simulatedSec = trace.events.length > 0
      ? (trace.events[trace.events.length - 1]!.ts - trace.events[0]!.ts) / 1000
      : 0;

    // eslint-disable-next-line no-console
    console.log('\n=== d54fne replay heap-measurement ===');
    // eslint-disable-next-line no-console
    console.log(`capture path        : ${CAPTURE_PATH}`);
    // eslint-disable-next-line no-console
    console.log(`replay wall time    : ${wallMs.toFixed(0)} ms`);
    // eslint-disable-next-line no-console
    console.log(`captured timeline   : ${simulatedSec.toFixed(1)} s of simulated session`);
    // eslint-disable-next-line no-console
    console.log(`input rafTicks      : ${rafTickCount} (captured)`);
    // eslint-disable-next-line no-console
    console.log(`input snapshots     : ${snapshotCount} (captured)`);
    // eslint-disable-next-line no-console
    console.log(`input intents       : ${inputIntentCount} (captured)`);
    // eslint-disable-next-line no-console
    console.log(`heap before/after   : ${heapBeforeMb.toFixed(2)} → ${heapAfterMb.toFixed(2)} MB (delta ${(heapAfterMb - heapBeforeMb).toFixed(2)} MB)${gcAvailable ? ' [GC forced]' : ' [no --expose-gc, GC not forced]'}`);
    // eslint-disable-next-line no-console
    console.log(`ring total entries  : ${entries.length}`);
    // eslint-disable-next-line no-console
    console.log(`ring entries / sec  : ${simulatedSec > 0 ? (entries.length / simulatedSec).toFixed(1) : 'n/a'} (per simulated second)`);
    // eslint-disable-next-line no-console
    console.log('\nper-tag breakdown (top 25):');
    for (const { tag, count } of tagCounts.slice(0, 25)) {
      const ratePerSec = simulatedSec > 0 ? (count / simulatedSec).toFixed(1) : 'n/a';
      // eslint-disable-next-line no-console
      console.log(`  ${String(count).padStart(6)}  ${ratePerSec.padStart(6)}/s   ${tag}`);
    }

    // Spike analysis — per-sample heap deltas reveal where allocation
    // spiked during the replay. The user's d54fne capture showed top
    // spikes of 5-6 MB / 70 ms; this test reports the equivalent in
    // Node V8 across the same captured event stream.
    const deltas: { fromEventIndex: number; toEventIndex: number; deltaMb: number; simSecMark: number }[] = [];
    for (let i = 1; i < heapSamples.length; i++) {
      const prev = heapSamples[i - 1]!;
      const cur = heapSamples[i]!;
      const delta = cur.heapMb - prev.heapMb;
      if (delta > 0) {
        deltas.push({
          fromEventIndex: prev.eventIndex,
          toEventIndex: cur.eventIndex,
          deltaMb: delta,
          simSecMark: (cur.tsMs - (trace.events[0]?.ts ?? 0)) / 1000,
        });
      }
    }
    deltas.sort((a, b) => b.deltaMb - a.deltaMb);
    const totalGrowth = deltas.reduce((s, d) => s + d.deltaMb, 0);
    const spikesAbove1Mb = deltas.filter((d) => d.deltaMb > 1).length;
    const spikesAbove3Mb = deltas.filter((d) => d.deltaMb > 3).length;
    const spikesAbove5Mb = deltas.filter((d) => d.deltaMb > 5).length;
    // eslint-disable-next-line no-console
    console.log(`\nheap-sample window  : ${heapSamples.length} samples over ${SAMPLE_EVERY_N_EVENTS}-event intervals (~${simulatedSec > 0 && heapSamples.length > 1 ? ((simulatedSec / (heapSamples.length - 1)) * 1000).toFixed(0) : 'n/a'} ms each in sim time)`);
    // eslint-disable-next-line no-console
    console.log(`positive-delta sum  : ${totalGrowth.toFixed(2)} MB (= gross allocation between GCs)`);
    // eslint-disable-next-line no-console
    console.log(`spikes > 1 MB / 3 MB / 5 MB: ${spikesAbove1Mb} / ${spikesAbove3Mb} / ${spikesAbove5Mb}`);
    // eslint-disable-next-line no-console
    console.log('\ntop 10 heap spikes (per sample interval):');
    for (const d of deltas.slice(0, 10)) {
      // eslint-disable-next-line no-console
      console.log(`  +${d.deltaMb.toFixed(2)} MB at sim t=${d.simSecMark.toFixed(2)}s (events ${d.fromEventIndex}→${d.toEventIndex})`);
    }
    // eslint-disable-next-line no-console
    console.log('');

    // Sanity: the replay must have produced SOME ring entries (the
    // always-on tags like `correction` / `snapshot_received` fire on
    // every snapshot and aren't gated). If this is 0 the harness
    // failed silently.
    expect(entries.length).toBeGreaterThan(0);
    expect(trace.finalStats.snapshotCount).toBeGreaterThan(50);
  }, 120_000);
});
