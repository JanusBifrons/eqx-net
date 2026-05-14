import { test, expect, type Page } from '@playwright/test';

/**
 * Phase A coverage lock — wreck-sprite lifecycle in the
 * WorkerRendererClient ↔ worker ↔ PixiRenderer boundary.
 *
 * UNCOVERED PRIOR: `spriteUpdateDecisions.test.ts` covers the pure
 * decision helper for wreck rendering; nothing exercises the boundary
 * end-to-end (mirror → worker → sprite map → feedback).
 *
 * COVERS (Phase A8 of `humble-strolling-coral.md`):
 *   1. Empty mirror → feedback.wreckSpriteCount = 0.
 *   2. Add a wreck to mirror.wrecks → post frame → sprite mounts →
 *      feedback.wreckSpriteCount = 1.
 *   3. Remove the wreck from mirror.wrecks → post frame → sprite
 *      unmounts → feedback.wreckSpriteCount returns to 0.
 *   4. Multiple wrecks → count tracks the map size.
 *
 * Uses the probe-page pattern (mirror of damage-number-lifetime.spec.ts).
 * Boundary tests live here because:
 *   - The bug class "mirror.wrecks populated but no sprite ever appears"
 *     can only surface at the worker boundary (e.g. structured-clone
 *     dropping a Map ref, a missing wreck-iteration path).
 *   - A unit test of `updateWrecks()` in isolation against a real
 *     PixiRenderer would miss the worker hop entirely.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface WreckProbeApi {
  pushWreck: (id: string, x: number, y: number) => void;
  removeWreck: (id: string) => void;
  postFrame: () => void;
  getWreckSpriteCount: () => number;
  getMirrorWreckCount: () => number;
}

interface ProbeWindow extends Window {
  __wreckProbe?: WreckProbeApi;
}

async function waitForProbeReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as ProbeWindow).__wreckProbe !== undefined,
    { timeout: 10_000 },
  );
}

async function getSpriteCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as ProbeWindow).__wreckProbe!.getWreckSpriteCount(),
  );
}

async function getMirrorCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    (window as unknown as ProbeWindow).__wreckProbe!.getMirrorWreckCount(),
  );
}

async function postFramesAndSettle(page: Page, frames = 5): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(() => (window as unknown as ProbeWindow).__wreckProbe!.postFrame());
    await page.waitForTimeout(30);
  }
  // Allow feedback round-trip.
  await page.waitForTimeout(200);
}

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));
  await page.goto(`${BASE_URL}/__offscreen-spike__/wreck-render-probe.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  });
  await waitForProbeReady(page);
  (page as unknown as { __probeErrors?: string[] }).__probeErrors = errors;
});

test('empty mirror → wreckSpriteCount stays at 0', async ({ page }) => {
  test.setTimeout(15_000);

  await postFramesAndSettle(page, 5);
  expect(await getSpriteCount(page)).toBe(0);
  expect(await getMirrorCount(page)).toBe(0);
});

test('add one wreck → wreckSpriteCount becomes 1', async ({ page }) => {
  test.setTimeout(20_000);

  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__wreckProbe!.pushWreck('wreck-A', 100, 50);
  });
  expect(await getMirrorCount(page)).toBe(1);

  await postFramesAndSettle(page, 8);

  await expect.poll(() => getSpriteCount(page), { timeout: 3_000 }).toBe(1);
});

test('remove wreck → wreckSpriteCount returns to 0', async ({ page }) => {
  test.setTimeout(25_000);

  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__wreckProbe!.pushWreck('wreck-A', 100, 50);
  });
  await postFramesAndSettle(page, 8);
  await expect.poll(() => getSpriteCount(page), { timeout: 3_000 }).toBe(1);

  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__wreckProbe!.removeWreck('wreck-A');
  });
  expect(await getMirrorCount(page)).toBe(0);
  await postFramesAndSettle(page, 8);

  await expect.poll(() => getSpriteCount(page), { timeout: 3_000 }).toBe(0);
});

test('multiple wrecks → wreckSpriteCount tracks the mirror.wrecks size', async ({ page }) => {
  test.setTimeout(25_000);

  await page.evaluate(() => {
    const probe = (window as unknown as ProbeWindow).__wreckProbe!;
    probe.pushWreck('wreck-A', 100, 50);
    probe.pushWreck('wreck-B', -200, 80);
    probe.pushWreck('wreck-C', 300, -150);
  });
  expect(await getMirrorCount(page)).toBe(3);

  await postFramesAndSettle(page, 8);
  await expect.poll(() => getSpriteCount(page), { timeout: 3_000 }).toBe(3);

  // Remove one — count drops to 2.
  await page.evaluate(() => {
    (window as unknown as ProbeWindow).__wreckProbe!.removeWreck('wreck-B');
  });
  await postFramesAndSettle(page, 8);
  await expect.poll(() => getSpriteCount(page), { timeout: 3_000 }).toBe(2);
});
