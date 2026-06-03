/**
 * Heap snapshot diff (WORKER=0 / main-thread renderer) — matches the
 * phone code path where the user saw 2 MB/sec growth + lag spikes.
 *
 * Standard `heap-snapshot-diff.spec.ts` uses Playwright Chrome which
 * picks the WORKER renderer (per CLAUDE.md selection logic), so its
 * top-20 growers don't include Pixi sprite/Text/geometry allocs that
 * live in the worker. The phone path puts ALL of it in the main thread.
 */
import { test, expect, chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession } from '@playwright/test';
import { diffSnapshots, formatDiffMarkdown, type SnapshotJson } from '../../scripts/heap-snapshot-diff';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const OUT_DIR = 'diag/measurements/2026-05-31-combat-fx-hunt';

async function takeHeapSnapshot(cdp: CDPSession): Promise<string> {
  const chunks: string[] = [];
  const onChunk = ({ chunk }: { chunk: string }): void => { chunks.push(chunk); };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  try {
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
  } finally {
    cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  }
  return chunks.join('');
}

test('heap snapshot diff: 25s held-fire hostile combat (worker=0)', async () => {
  test.setTimeout(120_000);
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '0',
    testId: `heap-snap-diff-w0-${Date.now()}`,
    spawnX: '0', spawnY: '0',
    startHostile: '1',
    worker: '0',  // ← force main-thread renderer (matches phone)
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ship-count"]');
    return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
  }, { timeout: 15_000 });
  await page.waitForTimeout(3000);
  await page.keyboard.down('Space');
  await page.waitForTimeout(2000);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const snap1Text = await takeHeapSnapshot(cdp);
  await page.waitForTimeout(25_000);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const snap2Text = await takeHeapSnapshot(cdp);
  await page.keyboard.up('Space');
  await ctx.close(); await browser.close();
  await mkdir(OUT_DIR, { recursive: true });
  const ts = Date.now();
  const snap1Path = join(OUT_DIR, `w0-snap-t05-${ts}.heapsnapshot`);
  const snap2Path = join(OUT_DIR, `w0-snap-t30-${ts}.heapsnapshot`);
  await writeFile(snap1Path, snap1Text);
  await writeFile(snap2Path, snap2Text);
  expect(snap1Text.length).toBeGreaterThan(1000);
  expect(snap2Text.length).toBeGreaterThan(1000);
  const snap1: SnapshotJson = JSON.parse(snap1Text);
  const snap2: SnapshotJson = JSON.parse(snap2Text);
  const diff = diffSnapshots(snap1, snap2);
  const md = formatDiffMarkdown(diff, 30);
  const totalGrowingBytes = diff.filter((d) => d.sizeDeltaBytes > 0).reduce((s, d) => s + d.sizeDeltaBytes, 0);
  const totalShrinkingBytes = diff.filter((d) => d.sizeDeltaBytes < 0).reduce((s, d) => s + d.sizeDeltaBytes, 0);
  const summary = [
    `# Heap snapshot diff — hostile 25 s combat (WORKER=0)`,
    ``,
    `Matches phone code path (main-thread renderer).`,
    ``,
    `**Snapshots**: \`${snap1Path}\` → \`${snap2Path}\``,
    ``,
    `**Stats**:`,
    `- Total groups with non-zero delta: ${diff.length}`,
    `- Total growing bytes: ${(totalGrowingBytes / 1024).toFixed(1)} KB`,
    `- Total shrinking bytes: ${(totalShrinkingBytes / 1024).toFixed(1)} KB`,
    `- Net delta: ${((totalGrowingBytes + totalShrinkingBytes) / 1024).toFixed(1)} KB`,
    ``,
    `## Top-30 growers`,
    ``,
    md,
  ].join('\n');
  const summaryPath = join(OUT_DIR, `w0-snapshot-diff-${ts}.md`);
  await writeFile(summaryPath, summary);
  console.log(`\n${summary}\n`);
  console.log(`\nSaved:\n  ${snap1Path}\n  ${snap2Path}\n  ${summaryPath}\n`);
});
