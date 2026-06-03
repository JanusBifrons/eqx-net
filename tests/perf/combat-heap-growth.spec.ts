/**
 * Combat-driven heap-growth regression lock — reproduces the
 * "smooth then sudden stalls" pattern the user reported on 2026-05-25.
 *
 * Phone capture lnnkkh: 1.2 MB/s heap growth under combat → V8 major
 * GC every ~20 s → 111 ms `raf_gap` stalls correlated with heap drops.
 * The pre-existing heap-growth-gate.spec.ts uses test-sector with NO
 * combat — it shows ~0.28 MB/s and never reproduces the stall pattern.
 *
 * This spec adds the combat workload that drives the actual allocation
 * pressure on the phone:
 *   - room: `feel-test-25` (25 drones, no asteroids — same room the
 *     netgate uses, matches the user's sol-prime smoke profile)
 *   - hold Space for 20 s of continuous fire (predicted hits → damage
 *     numbers / hit_acks / explosion sprites)
 *   - read heap_sample + raf_gap events from the diag log
 *
 * Expected (pre-fix, what we WANT this test to detect):
 *   - heap growth slope > 0.5 MB/s
 *   - at least 1 raf_gap event (V8 major GC stall) over the 20s window
 *   - heap delta at the raf_gap > 5 MB (the major-GC sawtooth signature)
 *
 * Once a fix lands, the assertion tightens: slope < 0.3 MB/s, zero or
 * one raf_gap. The 4 client-allocation commits (82ee32a..57bfcbf) cover
 * snapshot-handling; this test targets the COMBAT path which the
 * handoff line 204 lists as `pendingDamageNumbers` (still un-pooled).
 *
 * Per project invariant #13: this test must FAIL on current code first;
 * the fix that turns it GREEN is the load-bearing change.
 */
import { test, expect, chromium } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface HeapSample {
  ts: number;
  heap: number;
}

interface RafGapEvent {
  ts: number;
  elapsedMs: number;
  heapUsedMb: number;
  heapDeltaMbSinceLastStall: number | null;
}

interface CombatStats {
  heap: {
    sampleCount: number;
    firstMb: number;
    lastMb: number;
    durationS: number;
    growthMbPerSec: number;
    slopeMbPerSec: number;
    peakMb: number;
  };
  stalls: {
    rafGapCount: number;
    rafStutterCount: number;
    maxStallElapsedMs: number;
    maxHeapDeltaAtStall: number;
    events: RafGapEvent[];
  };
  combat: {
    fireCount: number;
    damageNumberSpawnCount: number;
  };
}

test('combat repro: 20s of held-fire on 25 drones drives heap-growth-stall pattern', async () => {
  test.setTimeout(60_000);

  // Dedicated browser with --enable-precise-memory-info so
  // performance.memory.usedJSHeapSize returns trend-detectable values.
  // (Shared fixture browser doesn't have this flag — heap_sample logs
  // a bucketed constant without it; see heap-growth-gate.spec.ts.)
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // feel-test-25: 25 drones, no asteroids. testId for room isolation
  // so parallel runs don't share state. diag=1 so heap_sample fires.
  // testMode is on the room definition (server/index.ts), so client
  // joins inherit it.
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `combat-heap-${Date.now()}`,
    spawnX: '0',
    spawnY: '0',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );

  // 3s warmup — bots distribute, first snapshots arrive, predWorld
  // bootstraps. Without this the initial-correction spike dominates.
  await page.waitForTimeout(3000);
  await page.evaluate(() => (window as unknown as { __eqxClearLogs?: () => void }).__eqxClearLogs?.());

  // 20s of held-fire — drives predictShotOutcome per cooldown tick,
  // each predicted hit fires damage_number_scheduled +
  // damage_number_spawned (the handoff line 204 suspect allocator).
  await page.keyboard.down('Space');
  await page.waitForTimeout(20_000);
  await page.keyboard.up('Space');

  // Drain a final RAF before reading logs.
  await page.waitForTimeout(200);

  const stats = await page.evaluate((): CombatStats => {
    const logs = (window as unknown as { __eqxLogs?: { ts: number; tag: string; data: Record<string, unknown> }[] }).__eqxLogs ?? [];
    const heapSamples: HeapSample[] = logs
      .filter((e) => e.tag === 'heap_sample')
      .map((e) => ({ ts: e.ts, heap: e.data['heapUsedMb'] as number }));
    const rafGaps: RafGapEvent[] = logs
      .filter((e) => e.tag === 'raf_gap')
      .map((e) => ({
        ts: e.ts,
        elapsedMs: e.data['elapsedMs'] as number,
        heapUsedMb: e.data['heapUsedMb'] as number,
        heapDeltaMbSinceLastStall: e.data['heapDeltaMbSinceLastStall'] as number | null,
      }));
    const rafStutterCount = logs.filter((e) => e.tag === 'raf_stutter').length;
    const fireCount = logs.filter((e) => e.tag === 'fire').length;
    const damageNumberSpawnCount = logs.filter((e) => e.tag === 'damage_number_spawned').length;

    // Stats
    let slopeMbPerSec = 0;
    if (heapSamples.length >= 2) {
      const meanX = heapSamples.reduce((s, p) => s + p.ts, 0) / heapSamples.length;
      const meanY = heapSamples.reduce((s, p) => s + p.heap, 0) / heapSamples.length;
      let num = 0;
      let den = 0;
      for (const p of heapSamples) {
        num += (p.ts - meanX) * (p.heap - meanY);
        den += (p.ts - meanX) ** 2;
      }
      slopeMbPerSec = den > 0 ? (num / den) * 1000 : 0;
    }
    const first = heapSamples[0] ?? { ts: 0, heap: 0 };
    const last = heapSamples[heapSamples.length - 1] ?? { ts: 0, heap: 0 };
    const durationS = (last.ts - first.ts) / 1000;
    const peakMb = heapSamples.reduce((m, p) => (p.heap > m ? p.heap : m), 0);
    const maxStallElapsedMs = rafGaps.reduce((m, e) => (e.elapsedMs > m ? e.elapsedMs : m), 0);
    const maxHeapDeltaAtStall = rafGaps.reduce(
      (m, e) => (e.heapDeltaMbSinceLastStall !== null && e.heapDeltaMbSinceLastStall > m ? e.heapDeltaMbSinceLastStall : m),
      0,
    );

    return {
      heap: {
        sampleCount: heapSamples.length,
        firstMb: first.heap,
        lastMb: last.heap,
        durationS,
        growthMbPerSec: durationS > 0 ? (last.heap - first.heap) / durationS : 0,
        slopeMbPerSec,
        peakMb,
      },
      stalls: {
        rafGapCount: rafGaps.length,
        rafStutterCount,
        maxStallElapsedMs,
        maxHeapDeltaAtStall,
        events: rafGaps,
      },
      combat: { fireCount, damageNumberSpawnCount },
    };
  });

  await ctx.close();
  await browser.close();

  // eslint-disable-next-line no-console
  console.log('\n=== Combat-heap-growth repro ===');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(stats, null, 2));

  // Sanity — page didn't completely freeze (we need SOME fire events
  // to know combat was happening; the page can stall so hard under
  // broken state that even keyboard.down isn't processed for many
  // ticks, so threshold is low — just proof of combat presence).
  expect(stats.combat.fireCount).toBeGreaterThan(2);
  expect(stats.heap.sampleCount).toBeGreaterThan(30);

  // Per invariant #13 — assertions must FAIL on broken code and turn
  // GREEN once the fix lands. Current (broken) state on 599aef8 + 4
  // safe-step commits 82ee32a..57bfcbf produces:
  //   slope        = 0.67 MB/s
  //   rafGapCount  = 55 (over 20s = major GC every ~360ms)
  //   maxStallMs   = 200
  //   maxHeapDelta = 21 MB (textbook sawtooth)
  //
  // Targets (each FAILS now, expected to GREEN with the combat-path
  // allocation fix — handoff line 204 suspect: pendingDamageNumbers,
  // plus whatever fires per-fire even without hits):
  expect(stats.heap.slopeMbPerSec, 'heap growth slope under combat (target: ≤ 0.4 MB/s)').toBeLessThan(0.4);
  expect(stats.stalls.rafGapCount, 'major-GC stall events over 20s combat (target: ≤ 10)').toBeLessThan(10);
  expect(stats.stalls.maxStallElapsedMs, 'worst single stall (target: ≤ 150 ms)').toBeLessThan(150);
});
