/**
 * Combat-heap-growth FX bisect — A/B/C measurement against the wb1al4
 * pre-existing Pixi-effects heap leak (plan: melodic-engelbart Step 3).
 *
 * Runs the existing combat-heap-growth recipe (feel-test-25 + 20 s
 * held-fire + heap_sample + raf_gap scrape) three times in fresh
 * browsers with different FX kill-switch combinations:
 *
 *   1. control     — both FX subsystems on (today's behaviour)
 *   2. nofilters   — ?nofilters=1 (LaserGlow, ShieldAura glow,
 *                    DestructionFx shock, WarpFilterChain all detached;
 *                    particles still spawn)
 *   3. noparticles — ?noparticles=1 (EngineEmitter, ImpactSparks,
 *                    DestructionFx particles all bypassed; filters still
 *                    attach)
 *
 * Output is a side-by-side table (slope, peak heap, rafGapCount,
 * maxStallMs). This spec is a MEASUREMENT EXPERIMENT, not a gate — the
 * existing combat-heap-growth.spec.ts stays the regression lock per
 * Invariant #13. Decision tree branches in the plan based on the
 * relative slope drops:
 *
 *   - both drop ≥40 % → both subsystems contribute; localise both
 *   - only nofilters drops ≥40 % → filters dominate; bisect per-filter
 *   - only noparticles drops ≥40 % → particles dominate; bisect emitter
 *   - neither moves materially → FX hypothesis FALSIFIED → look at
 *     damage_number_spawned, snapshot decode, sendFire ghost spawn
 *
 * Assertions in the spec itself are sanity-only (combat happened, heap
 * samples collected). The verdict comes from reading the printed table.
 */
import { test, expect, chromium, type Browser, type Page } from '@playwright/test';

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

interface VariantStats {
  variant: 'control' | 'nofilters' | 'noparticles';
  url: string;
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
  };
  combat: {
    fireCount: number;
    damageNumberSpawnCount: number;
  };
}

async function measureVariant(
  variant: VariantStats['variant'],
  urlSuffix: string,
): Promise<VariantStats> {
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `combat-heap-${variant}-${Date.now()}`,
    spawnX: '0',
    spawnY: '0',
  });
  const url = `${BASE_URL}?${params}${urlSuffix}`;

  const browser: Browser = await chromium.launch({
    args: ['--enable-precise-memory-info'],
  });
  const ctx = await browser.newContext();
  const page: Page = await ctx.newPage();

  try {
    await page.goto(url);
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="ship-count"]');
        return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
      },
      { timeout: 15_000 },
    );

    // 3 s warmup so initial-correction spikes don't dominate.
    await page.waitForTimeout(3000);
    await page.evaluate(() =>
      (window as unknown as { __eqxClearLogs?: () => void }).__eqxClearLogs?.(),
    );

    // 20 s held-fire — same workload as the existing combat-heap-growth spec.
    await page.keyboard.down('Space');
    await page.waitForTimeout(20_000);
    await page.keyboard.up('Space');

    // Drain one final RAF before reading.
    await page.waitForTimeout(200);

    const stats = await page.evaluate((): Omit<VariantStats, 'variant' | 'url'> => {
      const logs =
        (window as unknown as { __eqxLogs?: { ts: number; tag: string; data: Record<string, unknown> }[] }).__eqxLogs ?? [];
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
      const maxStallElapsedMs = rafGaps.reduce(
        (m, e) => (e.elapsedMs > m ? e.elapsedMs : m),
        0,
      );
      const maxHeapDeltaAtStall = rafGaps.reduce(
        (m, e) =>
          e.heapDeltaMbSinceLastStall !== null && e.heapDeltaMbSinceLastStall > m
            ? e.heapDeltaMbSinceLastStall
            : m,
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
        },
        combat: { fireCount, damageNumberSpawnCount },
      };
    });

    return { variant, url, ...stats };
  } finally {
    await ctx.close();
    await browser.close();
  }
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits);
}

test('combat heap-growth FX bisect (control / nofilters / noparticles)', async () => {
  // Each variant: 3 s warmup + 20 s held-fire + browser launch overhead ≈ 30-40 s.
  // Three variants sequentially + result printing → ~2-3 min wall-clock.
  test.setTimeout(300_000);

  const results: VariantStats[] = [];
  results.push(await measureVariant('control', ''));
  results.push(await measureVariant('nofilters', '&nofilters=1'));
  results.push(await measureVariant('noparticles', '&noparticles=1'));

  // eslint-disable-next-line no-console
  console.log('\n=== Combat heap-growth FX bisect ===');
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(results, null, 2));

  // Side-by-side table for at-a-glance reading.
  const control = results[0]!;
  const noFilters = results[1]!;
  const noParticles = results[2]!;
  const slopeDeltaFiltersPct =
    control.heap.slopeMbPerSec === 0
      ? 0
      : ((control.heap.slopeMbPerSec - noFilters.heap.slopeMbPerSec) /
          control.heap.slopeMbPerSec) *
        100;
  const slopeDeltaParticlesPct =
    control.heap.slopeMbPerSec === 0
      ? 0
      : ((control.heap.slopeMbPerSec - noParticles.heap.slopeMbPerSec) /
          control.heap.slopeMbPerSec) *
        100;
  // eslint-disable-next-line no-console
  console.log(`
| variant      | slope (MB/s) | peak (MB) | rafGap | maxStall (ms) | fire | dmg# |
|--------------|--------------|-----------|--------|---------------|------|------|
| control      | ${fmt(control.heap.slopeMbPerSec).padStart(12)} | ${fmt(control.heap.peakMb, 1).padStart(9)} | ${String(control.stalls.rafGapCount).padStart(6)} | ${fmt(control.stalls.maxStallElapsedMs, 0).padStart(13)} | ${String(control.combat.fireCount).padStart(4)} | ${String(control.combat.damageNumberSpawnCount).padStart(4)} |
| nofilters    | ${fmt(noFilters.heap.slopeMbPerSec).padStart(12)} | ${fmt(noFilters.heap.peakMb, 1).padStart(9)} | ${String(noFilters.stalls.rafGapCount).padStart(6)} | ${fmt(noFilters.stalls.maxStallElapsedMs, 0).padStart(13)} | ${String(noFilters.combat.fireCount).padStart(4)} | ${String(noFilters.combat.damageNumberSpawnCount).padStart(4)} |
| noparticles  | ${fmt(noParticles.heap.slopeMbPerSec).padStart(12)} | ${fmt(noParticles.heap.peakMb, 1).padStart(9)} | ${String(noParticles.stalls.rafGapCount).padStart(6)} | ${fmt(noParticles.stalls.maxStallElapsedMs, 0).padStart(13)} | ${String(noParticles.combat.fireCount).padStart(4)} | ${String(noParticles.combat.damageNumberSpawnCount).padStart(4)} |

Slope delta vs control:
  - nofilters:    ${fmt(slopeDeltaFiltersPct, 1)} % (positive = filters were leaking)
  - noparticles:  ${fmt(slopeDeltaParticlesPct, 1)} % (positive = particles were leaking)
`);

  // Sanity: each variant ran combat + collected heap samples. If any of
  // these fails, the kill switch broke the run (we'd want to know).
  for (const r of results) {
    expect(r.combat.fireCount, `${r.variant}: fire count`).toBeGreaterThan(2);
    expect(r.heap.sampleCount, `${r.variant}: heap_sample count`).toBeGreaterThan(30);
  }
});
