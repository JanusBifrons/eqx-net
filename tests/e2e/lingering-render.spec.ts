import { test, expect } from '@playwright/test';

/**
 * WS-12 / R2.32 — a lingering (parked) hull must render its weapon barrels.
 *
 * Worker-boundary lock (Invariant #13 / the 2026-05-14 damage-number incident
 * class): the bug — `PixiRenderer.updateLingeringShips` built only a bare
 * silhouette with NO `MountVisualManager` cluster — lives across the
 * `WorkerRendererClient ↔ renderer.worker` structured-clone boundary (the
 * production touch default is the worker path, and `mirror.lingeringShips` is
 * cloned across postMessage every frame). So this drives a REAL
 * `WorkerRendererClient` via the lingering-render probe page and reads the
 * ACTUAL drawn mount-cluster size (`getFeedback().mountCounts`), not a recompute
 * — a bare `PixiRenderer` unit test would pass against the bug (wrong level).
 *
 * Failing-first: pre-R2.32 the lingering hull had no cluster → mount count 0.
 */
const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface LingerProbeApi {
  seedLingering: (shieldDown: boolean) => void;
  postFrame: () => void;
  getMountCount: () => number;
}
interface ProbeWindow extends Window {
  __lingerProbe?: LingerProbeApi;
}

test('a lingering hull renders its weapon barrels across the worker boundary', async ({ page }) => {
  test.setTimeout(20_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`));

  await page.goto(`${BASE_URL}/__offscreen-spike__/lingering-render-probe.html`, {
    waitUntil: 'domcontentloaded',
    timeout: 10_000,
  });
  await page.waitForFunction(
    () => (window as unknown as ProbeWindow).__lingerProbe !== undefined,
    { timeout: 10_000 },
  );

  // Seed an interceptor lingering hull (two wing mounts) — it has a shield up,
  // so the silhouette + barrels are what we assert here.
  await page.evaluate(() => (window as unknown as ProbeWindow).__lingerProbe!.seedLingering(false));

  // Pump frames until the worker has built the sprite + mount cluster and
  // reported the real cluster size back across the FEEDBACK boundary. Pre-fix
  // this stays 0 (no cluster ever built) and the poll times out.
  await expect
    .poll(
      async () => {
        await page.evaluate(() => (window as unknown as ProbeWindow).__lingerProbe!.postFrame());
        return page.evaluate(() => (window as unknown as ProbeWindow).__lingerProbe!.getMountCount());
      },
      {
        message:
          'the parked lingering hull must draw its weapon barrels (mount cluster > 0) — ' +
          'pre-R2.32 updateLingeringShips built only a bare silhouette',
        timeout: 12_000,
      },
    )
    .toBeGreaterThan(0);

  expect(errors, errors.join('\n')).toHaveLength(0);
});
