/**
 * Standalone heap snapshot diff during ACTIVE survived combat.
 *
 * Sister to `tests/e2e/heap-snapshot-diff-worker-off.spec.ts` which uses
 * `startHostile=1` — that kills the player within ~2 s + the remaining
 * 25 s is dead-player idle, so the diff only captures ~637 KB growth
 * (vs the user's phone smoke showing ~60 MB over 95 s of survived
 * combat in capture `ss8kpz`).
 *
 * This probe:
 *   1. Boots into `feel-test-25` (drones present, NOT hostile by default).
 *   2. Drives held-thrust + held-fire for the SURVIVABLE window —
 *      drones don't attack so the player keeps shooting indefinitely.
 *   3. Snapshots at t=10 s, then at t=70 s (60 s of active combat).
 *   4. Writes the diff Markdown to `diag/measurements/`.
 *
 * Run: `pnpm tsx tests/diag/active-combat-heap-diff.ts`
 */
import { chromium, type CDPSession } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { diffSnapshots, formatDiffMarkdown, type SnapshotJson } from '../../scripts/heap-snapshot-diff';

const BASE = process.env['BASE'] ?? 'http://localhost:5173';
const OUT_DIR = 'diag/measurements/2026-05-31-active-combat-leak';
const WINDOW_S = 60;

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

async function main(): Promise<void> {
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');

  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '0',
    testId: `active-combat-${Date.now()}`,
    spawnX: '0',
    spawnY: '0',
    worker: '0',
  });

  console.log('[probe] booting...');
  await page.goto(`${BASE}/?${params}`);
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="ship-count"]');
    return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
  }, { timeout: 15_000 });

  console.log('[probe] 8 s warmup …');
  await page.waitForTimeout(8000);

  // Start fire + thrust to drive combat. Thrust keeps the player moving
  // through the drone field for snapshot variety.
  await page.keyboard.down('w');
  await page.keyboard.down('Space');

  // 2 s settling then snapshot 1.
  await page.waitForTimeout(2000);
  console.log('[probe] GC + snapshot t10s …');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const snap1Text = await takeHeapSnapshot(cdp);

  console.log(`[probe] driving ${WINDOW_S}s of active combat …`);
  await page.waitForTimeout(WINDOW_S * 1000);

  console.log('[probe] GC + snapshot t70s …');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const snap2Text = await takeHeapSnapshot(cdp);

  await page.keyboard.up('w');
  await page.keyboard.up('Space');
  await ctx.close();
  await browser.close();

  await mkdir(OUT_DIR, { recursive: true });
  const ts = Date.now();
  const p1 = join(OUT_DIR, `pre-${ts}.heapsnapshot`);
  const p2 = join(OUT_DIR, `post-${ts}.heapsnapshot`);
  await writeFile(p1, snap1Text);
  await writeFile(p2, snap2Text);

  const snap1: SnapshotJson = JSON.parse(snap1Text);
  const snap2: SnapshotJson = JSON.parse(snap2Text);
  const diff = diffSnapshots(snap1, snap2);
  const md = formatDiffMarkdown(diff, 40);
  const totalGrowing = diff.filter((d) => d.sizeDeltaBytes > 0).reduce((s, d) => s + d.sizeDeltaBytes, 0);
  const totalShrinking = diff.filter((d) => d.sizeDeltaBytes < 0).reduce((s, d) => s + d.sizeDeltaBytes, 0);

  const summary = [
    `# Heap snapshot diff — ${WINDOW_S}s survived active combat (feel-test-25, worker=0)`,
    ``,
    `**Window**: t=10s → t=${10 + WINDOW_S}s — player held-fire + thrust the entire window without dying.`,
    `**Worker**: 0 (matches user phone path).`,
    ``,
    `**Stats**:`,
    `- Total groups with non-zero delta: ${diff.length}`,
    `- Total growing bytes: ${(totalGrowing / 1024 / 1024).toFixed(2)} MB`,
    `- Total shrinking bytes: ${(totalShrinking / 1024 / 1024).toFixed(2)} MB`,
    `- Net delta: ${((totalGrowing + totalShrinking) / 1024 / 1024).toFixed(2)} MB`,
    ``,
    `## Top-40 growers`,
    ``,
    md,
  ].join('\n');
  const outPath = join(OUT_DIR, `active-combat-diff-${ts}.md`);
  await writeFile(outPath, summary);
  console.log(`\n${summary}\n`);
  console.log(`Wrote:\n  ${p1}\n  ${p2}\n  ${outPath}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
