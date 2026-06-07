/**
 * Click-to-inspect (structures follow-up Item B) — selection bracket + live
 * stats panel, end-to-end.
 *
 * Drives the FULL pick → select → RendererFeedback.selectedPickId → Zustand →
 * EntityStatsPanel + the server `select_entity` → `entity_stats` stream. Uses
 * the `auto-fire-test` room (one drone 150 u ahead). Selection is driven via
 * the DEV `__eqxSelectAtWorld(x, y)` hook (the deterministic peer of
 * `__eqxGalaxyPick`) at the drone's KNOWN world position read from
 * `data-swarm-detail` — this bypasses screen→world projection fragility while
 * still exercising the real `pickEntityAt` + selection-publish path. The
 * observability is `RendererFeedback.selectedPickId` (NOT a recompute), surfaced
 * as `data-selected-pick-id`.
 *
 *   - tap a drone  → selectedPickId points at it (`swarm-<id>`, kind `drone`)
 *                    AND the stats panel shows the drone's hp (from the mirror)
 *   - re-select empty space → both gone
 *
 * `?worker=0` forces the main-thread PixiRenderer (the only path that exposes
 * `__eqxSelectAtWorld`).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test('tap a drone shows the selection bracket + a stats panel; empty tap clears it', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'auto-fire-test',
    shipKind: 'scout',
    initialHull: '5000',
    worker: '0', // main-thread renderer → __eqxSelectAtWorld available
    testId: randomUUID(),
  });
  await page.goto(`${BASE_URL}?${params}`);

  const surface = page.locator('[data-testid="game-surface"]');

  // Wait for the local player + at least one drone (kind 1) in the swarm detail.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      if (!el || el.getAttribute('data-local-player-id') === '') return false;
      const raw = el.getAttribute('data-swarm-detail');
      if (!raw) return false;
      try {
        const detail = JSON.parse(raw) as Record<string, { kind: number }>;
        return Object.values(detail).some((d) => d.kind === 1);
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: 15000 },
  );

  // Find the drone's world position from the swarm detail.
  const drone = await page.evaluate(() => {
    const raw = document.querySelector('[data-testid="game-surface"]')!.getAttribute('data-swarm-detail')!;
    const detail = JSON.parse(raw) as Record<string, { x: number; y: number; kind: number }>;
    const entry = Object.entries(detail).find(([, d]) => d.kind === 1);
    return entry ? { key: entry[0], x: entry[1].x, y: entry[1].y } : null;
  });
  expect(drone).not.toBeNull();

  // Deterministically select it at its world position.
  await page.evaluate(
    ([x, y]) => {
      (window as unknown as { __eqxSelectAtWorld?: (x: number, y: number) => string | null })
        .__eqxSelectAtWorld!(x as number, y as number);
    },
    [drone!.x, drone!.y],
  );

  // RendererFeedback.selectedPickId (published, not recomputed) names the drone.
  await page.waitForFunction(
    (expectedKey) => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-selected-pick-id') === expectedKey,
    drone!.key,
    { timeout: 5000 },
  );
  expect(await surface.getAttribute('data-selected-pick-kind')).toBe('drone');

  // The stats panel appears (drone hp read from the mirror, no server channel).
  await expect(page.locator('[data-testid="entity-stats-panel"]')).toBeVisible({ timeout: 5000 });

  // Re-select empty space far away → selection clears, panel hides.
  await page.evaluate(() => {
    (window as unknown as { __eqxSelectAtWorld?: (x: number, y: number) => string | null })
      .__eqxSelectAtWorld!(999999, 999999);
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-selected-pick-id') === null
      || !document.querySelector('[data-testid="game-surface"]')?.hasAttribute('data-selected-pick-id'),
    undefined,
    { timeout: 5000 },
  );
  await expect(page.locator('[data-testid="entity-stats-panel"]')).toHaveCount(0);

  await ctx.close();
});
