/**
 * Hostile-drone combat allocation profile — names the dominant per-tick
 * allocator under STEADY-STATE COMBAT via CDP `HeapProfiler.startSampling`.
 *
 * Sister spec to `combat-allocation-profile.spec.ts`. The peaceful sister
 * runs on `feel-test-25` where drones spawn IDLE and only mark hostile
 * after taking fire — its 20 s window is contaminated by the IDLE→COMBAT
 * transition AND it sees zero return fire / scheduled damage allocators.
 * This spec uses the `startHostile=1` JoinOption primitive (plan:
 * imperative-taco) to pre-mark every drone hostile to the joining player
 * at spawn, so the entire 25 s window measures real combat allocation.
 *
 * The lazy-mochi handoff (`docs/HANDOFF-lazy-mochi-2026-05-29.md`) named
 * the production allocators most likely to drive the ~2.5 MB/s rising-edge
 * heap pattern under capture `5d0e7d`: `handleDamage` queue pushes,
 * `GhostManager` per-frame `out.set` literal, `sendFire` mount + mountGeom
 * arrays, `resetPredictionState` fresh objects. This spec gives the CDP
 * profile something to rank them against.
 *
 * Diagnostic-only: prints the ranking and passes if the sampling
 * succeeded. Not a regression gate. Output is saved to
 * `diag/measurements/2026-05-29-imperative-taco/` by the Phase 1 doc.
 */
import { test, expect, chromium } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface CdpProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number; scriptId: string };
  selfSize: number;
  id: number;
  children: CdpProfileNode[];
}

interface CdpProfileSample {
  size: number;
  nodeId: number;
  ordinal: number;
}

interface CdpProfile {
  head: CdpProfileNode;
  samples: CdpProfileSample[];
}

test('hostile combat allocation profile: rank top 25 per-tick allocators', async () => {
  test.setTimeout(90_000);

  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');

  const params = new URLSearchParams({
    room: 'feel-test-25',
    // `?diag=0` URL override — Playwright sets `navigator.webdriver=true`
    // which auto-enables diag; without the override every sample includes
    // ClientLogger.logEvent traffic that no production player ever runs.
    // The lazy-mochi P2 doc has the precedent: their measurement was
    // dominated by `logEvent` (~14-20 % cumulative) which we don't fix
    // because it's a gate-environment artifact. We need the production
    // code path measurement to find the ~2.5 MB/s rising-edge allocator
    // observed in phone capture `5d0e7d` (which ran with diag off).
    diag: '0',
    testId: `alloc-profile-hostile-${Date.now()}`,
    spawnX: '0',
    spawnY: '0',
    // plan: imperative-taco — pre-mark every drone hostile at spawn so the
    // 25 s window measures steady-state combat, not IDLE→COMBAT warmup.
    startHostile: '1',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );
  await page.waitForTimeout(3000); // warmup — drone aggro packets flush + initial-join longtask tail

  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 1024 });

  await page.keyboard.down('Space');
  // 25 s window — 5 s longer than the peaceful sister spec to give variance
  // headroom on the hostile workload (more events flow per second).
  await page.waitForTimeout(25_000);
  await page.keyboard.up('Space');
  await page.waitForTimeout(200);

  const result = (await cdp.send('HeapProfiler.stopSampling')) as { profile: CdpProfile };

  await ctx.close();
  await browser.close();

  const nodes = new Map<number, CdpProfileNode>();
  const walk = (n: CdpProfileNode): void => {
    nodes.set(n.id, n);
    for (const c of n.children) walk(c);
  };
  walk(result.profile.head);

  const sizesByNode = new Map<number, number>();
  for (const s of result.profile.samples) {
    sizesByNode.set(s.nodeId, (sizesByNode.get(s.nodeId) ?? 0) + s.size);
  }

  const ranked = [...sizesByNode.entries()]
    .map(([id, size]) => {
      const node = nodes.get(id);
      const cf = node?.callFrame;
      const url = cf?.url ?? '<unknown>';
      const shortUrl = url.replace(BASE_URL, '').replace(/^https?:\/\/[^/]+/, '');
      const name = cf?.functionName || '(anonymous)';
      const loc = cf ? `${shortUrl}:${cf.lineNumber + 1}:${cf.columnNumber + 1}` : '<no-call-frame>';
      return { id, size, name, loc };
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, 25);

  const totalSize = [...sizesByNode.values()].reduce((s, n) => s + n, 0);

  // eslint-disable-next-line no-console
  console.log(`\n=== Top 25 allocators by sampled size during 25s HOSTILE combat (total sampled: ${(totalSize / 1024 / 1024).toFixed(2)} MB) ===`);
  for (const r of ranked) {
    const pct = ((r.size / totalSize) * 100).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(`  ${(r.size / 1024).toFixed(1).padStart(8)} KB  ${pct.padStart(5)}%   ${r.name.padEnd(40)}  ${r.loc}`);
  }

  expect(result.profile.samples.length).toBeGreaterThan(100);
});
