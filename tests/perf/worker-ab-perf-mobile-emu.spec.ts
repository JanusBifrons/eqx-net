/**
 * Worker-renderer A/B perf comparison — **mobile-emu variant**.
 *
 * Sister spec to `worker-ab-perf.spec.ts`. The desktop A/B confirmed
 * worker reduces main-thread blocking by ~75 % on this hardware,
 * vindicating the desktop default. But the 2026-05-22 phone finding
 * was on Android — mobile postMessage IPC tail-latency (~110 ms) on
 * lower-end CPUs is the actual mechanism that flipped the touch
 * default to main-thread. Desktop can't see that.
 *
 * This spec re-runs the A/B under Chromium-only mobile-pressure emulation:
 *
 *   - **CPU throttle 4× via CDP `Emulation.setCPUThrottlingRate`** —
 *     same constant as `heap-snapshot-diff-mobile-emu.spec.ts` and
 *     `tests/perf/perf-baseline.spec.ts`. Mobile-grade CPU pressure
 *     should amplify the postMessage IPC clone cost that was the
 *     load-bearing mechanism in the original 2026-05-22 finding.
 *   - **V8 heap cap `--max-old-space-size=128 --max-semi-space-size=8`**
 *     — mid-range Android Chrome typically allocates 256–512 MB per
 *     tab; we constrain to 128 MB old / 8 MB young so the renderer
 *     hits mobile-like GC pressure during sustained combat.
 *
 * **NOT included: iPhone viewport / DPR emulation.** Per user direction
 * (2026-05-31), the 414×896 DPR-2 iPhone emulator config "never works"
 * — the first attempt of this spec used it and timed out on rep 4 arm A
 * (8/8 reps fit in 480 s budget plus iPhone-emu overhead pushed past
 * the ceiling). The CPU throttle + heap cap are the mechanisms that
 * matter for THIS A/B (the worker IPC cost is CPU-bound, not
 * DPR-bound), so dropping the viewport emulation preserves the proxy
 * value while removing the failure mode.
 *
 * Caveat: emulator is still NOT a physical phone. Real Android
 * hardware has scheduling jitter + GPU compositor characteristics
 * that no Chromium flag reproduces. This spec is a **better** proxy
 * than desktop, but the decisive test for flipping the touch default
 * remains an on-device smoke pair.
 *
 * Scenario unchanged from desktop variant: feel-test-25, 15 s
 * held-fire after warmup (extended to 12 s to absorb the 4× CPU
 * throttle's initial-join longtask).
 *
 * Total runtime ≈ 8 reps × ~35 s = ~5 min (4× throttle inflates each
 * rep). Explicit ceiling: 8 min.
 */
import { test, expect, chromium, type Browser } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const OUT_DIR = 'diag/measurements/2026-05-31-worker-ab-mobile-emu';
// "Light" config (user direction 2026-05-31 — 13 min runtime "ridiculous").
// 2 reps each arm + halved throttle + shorter windows. Trade-off: 2 reps
// each is enough for a directional signal under low variance, less under
// high; CPU 2× throttle still creates mobile-grade pressure (the
// 4× canonical is the failure mode). Escalate to the desktop spec or 4
// reps if signal is ambiguous.
const REPS_PER_ARM = 2;
const FIRE_DURATION_MS = 8_000;
const WARMUP_MS = 6_000;
const CPU_THROTTLE_RATE = 2;

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
  // Default viewport — iPhone-class (414×896 DPR 2) emulation is
  // dropped per user direction (2026-05-31, "the iPhone one never
  // works"). CPU throttle + heap cap below are the mobile proxy.
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  // CPU throttle MUST be applied per-page after page creation.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_THROTTLE_RATE });

  const workerFlag = arm === 'worker=0' ? '0' : '1';
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `worker-ab-emu-${arm}-${rep}-${Date.now()}`,
    spawnX: '0',
    spawnY: '0',
    worker: workerFlag,
  });
  await page.goto(`${BASE_URL}?${params}`);
  // 4× CPU → boot can take 2-3× longer; the heap-snapshot-diff-mobile-emu
  // pattern uses 30 s budget here.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 30_000 },
  );
  await page.waitForTimeout(WARMUP_MS);
  await page.evaluate(() =>
    (window as unknown as { __eqxClearLogs?: () => void }).__eqxClearLogs?.(),
  );

  await page.keyboard.down('Space');
  await page.waitForTimeout(FIRE_DURATION_MS);
  await page.keyboard.up('Space');
  await page.waitForTimeout(500); // longer drain under throttle

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

  // Restore CPU before teardown so the close doesn't hang on a 4× slow tab.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
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

test('worker A/B perf — mobile emu (light: 2× CPU, 128 MB heap), 2 reps each arm', async () => {
  test.setTimeout(240_000); // 4 min ceiling for light config (~2 min expected)
  // V8 heap cap mimics mid-range Android Chrome's GC pressure threshold.
  const browser = await chromium.launch({
    args: [
      '--enable-precise-memory-info',
      '--js-flags=--max-old-space-size=128 --max-semi-space-size=8',
    ],
  });

  const reps: RepStats[] = [];
  for (let i = 0; i < REPS_PER_ARM; i++) {
    // eslint-disable-next-line no-console
    console.log(`\n--- emu rep ${i + 1}/${REPS_PER_ARM} arm A (worker=0) ---`);
    reps.push(await runOneRep(browser, 'worker=0', i + 1));
    // eslint-disable-next-line no-console
    console.log(`\n--- emu rep ${i + 1}/${REPS_PER_ARM} arm B (worker=1) ---`);
    reps.push(await runOneRep(browser, 'worker=1', i + 1));
  }
  await browser.close();

  const armA = reps.filter((r) => r.arm === 'worker=0');
  const armB = reps.filter((r) => r.arm === 'worker=1');
  const aggA = aggregate(armA);
  const aggB = aggregate(armB);

  const lines: string[] = [
    '# Worker A/B perf comparison — mobile emu',
    '',
    `**Date**: ${new Date().toISOString()}`,
    `**Emulation**: default viewport, CPU throttle ${CPU_THROTTLE_RATE}×, V8 heap cap (old=128 MB, semi=8 MB) — no iPhone viewport (user 2026-05-31 "never works"); light config 2 reps each`,
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
    '- The 2026-05-22 phone smoke pair (`721mwk` worker-on vs `iph9cv`',
    '  worker-off, Android Pixel) showed a 19× reduction in `raf_gap > 100',
    '  ms` events (38 → 3) when worker was OFF. Mobile emu should',
    '  approximate that direction if the 110 ms IPC tail-latency mechanism',
    '  still binds. If emu shows the opposite (worker=1 cleaner under',
    '  emu), the recent FX cleanup + GC-discipline work has changed the',
    '  underlying mechanism and a fresh phone smoke is the next step.',
    '- `raf_gap count` is the headline metric — same one the 2026-05-22',
    '  pair gated on.',
    '- The 4× CPU throttle is a CPU-time scaler, not an IPC-jitter',
    '  scaler — emu is a better proxy than desktop but still understates',
    '  real-phone postMessage variance.',
    '',
  ];
  const md = lines.join('\n');
  // eslint-disable-next-line no-console
  console.log('\n' + md);

  await mkdir(OUT_DIR, { recursive: true });
  const ts = Date.now();
  await writeFile(join(OUT_DIR, `worker-ab-emu-${ts}.md`), md);
  await writeFile(
    join(OUT_DIR, `worker-ab-emu-${ts}.raw.json`),
    JSON.stringify({ reps, aggA, aggB }, null, 2),
  );

  expect(aggA['fireCount'], 'worker=0 fire count median').toBeGreaterThan(2);
  expect(aggB['fireCount'], 'worker=1 fire count median').toBeGreaterThan(2);
});
