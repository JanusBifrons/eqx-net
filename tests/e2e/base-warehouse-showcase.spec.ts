/**
 * Procedural bases — vertical slice end to end (plan: soft-leaping-truffle, PR-V2).
 *
 * In the real browser + real server, in the `base-warehouse-showcase` room
 * (one 8000 u warehouse at the origin):
 *  1. the base renders (main-thread renderer DEV hooks: one base, chunks drawn);
 *  2. a ship holding thrust straight into the south wall — away from any gate —
 *     is STOPPED, and the displayed (client-predicted) pose NEVER overshoots
 *     into the wall. A client whose predWorld lacked the base colliders would
 *     predict straight through and get yanked back on reconcile; sampling the
 *     pose throughout the hold catches exactly that (two-sided contract,
 *     Invariant #15);
 *  3. a screenshot is written for visual review.
 * Runs `?worker=0` (the DEV hooks + screenshot need the DOM render path).
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { generateBase } from '../../src/core/procgen/generateBase.js';
import { BASE_GENERATOR_VERSION } from '../../src/core/procgen/baseLayout.js';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
// Must match the room definition in src/server/index.ts.
const layout = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: 42, x: 0, y: 0, size: 8000 });
const SOUTH = -layout.half;

/** An x on the south wall at least 600 u from every south gate. */
function solidSouthX(): number {
  const gates: number[] = [];
  for (let g = 0; g < layout.gates.length; g += 2) if (layout.gates[g + 1] === SOUTH) gates.push(layout.gates[g]!);
  for (let x = -layout.half + 400; x < layout.half - 400; x += 50) {
    if (gates.every((gx) => Math.abs(gx - x) > 600)) return x;
  }
  throw new Error('no solid stretch on the south wall');
}

test('warehouse base: renders, and a ship flying into the wall is stopped without predicted overshoot', async ({ page }) => {
  // Infrastructural budget only (cold Vite compile + first room create + join
  // on a freshly spawned CI server). The game-time part (the wall approach) is
  // ~3 s and has its own bounded loop below.
  test.setTimeout(120_000);
  const x = solidSouthX();
  const startY = SOUTH - 500;
  const params = new URLSearchParams({
    room: 'base-warehouse-showcase',
    testId: randomUUID(),
    worker: '0',
    diag: '0',
    zoom: '0.6',
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

  // 1. The base renders.
  await page.waitForFunction(() => (globalThis as { __eqxBaseCount?: number }).__eqxBaseCount === 1, undefined, { timeout: 10_000 });
  await page.waitForFunction(() => ((globalThis as { __eqxBaseVisibleChunks?: number }).__eqxBaseVisibleChunks ?? 0) > 0, undefined, { timeout: 10_000 });

  // 2. Fly straight into the south wall (angle 0 → nose +y).
  const readY = (): Promise<number | null> =>
    page.evaluate(() => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions');
      const pid = localStorage.getItem('eqxAccountPlayerId') ?? localStorage.getItem('eqxPlayerId') ?? '';
      if (!raw) return null;
      const p = (JSON.parse(raw) as Record<string, { x: number; y: number }>)[pid];
      return p ? p.y : null;
    });
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
  await page.screenshot({ path: 'diag/e2e-screenshots/bases/warehouse-wall-stop.png' });

  // It really flew toward the wall…
  expect(endY).toBeGreaterThan(startY + 250);
  // …was stopped outside it…
  expect(endY).toBeLessThan(SOUTH);
  // …and the PREDICTED pose never went into the wall (no client/server
  // collider disagreement). Ship radius ≈ 10–24; allow the contact skin.
  expect(maxY).toBeLessThan(SOUTH + 10);
});
