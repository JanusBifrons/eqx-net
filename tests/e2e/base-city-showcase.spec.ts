/**
 * Procedural bases — the CITY archetype end to end (plan: soft-leaping-truffle,
 * PR-K2).
 *
 * In the real browser + real server, in the `base-city-showcase` room (one
 * 8000 u city at the origin):
 *  1. the city renders (main-thread renderer DEV hooks: one base, chunks drawn);
 *  2. a ship in a street holding thrust north into a tower building is STOPPED,
 *     and the displayed (client-predicted) pose NEVER overshoots into it — the
 *     city kit's colliders exist on BOTH sides (two-sided contract, Invariant
 *     #15; the server side is locked in proceduralBase.test.ts);
 *  3. a screenshot is written for visual review / the showcase page.
 * Runs `?worker=0` (the DEV hooks + screenshot need the DOM render path).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { generateBase } from '../../src/core/procgen/generateBase.js';
import { BASE_GENERATOR_VERSION } from '../../src/core/procgen/baseLayout.js';
import { basePieceIndex, basePieceKindAt } from '../../src/shared-types/basePieceKinds.js';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
// Must match the room definition in src/server/index.ts.
const city = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'city', seed: 7, x: 0, y: 0, size: 8000 });

/** First solid piece face north of (x, y) within the ship's half-width. */
function firstSolidNorth(x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < city.count; i++) {
    if (!basePieceKindAt(city.kind[i]!).solid) continue;
    if (x + 40 > city.x[i]! && x - 40 < city.x[i]! + city.w[i]! && city.y[i]! >= y) best = Math.min(best, city.y[i]!);
  }
  return best;
}
function clear(x: number, y: number, r: number): boolean {
  for (let i = 0; i < city.count; i++) {
    if (!basePieceKindAt(city.kind[i]!).solid) continue;
    if (x + r > city.x[i]! && x - r < city.x[i]! + city.w[i]! && y + r > city.y[i]! && y - r < city.y[i]! + city.h[i]!) return false;
  }
  return true;
}
/** A street point south of the largest tower with ≥ 400 u run-up to the first building north. */
function streetStart(): { x: number; y: number; hitY: number } {
  const tower = basePieceIndex('tower');
  let t = -1;
  for (let i = 0; i < city.count; i++) if (city.kind[i] === tower && (t < 0 || city.w[i]! * city.h[i]! > city.w[t]! * city.h[t]!)) t = i;
  const x = city.x[t]! + Math.floor(city.w[t]! / 2);
  for (let y = city.y[t]! - 60; y > -city.half - 800; y -= 16) {
    const hitY = firstSolidNorth(x, y);
    if (clear(x, y, 60) && hitY - y >= 400) return { x, y, hitY };
  }
  throw new Error('no street south of the tower');
}

test('city base: renders, and a ship flying into a building is stopped without predicted overshoot', async ({ page }) => {
  // Infrastructural budget only (cold Vite compile + first room create + join).
  // The game-time part (the approach) is ~3 s with its own bounded loop.
  test.setTimeout(120_000);
  const { x, y: startY, hitY } = streetStart();
  const params = new URLSearchParams({
    room: 'base-city-showcase',
    testId: randomUUID(),
    worker: '0',
    diag: '0',
    zoom: '0.45',
    spawnX: String(x),
    spawnY: String(startY),
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => parseInt(document.querySelector('[data-testid="ship-count"]')?.textContent?.replace('Ships: ', '') ?? '0', 10) > 0,
    undefined,
    { timeout: 90_000 },
  );
  await expect(page.locator('[data-testid="warp-screen"]')).toHaveAttribute('data-warp-visible', '0', { timeout: 30_000 });

  // 1. The city renders.
  await page.waitForFunction(() => (globalThis as { __eqxBaseCount?: number }).__eqxBaseCount === 1, undefined, { timeout: 10_000 });
  await page.waitForFunction(() => ((globalThis as { __eqxBaseVisibleChunks?: number }).__eqxBaseVisibleChunks ?? 0) > 0, undefined, { timeout: 10_000 });

  // 2. Fly north into the building (angle 0 → nose +y).
  const readY = (): Promise<number | null> =>
    page.evaluate(() => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions');
      const pid = localStorage.getItem('eqxAccountPlayerId') ?? localStorage.getItem('eqxPlayerId') ?? '';
      if (!raw) return null;
      const p = (JSON.parse(raw) as Record<string, { x: number; y: number }>)[pid];
      return p ? p.y : null;
    });
  const y0 = (await readY()) ?? startY;
  await page.keyboard.down('w');
  let maxY = -Infinity;
  for (let i = 0; i < 40; i++) {
    const y = await readY();
    if (y !== null) maxY = Math.max(maxY, y);
    await page.waitForTimeout(75);
  }
  await page.keyboard.up('w');
  const endY = (await readY())!;

  mkdirSync('diag/e2e-screenshots/bases', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/bases/city-building-stop.png' });

  // It really flew toward the building…
  expect(endY).toBeGreaterThan(y0 + 200);
  // …was stopped short of it…
  expect(endY).toBeLessThan(hitY);
  // …and the PREDICTED pose never went into it (allow the contact skin).
  expect(maxY).toBeLessThan(hitY + 10);
});
