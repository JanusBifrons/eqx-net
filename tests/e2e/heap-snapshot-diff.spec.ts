/**
 * Heap snapshot diff — captures two V8 `.heapsnapshot` files during a
 * 25 s hostile-combat session and runs `scripts/heap-snapshot-diff.ts`
 * to rank growing constructors by retained-self-size delta.
 *
 * plan: imperative-taco-r2 §2.1.
 *
 * Why this exists: round 1's `combat-allocation-profile-hostile.spec.ts`
 * used CDP `HeapProfiler.startSampling` which weights call sites by
 * sampled allocation × frequency. The rank-1 fix we shipped didn't move
 * felt stutter on the phone because the REAL bulk allocator (~970 KB/s
 * snapshot processing) is distributed across multiple call frames inside
 * one hot loop. Heap snapshot diff measures SURVIVING OBJECTS between
 * two GC points, which is what V8's major-GC actually has to mark and
 * sweep, and what determines the GC pause length the user feels.
 *
 * Workload: clone of the hostile profile spec — `feel-test-25` room,
 * `startHostile=1` (drones return fire from frame 0), `?diag=0`
 * (production-parity, suppresses the ClientLogger ring buffer that
 * would inflate the diff with allocation noise).
 *
 * Output: two `.heapsnapshot` files saved to
 * `diag/measurements/2026-05-30-imperative-taco-r2/` plus a printed
 * Markdown ranking of the top-20 growers. Saved as `P2-snapshot-diff.md`
 * by the next plan step (run the printed output through the diff utility).
 *
 * The test passes if both snapshots were captured cleanly (sanity).
 * The PRIMARY VALUE is the printed ranking, which informs the Phase 3
 * fix backlog. Not a gate.
 */
import { test, expect, chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession } from '@playwright/test';
import { diffSnapshots, formatDiffMarkdown, type SnapshotJson } from '../../scripts/heap-snapshot-diff';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const OUT_DIR = 'diag/measurements/2026-05-30-imperative-taco-r2';

/**
 * Stream a V8 `.heapsnapshot` from the CDP target. Chrome chunks the
 * snapshot through `HeapProfiler.addHeapSnapshotChunk` events; we collect
 * all chunks until `HeapProfiler.takeHeapSnapshot` resolves, then concat
 * into the single JSON string the diff utility parses.
 */
async function takeHeapSnapshot(cdp: CDPSession): Promise<string> {
  const chunks: string[] = [];
  const onChunk = ({ chunk }: { chunk: string }): void => { chunks.push(chunk); };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false,
      captureNumericValue: false,
    });
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  }
  return chunks.join('');
}

test('heap snapshot diff: 25s held-fire hostile combat', async () => {
  test.setTimeout(90_000);

  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');

  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '0',
    testId: `heap-snap-diff-${Date.now()}`,
    spawnX: '0',
    spawnY: '0',
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
  // Warmup — same 3 s the sampling-profile spec uses, lets initial-join
  // longtask tail flush so it's not in the t=5 baseline.
  await page.waitForTimeout(3000);

  // ── Snapshot 1: post-warmup baseline ──────────────────────────────
  await page.keyboard.down('Space');
  await page.waitForTimeout(2000); // 2s of combat warmup before baseline
  // GC twice to settle any pre-warmup garbage before the baseline read.
  // Same double-collectGarbage pattern as tests/mobile-perf/helpers/cdpHeap.ts.
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const snap1Text = await takeHeapSnapshot(cdp);

  // ── 25 s of held-fire combat ──────────────────────────────────────
  await page.waitForTimeout(25_000);

  // ── Snapshot 2: post-combat ───────────────────────────────────────
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const snap2Text = await takeHeapSnapshot(cdp);

  await page.keyboard.up('Space');
  await ctx.close();
  await browser.close();

  // ── Save raw snapshots + run diff ─────────────────────────────────
  await mkdir(OUT_DIR, { recursive: true });
  const ts = Date.now();
  const snap1Path = join(OUT_DIR, `snap-t05-${ts}.heapsnapshot`);
  const snap2Path = join(OUT_DIR, `snap-t30-${ts}.heapsnapshot`);
  await writeFile(snap1Path, snap1Text);
  await writeFile(snap2Path, snap2Text);

  // Sanity — both snapshots are non-empty and parseable.
  expect(snap1Text.length).toBeGreaterThan(1000);
  expect(snap2Text.length).toBeGreaterThan(1000);
  const snap1: SnapshotJson = JSON.parse(snap1Text);
  const snap2: SnapshotJson = JSON.parse(snap2Text);
  expect(snap1.snapshot.node_count).toBeGreaterThan(100);
  expect(snap2.snapshot.node_count).toBeGreaterThan(100);

  // Run the diff utility + print the top-20 ranking.
  const diff = diffSnapshots(snap1, snap2);
  const md = formatDiffMarkdown(diff, 20);
  const totalGrowingBytes = diff.filter((d) => d.sizeDeltaBytes > 0).reduce((s, d) => s + d.sizeDeltaBytes, 0);
  const totalShrinkingBytes = diff.filter((d) => d.sizeDeltaBytes < 0).reduce((s, d) => s + d.sizeDeltaBytes, 0);

  // Save the formatted output alongside the snapshots for easy reference.
  const summary = [
    `# Heap snapshot diff — hostile 25 s combat`,
    ``,
    `**Snapshots**: \`${snap1Path}\` → \`${snap2Path}\``,
    ``,
    `**Stats**:`,
    `- Total groups with non-zero delta: ${diff.length}`,
    `- Total growing bytes: ${(totalGrowingBytes / 1024).toFixed(1)} KB`,
    `- Total shrinking bytes: ${(totalShrinkingBytes / 1024).toFixed(1)} KB`,
    `- Net delta: ${((totalGrowingBytes + totalShrinkingBytes) / 1024).toFixed(1)} KB`,
    ``,
    `## Top-20 growers`,
    ``,
    md,
  ].join('\n');
  const summaryPath = join(OUT_DIR, `P2-snapshot-diff-${ts}.md`);
  await writeFile(summaryPath, summary);

  // eslint-disable-next-line no-console
  console.log(`\n${summary}\n`);
  // eslint-disable-next-line no-console
  console.log(`\nSaved:\n  ${snap1Path}\n  ${snap2Path}\n  ${summaryPath}\n`);
});
