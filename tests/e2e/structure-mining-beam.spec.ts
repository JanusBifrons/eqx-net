import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * Equinox R2 WS-4 Phase 4 (R2.27) — the Miner's mining BEAM renders as a
 * distinct, isolatable amber drill beam on the client.
 *
 * The bug this locks: before Phase 4 the Miner's `laser_fired` (mountId
 * `drill`) was indistinguishable from a combat laser — it fell into the shared
 * `_remoteBeamPool`, so there was no way to assert "the mining beam is drawn"
 * without it being confounded by every other beam on screen. Phase 4 routes
 * the drill beam into a DEDICATED `_miningBeamPool` and publishes its real
 * drawn-sprite count (the pool's `liveCount`, NOT a recompute) as
 * `data-mining-beam-count`.
 *
 * Failing-first: `data-mining-beam-count` did not exist before Phase 4 (the
 * attribute is absent → the wait times out), and there was no dedicated pool
 * to count. This reads the ACTUAL rendered output per the "test observable
 * reads actual output" rule — a green-by-recompute beam attribute (e.g.
 * data-beam-from-x) would pass even if the drill beam were never drawn.
 *
 * Uses the pre-built `structure-scenario-test` room (powered Capital + 2 Solar
 * + a Miner parked next to an asteroid + a Turret) so the Miner is mining from
 * the first grid pulse — no place-ahead UI, no multi-second construction wait.
 * worker=0 keeps rendering on the main thread (the OffscreenCanvas worker path
 * screenshots/reads identically here, but main-thread is deterministic).
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinScenario(
  browser: Browser,
): Promise<{ ctx: Awaited<ReturnType<Browser['newContext']>>; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  // structureGridPulseMs=200 fast-forwards the grid pulse (bespoke trigger) so
  // the Miner acquires its target rock in ~200 ms instead of up to 1 s — the
  // mining beam (broadcast on the 100 ms turret tick once a target is set)
  // appears promptly, leaving headroom under the 30 s per-test cap for
  // cold-boot / software-WebGL latency rather than waiting out game-time.
  await page.goto(
    `${BASE_URL}?room=structure-scenario-test&worker=0&structureGridPulseMs=200&testId=${randomUUID()}`,
  );
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12_000 },
  );
  return { ctx, page };
}

test('the Miner draws a mining beam in the dedicated mining pool', async ({ browser }) => {
  const { ctx, page } = await joinScenario(browser);
  try {
    // Wait for the full scene to populate (5 structures + 1 asteroid + 1 drone)
    // so the Miner has a rock to mine.
    await page.waitForFunction(
      () =>
        parseInt(
          (document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0').replace(/\D/g, '') || '0',
          10,
        ) >= 6,
      undefined,
      { timeout: 12_000 },
    );

    // Once the grid pulse powers the Miner + acquires the rock, `tickMiners`
    // broadcasts the `drill` beam and the renderer routes it into the dedicated
    // mining pool → data-mining-beam-count climbs above 0. `expect.poll` reads
    // the live attribute and passes the MOMENT the beam is drawn (no separate
    // re-read that could land on a between-frames 0). Reads the real drawn count
    // (the pool's liveCount), so it only passes when the beam is ACTUALLY on
    // screen — not a recompute.
    await expect
      .poll(
        async () =>
          Number(
            (await page.locator('[data-testid="game-surface"]').getAttribute('data-mining-beam-count')) ?? '0',
          ),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});
