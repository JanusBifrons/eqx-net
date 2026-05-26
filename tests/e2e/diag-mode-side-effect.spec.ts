/**
 * E2E investigation — diag-mode-vs-prod-mode side effect (2026-05-25,
 * updated 2026-05-26 after heap-growth gate step 11).
 *
 * History: phone smoke 2026-05-25 showed a dramatic perceptual gap
 * between `?diag=1` (smooth) and no diag flag (unplayable) on the SAME
 * built code. This spec was the investigation harness — measuring
 * whether the effect reproduced on a dev box (=> code mechanism we
 * could find) or was mobile/GPU-specific (=> below us).
 *
 * Outcome of that investigation (2026-05-26): the per-tick / per-RAF
 * telemetry tags (`rafTick`, `input_intent`, `local_pose_predicted`,
 * `local_pose_rendered`, `inputSent`) WERE the cause — ~360 per-tick
 * allocs/sec going into the ring buffer regardless of diag state. Fix
 * was to invert the `HIGH_VOLUME_TAGS` gate in `ClientLogger.logEvent`
 * so production drops these by default; only `?diag=1` /
 * `navigator.webdriver` keep them. See d54fne capture analysis +
 * `ClientLogger.ts` `isFullDiagMode()`.
 *
 * Post-fix purpose: regression check that the gate works. Prod mode
 * should now record DRAMATICALLY fewer ring entries than diag mode
 * (per-tick + per-RAF dropped). We measure entry counts rather than
 * rafTick cadence because rafTick is no longer emitted in prod, which
 * is the point. Both modes still emit `snapshot_received` (20 Hz,
 * always-on) which is what we sample for cadence parity. Prints the
 * comparison for visibility.
 */
import { test, expect, type Browser } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface DiagArmStats {
  arm: string;
  totalEntries: number;
  highVolumeEntries: number;
  snapshotReceivedCount: number;
  rafGapCount: number;
  rafStutterCount: number;
  mirrorRebuildCount: number;
}

const HIGH_VOLUME_TAGS = ['rafTick', 'input_intent', 'local_pose_predicted', 'local_pose_rendered', 'inputSent'];

async function measure(browser: Browser, diagFlag: '0' | '1'): Promise<DiagArmStats> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const search = new URLSearchParams({ diag: diagFlag, room: 'test-sector' });
  await page.goto(`${BASE_URL}?${search}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 15_000 },
  );
  // Settle for 3 s (warmup), then measure for 10 s.
  await page.waitForTimeout(3000);
  await page.evaluate(() => (window as unknown as { __eqxClearLogs?: () => void }).__eqxClearLogs?.());
  await page.waitForTimeout(10_000);
  const result = await page.evaluate((highVolumeTags: readonly string[]) => {
    const logs = (window as unknown as { __eqxLogs?: { tag: string; data: Record<string, unknown> }[] }).__eqxLogs ?? [];
    const high = new Set(highVolumeTags);
    return {
      totalEntries: logs.length,
      highVolumeEntries: logs.filter((e) => high.has(e.tag)).length,
      snapshotReceivedCount: logs.filter((e) => e.tag === 'snapshot_received').length,
      rafGapCount: logs.filter((e) => e.tag === 'raf_gap').length,
      rafStutterCount: logs.filter((e) => e.tag === 'raf_stutter').length,
      mirrorRebuildCount: logs.filter((e) => e.tag === 'mirror_rebuild').length,
    };
  }, HIGH_VOLUME_TAGS);
  await ctx.close();
  return {
    arm: `diag=${diagFlag}`,
    ...result,
  };
}

test('HIGH_VOLUME_TAGS gate: prod (?diag=0) drops per-tick events, diag (?diag=1) keeps them', async ({ browser }) => {
  test.setTimeout(60_000);
  const prod = await measure(browser, '0');
  const diag = await measure(browser, '1');
  // eslint-disable-next-line no-console
  console.log('\n=== diag-mode ring-entry comparison (10 s sample) ===');
  // eslint-disable-next-line no-console
  console.log('PROD (diag=0):', JSON.stringify(prod, null, 2));
  // eslint-disable-next-line no-console
  console.log('DIAG (diag=1):', JSON.stringify(diag, null, 2));
  // eslint-disable-next-line no-console
  console.log(
    '\nHIGH_VOLUME delta:',
    `prod=${prod.highVolumeEntries} entries  diag=${diag.highVolumeEntries} entries  ratio=${(diag.highVolumeEntries / Math.max(prod.highVolumeEntries, 1)).toFixed(1)}x`,
  );
  // Both arms must collect a healthy stream of always-on tags so the
  // comparison is real. `snapshot_received` is 20 Hz × 10 s = ~200
  // baseline; allow some slack for join settle.
  expect(prod.snapshotReceivedCount).toBeGreaterThan(50);
  expect(diag.snapshotReceivedCount).toBeGreaterThan(50);
  // Gate proof: prod must drop the high-volume tags. Diag mode keeps
  // them — at 60 Hz × 5 tags × 10 s = ~3000 entries the gap is wide
  // enough that any non-zero prod entry count signals a regression
  // (the gate let something through). We allow tiny noise from the
  // warmup-end race (the clear happens mid-frame; one stray event is
  // not a regression).
  expect(prod.highVolumeEntries).toBeLessThan(5);
  expect(diag.highVolumeEntries).toBeGreaterThan(500);
});
