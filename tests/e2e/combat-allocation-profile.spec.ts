/**
 * Combat allocation profile — names the dominant per-tick allocator via
 * CDP `HeapProfiler.startSampling` (the same mechanism Chrome DevTools'
 * "Allocation sampling" profile uses).
 *
 * The combat-heap-growth gate proved the leak exists but its variance
 * (~0.15 MB/s) is bigger than each individual code fix's effect, so we
 * can't iterate by gate alone. This probe takes a real V8 allocation
 * profile during the same 20 s combat window and ranks the top 20
 * call sites by sampled allocation size — definitive instead of
 * audit-and-hope.
 *
 * Diagnostic-only: prints the ranking and passes if the sampling
 * succeeded. Not a regression gate.
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

test('combat allocation profile: rank top 20 per-tick allocators', async () => {
  test.setTimeout(60_000);

  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');

  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '1',
    testId: `alloc-profile-${Date.now()}`,
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
  await page.waitForTimeout(3000); // warmup

  // 1024-byte sampling interval — Chrome's default. Each sampled
  // allocation contributes its real size to the profile.
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 1024 });

  await page.keyboard.down('Space');
  await page.waitForTimeout(20_000);
  await page.keyboard.up('Space');
  await page.waitForTimeout(200);

  const result = (await cdp.send('HeapProfiler.stopSampling')) as { profile: CdpProfile };

  await ctx.close();
  await browser.close();

  // Walk the profile tree, indexing nodes by id and collecting their
  // call-frame labels.
  const nodes = new Map<number, CdpProfileNode>();
  const walk = (n: CdpProfileNode): void => {
    nodes.set(n.id, n);
    for (const c of n.children) walk(c);
  };
  walk(result.profile.head);

  // Sum sample sizes per node (the profile's `samples[]` is the actual
  // allocation hit list — each entry is one sampled allocation).
  const sizesByNode = new Map<number, number>();
  for (const s of result.profile.samples) {
    sizesByNode.set(s.nodeId, (sizesByNode.get(s.nodeId) ?? 0) + s.size);
  }

  // Rank by allocation size.
  const ranked = [...sizesByNode.entries()]
    .map(([id, size]) => {
      const node = nodes.get(id);
      const cf = node?.callFrame;
      const url = cf?.url ?? '<unknown>';
      // Strip the BASE_URL prefix so paths are readable
      const shortUrl = url.replace(BASE_URL, '').replace(/^https?:\/\/[^/]+/, '');
      const name = cf?.functionName || '(anonymous)';
      const loc = cf ? `${shortUrl}:${cf.lineNumber + 1}:${cf.columnNumber + 1}` : '<no-call-frame>';
      return { id, size, name, loc };
    })
    .sort((a, b) => b.size - a.size)
    .slice(0, 25);

  const totalSize = [...sizesByNode.values()].reduce((s, n) => s + n, 0);

  // eslint-disable-next-line no-console
  console.log(`\n=== Top 25 allocators by sampled size during 20s combat (total sampled: ${(totalSize / 1024 / 1024).toFixed(2)} MB) ===`);
  for (const r of ranked) {
    const pct = ((r.size / totalSize) * 100).toFixed(1);
    // eslint-disable-next-line no-console
    console.log(`  ${(r.size / 1024).toFixed(1).padStart(8)} KB  ${pct.padStart(5)}%   ${r.name.padEnd(40)}  ${r.loc}`);
  }

  expect(result.profile.samples.length).toBeGreaterThan(100);
});
