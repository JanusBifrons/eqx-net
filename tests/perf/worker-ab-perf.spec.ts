/**
 * Worker-renderer A/B perf comparison — challenges the 2026-05-22 touch-default.
 *
 * The 2026-05-22 phone smoke pair (capture `721mwk` worker-on vs
 * `iph9cv` worker-off, same device same session) showed a 19× reduction
 * in `raf_gap > 100 ms` events (38 → 3) WITHOUT the worker on Android.
 * The IPC commit tail-latency (~110 ms) dwarfed the render-cost saving
 * (~1.5 ms / frame). That set the touch default to main-thread.
 *
 * Since then we landed substantial per-frame allocation reductions
 * (plan combat-fx-hunt 2026-05-31): HealthBars / BackgroundGrid /
 * liveBeam / remoteBeam per-frame Pixi rebuild → dirty-flag caches;
 * pendingMissileExplosions worker-clone fix; DamageNumberManager
 * accumulator (Step 4 melodic-engelbart). These reduce per-frame
 * work in BOTH modes, but change the relative trade-off — the worker
 * now offloads less work for the same IPC tax.
 *
 * This spec is a DESKTOP A/B. The original finding was on Android
 * phone hardware; desktop postMessage IPC is much faster, so this
 * test is NOT a decisive falsifier of the touch default. It IS a
 * useful first signal — if desktop A/B shows worker materially
 * better than main-thread under combat load with current code, the
 * touch default deserves a fresh phone smoke pair (the decisive test).
 *
 * METRICS (per CLAUDE.md "smoke MUST measure raf_gap clusters, not
 * just frame time"):
 *   - raf_gap count + max elapsedMs (RafStallDetector, fires below diag-light)
 *   - raf_stutter count
 *   - longtask count + max durationMs (PerformanceObserver)
 *   - loaf count + max durationMs (Long Animation Frame Timing)
 *   - heap_sample slope MB/s
 *   - fire count (sanity — proves combat actually happened)
 *
 * SCENARIO: feel-test-25 room (25 drones, no asteroids), 15 s of
 * held-fire after 3 s warmup. Mirrors combat-heap-growth.spec.ts (the
 * canonical 25-drone hold-fire spec that gets 80+ fires per rep).
 * NOTE: an earlier iteration of this spec used `startHostile=1`,
 * which killed the player within ~2 s of the fire-window starting
 * and short-circuited `sendFire` via `localDead=true` (yielding 0
 * fires/rep, useless data). The 2026-05-22 finding was about render
 * load and IPC tail-latency, not specifically "drones shooting" —
 * held-fire on 25 visible drones drives the same combat work-load
 * (predicted hits → damage numbers → explosion sprites → mount
 * rotation telemetry → beam re-stroke) without the suicide problem.
 *
 * Interleaved 4 reps A-B-A-B-A-B-A-B (mirrors netgate's variance-control
 * pattern). Fresh chromium context per rep to avoid GC state crossing
 * arms.
 *
 * Total runtime ≈ 8 reps × ~24 s = ~3.5 min. Run with explicit
 * timeout 4 min: `pnpm e2e --project=feature tests/e2e/worker-ab-perf.spec.ts --reporter=line`.
 */
import { test, expect, chromium, type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const OUT_DIR = 'diag/measurements/2026-05-31-worker-ab';
const REPS_PER_ARM = 4;
const FIRE_DURATION_MS = 15_000;
const WARMUP_MS = 3000;

interface RepStats {
  arm: 'worker=0' | 'worker=1';
  rep: number;
  durationS: number;
  rafGapCount: number;
  rafGapMaxMs: number;
  rafStutterCount: number;
  longtaskCount: number;
  longtaskMaxMs: number;
  longtaskTotalMs: number;
  loafCount: number;
  loafMaxMs: number;
  loafBlockingTotalMs: number;
  heapSlopeMbPerSec: number;
  heapPeakMb: number;
  heapSampleCount: number;
  fireCount: number;
}

async function runOneRep(
  browser: Browser,
  arm: 'worker=0' | 'worker=1',
  rep: number,
): Promise<RepStats> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  // GC before each rep so heap baselines are comparable.
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});

  const workerFlag = arm === 'worker=0' ? '0' : '1';
  // Mirror combat-heap-growth.spec.ts' working pattern: feel-test-25,
  // diag=1, 3s warmup after ship-count > 0, then held-fire. NO
  // startHostile (its first iteration here killed the player → 0 fires
  // because sendFire short-circuits on `localDead`).
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `worker-ab-${arm}-${rep}-${Date.now()}`,
    spawnX: '0',
    spawnY: '0',
    worker: workerFlag,
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );
  await page.waitForTimeout(WARMUP_MS);
  await page.evaluate(() =>
    (window as unknown as { __eqxClearLogs?: () => void }).__eqxClearLogs?.(),
  );

  await page.keyboard.down('Space');
  await page.waitForTimeout(FIRE_DURATION_MS);
  await page.keyboard.up('Space');
  await page.waitForTimeout(200);

  const stats = await page.evaluate(
    ({ arm: _arm, rep: _rep }) => {
      type Entry = { ts: number; tag: string; data: Record<string, unknown> };
      const logs =
        (window as unknown as { __eqxLogs?: Entry[] }).__eqxLogs ?? [];

      const rafGaps = logs.filter((e) => e.tag === 'raf_gap');
      const rafStutters = logs.filter((e) => e.tag === 'raf_stutter');
      const longtasks = logs.filter((e) => e.tag === 'longtask');
      const loafs = logs.filter((e) => e.tag === 'loaf');
      const heapSamples = logs
        .filter((e) => e.tag === 'heap_sample')
        .map((e) => ({ ts: e.ts, heap: e.data['heapUsedMb'] as number }));
      const fires = logs.filter((e) => e.tag === 'fire');

      let slopeMbPerSec = 0;
      if (heapSamples.length >= 2) {
        const meanX =
          heapSamples.reduce((s, p) => s + p.ts, 0) / heapSamples.length;
        const meanY =
          heapSamples.reduce((s, p) => s + p.heap, 0) / heapSamples.length;
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

      const longtaskMs = longtasks.map((e) => e.data['durationMs'] as number);
      const loafMs = loafs.map((e) => e.data['durationMs'] as number);
      const loafBlockingMs = loafs
        .map((e) => (e.data['blockingDurationMs'] as number | null) ?? 0)
        .filter((m): m is number => typeof m === 'number');
      const rafGapMs = rafGaps.map((e) => e.data['elapsedMs'] as number);

      return {
        arm: _arm,
        rep: _rep,
        durationS: (last.ts - first.ts) / 1000,
        rafGapCount: rafGaps.length,
        rafGapMaxMs: rafGapMs.reduce((m, v) => (v > m ? v : m), 0),
        rafStutterCount: rafStutters.length,
        longtaskCount: longtasks.length,
        longtaskMaxMs: longtaskMs.reduce((m, v) => (v > m ? v : m), 0),
        longtaskTotalMs: longtaskMs.reduce((s, v) => s + v, 0),
        loafCount: loafs.length,
        loafMaxMs: loafMs.reduce((m, v) => (v > m ? v : m), 0),
        loafBlockingTotalMs: loafBlockingMs.reduce((s, v) => s + v, 0),
        heapSlopeMbPerSec: slopeMbPerSec,
        heapPeakMb: heapSamples.reduce((m, p) => (p.heap > m ? p.heap : m), 0),
        heapSampleCount: heapSamples.length,
        fireCount: fires.length,
      };
    },
    { arm, rep },
  );

  await ctx.close();
  return stats as RepStats;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function aggregate(reps: RepStats[]): Record<string, number> {
  return {
    rafGapCount: median(reps.map((r) => r.rafGapCount)),
    rafGapMaxMs: median(reps.map((r) => r.rafGapMaxMs)),
    rafStutterCount: median(reps.map((r) => r.rafStutterCount)),
    longtaskCount: median(reps.map((r) => r.longtaskCount)),
    longtaskMaxMs: median(reps.map((r) => r.longtaskMaxMs)),
    longtaskTotalMs: median(reps.map((r) => r.longtaskTotalMs)),
    loafCount: median(reps.map((r) => r.loafCount)),
    loafMaxMs: median(reps.map((r) => r.loafMaxMs)),
    loafBlockingTotalMs: median(reps.map((r) => r.loafBlockingTotalMs)),
    heapSlopeMbPerSec: median(reps.map((r) => r.heapSlopeMbPerSec)),
    heapPeakMb: median(reps.map((r) => r.heapPeakMb)),
    fireCount: median(reps.map((r) => r.fireCount)),
  };
}

function pct(a: number, b: number): string {
  if (a === 0 && b === 0) return '0%';
  if (a === 0) return '+∞';
  const delta = ((b - a) / a) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`;
}

test('worker A/B perf comparison — 4 reps each arm interleaved', async () => {
  test.setTimeout(360_000); // 6 min ceiling (~3.5 min expected)
  const browser = await chromium.launch({
    args: ['--enable-precise-memory-info'],
  });

  const reps: RepStats[] = [];
  for (let i = 0; i < REPS_PER_ARM; i++) {
    // eslint-disable-next-line no-console
    console.log(`\n--- rep ${i + 1}/${REPS_PER_ARM} arm A (worker=0) ---`);
    reps.push(await runOneRep(browser, 'worker=0', i + 1));
    // eslint-disable-next-line no-console
    console.log(`\n--- rep ${i + 1}/${REPS_PER_ARM} arm B (worker=1) ---`);
    reps.push(await runOneRep(browser, 'worker=1', i + 1));
  }
  await browser.close();

  const armA = reps.filter((r) => r.arm === 'worker=0');
  const armB = reps.filter((r) => r.arm === 'worker=1');
  const aggA = aggregate(armA);
  const aggB = aggregate(armB);

  const lines: string[] = [
    '# Worker A/B perf comparison',
    '',
    `**Date**: ${new Date().toISOString()}`,
    `**Reps per arm**: ${REPS_PER_ARM} (interleaved A-B-A-B...)`,
    `**Scenario**: feel-test-25 (25 drones, no asteroids), ${FIRE_DURATION_MS / 1000}s held-fire after ${WARMUP_MS / 1000}s warmup`,
    `**Sanity**: A fire-count median = ${aggA['fireCount']}, B = ${aggB['fireCount']}`,
    '',
    '## Median per arm (lower is better unless noted)',
    '',
    '| Metric | worker=0 (main-thread) | worker=1 (worker) | Δ (B vs A) |',
    '|---|---:|---:|---:|',
    `| raf_gap count | ${aggA['rafGapCount']} | ${aggB['rafGapCount']} | ${pct(aggA['rafGapCount']!, aggB['rafGapCount']!)} |`,
    `| raf_gap max ms | ${aggA['rafGapMaxMs']!.toFixed(1)} | ${aggB['rafGapMaxMs']!.toFixed(1)} | ${pct(aggA['rafGapMaxMs']!, aggB['rafGapMaxMs']!)} |`,
    `| raf_stutter count | ${aggA['rafStutterCount']} | ${aggB['rafStutterCount']} | ${pct(aggA['rafStutterCount']!, aggB['rafStutterCount']!)} |`,
    `| longtask count | ${aggA['longtaskCount']} | ${aggB['longtaskCount']} | ${pct(aggA['longtaskCount']!, aggB['longtaskCount']!)} |`,
    `| longtask max ms | ${aggA['longtaskMaxMs']!.toFixed(1)} | ${aggB['longtaskMaxMs']!.toFixed(1)} | ${pct(aggA['longtaskMaxMs']!, aggB['longtaskMaxMs']!)} |`,
    `| longtask total ms | ${aggA['longtaskTotalMs']!.toFixed(1)} | ${aggB['longtaskTotalMs']!.toFixed(1)} | ${pct(aggA['longtaskTotalMs']!, aggB['longtaskTotalMs']!)} |`,
    `| loaf count | ${aggA['loafCount']} | ${aggB['loafCount']} | ${pct(aggA['loafCount']!, aggB['loafCount']!)} |`,
    `| loaf max ms | ${aggA['loafMaxMs']!.toFixed(1)} | ${aggB['loafMaxMs']!.toFixed(1)} | ${pct(aggA['loafMaxMs']!, aggB['loafMaxMs']!)} |`,
    `| loaf blocking total ms | ${aggA['loafBlockingTotalMs']!.toFixed(1)} | ${aggB['loafBlockingTotalMs']!.toFixed(1)} | ${pct(aggA['loafBlockingTotalMs']!, aggB['loafBlockingTotalMs']!)} |`,
    `| heap slope MB/s | ${aggA['heapSlopeMbPerSec']!.toFixed(3)} | ${aggB['heapSlopeMbPerSec']!.toFixed(3)} | ${pct(aggA['heapSlopeMbPerSec']!, aggB['heapSlopeMbPerSec']!)} |`,
    `| heap peak MB | ${aggA['heapPeakMb']!.toFixed(1)} | ${aggB['heapPeakMb']!.toFixed(1)} | ${pct(aggA['heapPeakMb']!, aggB['heapPeakMb']!)} |`,
    '',
    '## Per-rep raw',
    '',
    '| arm | rep | raf_gap | longtask | loaf | heap MB/s | fires |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...reps.map(
      (r) =>
        `| ${r.arm} | ${r.rep} | ${r.rafGapCount} | ${r.longtaskCount} | ${r.loafCount} | ${r.heapSlopeMbPerSec.toFixed(3)} | ${r.fireCount} |`,
    ),
    '',
    '## Interpretation',
    '',
    '- **Caveat**: this is a DESKTOP A/B. The 2026-05-22 finding that set',
    '  the touch default to main-thread was on Android hardware where',
    '  postMessage IPC tail-latency dwarfed the render-cost saving.',
    '  Desktop postMessage is much faster — this A/B can show whether',
    '  worker hurts or helps on desktop, but is NOT decisive for the',
    '  touch default. Flipping the touch default requires a fresh phone',
    '  smoke pair on the same device same session.',
    '- Lower is better on all metrics except `fires` (sanity).',
    '- `raf_gap count` is the headline metric — it counted 38 → 3 in',
    '  the 2026-05-22 phone pair.',
    '',
  ];
  const md = lines.join('\n');
  // eslint-disable-next-line no-console
  console.log('\n' + md);

  await mkdir(OUT_DIR, { recursive: true });
  const ts = Date.now();
  await writeFile(join(OUT_DIR, `worker-ab-${ts}.md`), md);
  await writeFile(
    join(OUT_DIR, `worker-ab-${ts}.raw.json`),
    JSON.stringify({ reps, aggA, aggB }, null, 2),
  );

  // Sanity assertions — combat actually happened in both arms.
  expect(aggA['fireCount'], 'worker=0 fire count median').toBeGreaterThan(2);
  expect(aggB['fireCount'], 'worker=1 fire count median').toBeGreaterThan(2);
});
