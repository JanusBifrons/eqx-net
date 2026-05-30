/**
 * Heap snapshot diff — Chromium DevTools mobile emulator variant.
 *
 * Sister spec to `heap-snapshot-diff.spec.ts`. Runs the same workload
 * (180 s of held-fire hostile combat, snapshot pair, retained-self-size
 * diff) under DevTools mobile emulation so we can chase the wb1al4
 * retention cascade without a physical phone. User instruction
 * (2026-05-30): "avoid real device testing at all costs."
 *
 * Emulator config (canonical pattern from `tests/perf/perf-baseline.spec.ts`
 * + `webrtc-mobile-emulation-stutter.spec.ts`):
 *
 *   - `Emulation.setCPUThrottlingRate(4)` — 4× CPU throttle, matches
 *     the mobile-shaped arm in perf-baseline. Slows JS execution so
 *     allocation churn outpaces GC, mimicking the wb1al4 phone-cpu
 *     pressure that produced the 50→95 MB cascade.
 *   - Viewport 414×896 + DPR 2 — iPhone-class mobile dimensions.
 *     Different Pixi rendering paths (smaller fb, higher DPR) than
 *     the desktop default.
 *
 * The 180 s window (~4× the mobile-equivalent of wb1al4's 4 min)
 * gives the cascade time to develop.
 *
 * Output: same `.heapsnapshot` pair + Markdown ranking format as the
 * desktop spec, saved to `diag/measurements/<dir>/`.
 */
import { test, expect, chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CDPSession } from '@playwright/test';
import { diffSnapshots, formatDiffMarkdown, type SnapshotJson } from '../../scripts/heap-snapshot-diff';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const OUT_DIR = 'diag/measurements/2026-05-30-mobile-emu';

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

test('heap snapshot diff (mobile emu): 180s hostile combat under 4x CPU throttle', async () => {
  test.setTimeout(360_000);

  // V8 heap-size constraints simulate the GC-pressure threshold that
  // mobile Chrome hits on wb1al4-class workloads (user reframe 2026-
  // 05-30: "Is it possible it's simply too much stuff happening for
  // the phone?"). Mid-range Android Chrome typically allocates
  // ~256-512 MB per tab for V8; we constrain to 128 MB old space + 8
  // MB young space (semi-space) so the renderer is forced into
  // mobile-like GC pressure under sustained combat. The young-space
  // shrink is the key knob — frequent minor GCs at smaller capacity
  // is what produces the threshold cascade.
  const browser = await chromium.launch({
    args: [
      '--enable-precise-memory-info',
      '--js-flags=--max-old-space-size=128 --max-semi-space-size=8',
    ],
  });
  // Mobile-shaped context: viewport + DPR. CPU throttle applied via CDP
  // after page creation (must be applied per-page).
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

  const params = new URLSearchParams({
    room: 'feel-test-25',
    diag: '0',
    testId: `heap-snap-mobile-${Date.now()}`,
    spawnX: '0',
    spawnY: '0',
    startHostile: '1',
  });

  // Spec validation (2026-05-30): adding `&injectLeak=500` to the URL
  // injects 30 KB/sec of retained Uint8Array via testLeakHook and the
  // diff correctly reports +5 MB JSArrayBufferData / Uint8Array /
  // ArrayBuffer growth. The spec's measurement plumbing is verified
  // functional; an absence of leak signal in production code means
  // the code is clean in this workload, not that the spec is broken.
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 30_000 }, // 4x CPU throttle → 2x boot time budget
  );
  // 4x CPU → warmup gets 12 s of game-time to flush initial-join longtask.
  await page.waitForTimeout(12_000);

  // ── Snapshot 1: post-warmup baseline ──────────────────────────────
  await page.keyboard.down('Space');
  await page.waitForTimeout(2000);
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const snap1Text = await takeHeapSnapshot(cdp);

  // ── 180 s of held-fire combat (mobile-cpu-emulated) ───────────────
  await page.waitForTimeout(180_000);

  // ── Snapshot 2: post-combat ───────────────────────────────────────
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const snap2Text = await takeHeapSnapshot(cdp);

  await page.keyboard.up('Space');
  // Restore CPU before teardown so the close doesn't hang on a 4x slow tab.
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await ctx.close();
  await browser.close();

  await mkdir(OUT_DIR, { recursive: true });
  const ts = Date.now();
  const snap1Path = join(OUT_DIR, `snap-t05-${ts}.heapsnapshot`);
  const snap2Path = join(OUT_DIR, `snap-t180-${ts}.heapsnapshot`);
  await writeFile(snap1Path, snap1Text);
  await writeFile(snap2Path, snap2Text);

  expect(snap1Text.length).toBeGreaterThan(1000);
  expect(snap2Text.length).toBeGreaterThan(1000);
  const snap1: SnapshotJson = JSON.parse(snap1Text);
  const snap2: SnapshotJson = JSON.parse(snap2Text);
  expect(snap1.snapshot.node_count).toBeGreaterThan(100);
  expect(snap2.snapshot.node_count).toBeGreaterThan(100);

  const diff = diffSnapshots(snap1, snap2);
  const md = formatDiffMarkdown(diff, 25);
  const totalGrowingBytes = diff.filter((d) => d.sizeDeltaBytes > 0).reduce((s, d) => s + d.sizeDeltaBytes, 0);
  const totalShrinkingBytes = diff.filter((d) => d.sizeDeltaBytes < 0).reduce((s, d) => s + d.sizeDeltaBytes, 0);

  const summary = [
    `# Heap snapshot diff — mobile emu (4x CPU, 414x896 DPR 2), 180s hostile combat`,
    ``,
    `**Snapshots**: \`${snap1Path}\` → \`${snap2Path}\``,
    ``,
    `**Stats**:`,
    `- Total groups with non-zero delta: ${diff.length}`,
    `- Total growing bytes: ${(totalGrowingBytes / 1024).toFixed(1)} KB`,
    `- Total shrinking bytes: ${(totalShrinkingBytes / 1024).toFixed(1)} KB`,
    `- Net delta: ${((totalGrowingBytes + totalShrinkingBytes) / 1024).toFixed(1)} KB`,
    ``,
    `## Top-25 growers`,
    ``,
    md,
  ].join('\n');
  const summaryPath = join(OUT_DIR, `mobile-emu-snapshot-diff-${ts}.md`);
  await writeFile(summaryPath, summary);

  // eslint-disable-next-line no-console
  console.log(`\n${summary}\n`);
  // eslint-disable-next-line no-console
  console.log(`\nSaved:\n  ${snap1Path}\n  ${snap2Path}\n  ${summaryPath}\n`);
});
