/**
 * Hover outline (WS-10 / R2.4) — the lighter `HoverBracket` drawn around the
 * entity the desktop pointer is over, end-to-end.
 *
 * Drives the FULL pick → `_hoveredId` → `RendererFeedback.hoveredPickId` →
 * `data-hover-pick-id` path. Uses the `auto-fire-test` room (one drone 150 u
 * ahead) and the DEV `__eqxHoverAtWorld(x, y)` hook (the deterministic peer of
 * `__eqxSelectAtWorld`) at the drone's KNOWN world position read from
 * `data-swarm-detail` — bypassing camera-projection fragility while still
 * exercising the real `pickEntityAt` + hover-publish path. The observable is the
 * REAL published id (`data-hover-pick-id`), never a recompute.
 *
 *   - hover a drone        → data-hover-pick-id is its `swarm-<id>`
 *   - hover empty space    → data-hover-pick-id clears to ''
 *
 * `?worker=0` forces the main-thread PixiRenderer (the only path that exposes
 * `__eqxHoverAtWorld`).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

test('hovering a drone publishes data-hover-pick-id; hovering empty space clears it', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const params = new URLSearchParams({
    room: 'auto-fire-test',
    shipKind: 'scout',
    initialHull: '5000',
    worker: '0', // main-thread renderer → __eqxHoverAtWorld available
    testId: randomUUID(),
  });
  await page.goto(`${BASE_URL}?${params}`);

  const surface = page.locator('[data-testid="game-surface"]');

  // Wait for the local player + at least one drone (kind 1).
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
    { timeout: 15_000 },
  );

  const drone = await page.evaluate(() => {
    const raw = document.querySelector('[data-testid="game-surface"]')!.getAttribute('data-swarm-detail')!;
    const detail = JSON.parse(raw) as Record<string, { x: number; y: number; kind: number }>;
    const entry = Object.entries(detail).find(([, d]) => d.kind === 1);
    return entry ? { key: entry[0], x: entry[1].x, y: entry[1].y } : null;
  });
  expect(drone).not.toBeNull();

  // Hover the drone deterministically at its world position.
  await page.evaluate(
    ([x, y]) => {
      (window as unknown as { __eqxHoverAtWorld?: (x: number, y: number) => string | null })
        .__eqxHoverAtWorld!(x as number, y as number);
    },
    [drone!.x, drone!.y],
  );

  // The REAL published hover id names the drone (not a recompute).
  await page.waitForFunction(
    (expectedKey) => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-hover-pick-id') === expectedKey,
    drone!.key,
    { timeout: 5_000 },
  );
  expect(await surface.getAttribute('data-hover-pick-id')).toBe(drone!.key);

  // Hover empty space far away → the hover id clears to ''.
  await page.evaluate(() => {
    (window as unknown as { __eqxHoverAtWorld?: (x: number, y: number) => string | null })
      .__eqxHoverAtWorld!(999_999, 999_999);
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-hover-pick-id') === '',
    undefined,
    { timeout: 5_000 },
  );
  expect(await surface.getAttribute('data-hover-pick-id')).toBe('');

  await ctx.close();
});
