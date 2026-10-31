/**
 * Procedural bases — destructible pieces end to end (plan: soft-leaping-truffle, PR-D).
 *
 * In the `base-warehouse-destructible` room (the showcase warehouse with pieces
 * at 2 % hit points — the bespoke trigger that keeps this a seconds-long test):
 *  1. an interceptor parked 150 u from a rack's face, nose at it, holds fire;
 *  2. the server breaks the rack → destroy bits in room state → the client
 *     renderer diffs them and spawns DEBRIS (`__eqxBaseDebris > 0`);
 *  3. the ship then flies forward THROUGH the hole — so the server worker AND
 *     the client predWorld both rebuilt their colliders (a client that kept
 *     the old collider would predict a stop and get yanked forward instead).
 * `?worker=0` for the DEV hooks.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { generateBase } from '../../src/core/procgen/generateBase.js';
import { BASE_GENERATOR_VERSION } from '../../src/core/procgen/baseLayout.js';
import { basePieceIndex } from '../../src/shared-types/basePieceKinds.js';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
// Must match the room definition in src/server/index.ts.
const layout = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: 42, x: 0, y: 0, size: 8000 });

/** A rack whose LEFT face has open floor in front of it (the perimeter road). */
function targetRack(): { faceX: number; y: number; farX: number } {
  const rack = basePieceIndex('rack_row');
  let best = -1;
  for (let i = 0; i < layout.count; i++) {
    if (layout.kind[i] !== rack || layout.h[i]! < layout.w[i]!) continue; // vertical racks: thin along x
    if (best < 0 || layout.x[i]! < layout.x[best]!) best = i;
  }
  if (best < 0) throw new Error('no vertical rack');
  return { faceX: layout.x[best]!, y: layout.y[best]! + layout.h[best]! / 2, farX: layout.x[best]! + layout.w[best]! };
}

test('a beamed rack breaks into debris and the ship flies through the hole', async ({ page }) => {
  // Infrastructural budget only (cold Vite compile + room create + join).
  test.setTimeout(120_000);
  const t = targetRack();
  const params = new URLSearchParams({
    room: 'base-warehouse-destructible',
    testId: randomUUID(),
    worker: '0',
    diag: '0',
    zoom: '0.7',
    shipKind: 'interceptor',
    spawnX: String(t.faceX - 150),
    spawnY: String(t.y),
    initialAngle: String(-Math.PI / 2), // nose along +x, at the rack
  });
  await page.goto(`${BASE_URL}?${params}`);
  await expect(page.locator('[data-testid="warp-screen"]')).toHaveAttribute('data-warp-visible', '0', { timeout: 90_000 });
  await page.waitForFunction(() => (globalThis as { __eqxBaseCount?: number }).__eqxBaseCount === 1, undefined, { timeout: 10_000 });

  const readX = (): Promise<number | null> =>
    page.evaluate(() => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions');
      const pid = localStorage.getItem('eqxAccountPlayerId') ?? localStorage.getItem('eqxPlayerId') ?? '';
      if (!raw) return null;
      const p = (JSON.parse(raw) as Record<string, { x: number; y: number }>)[pid];
      return p ? p.x : null;
    });

  // 1–2. Hold fire until debris appears (the rack broke).
  await page.keyboard.down('Space');
  await page.waitForFunction(() => ((globalThis as { __eqxBaseDebris?: number }).__eqxBaseDebris ?? 0) > 0, undefined, { timeout: 15_000 });
  mkdirSync('diag/e2e-screenshots/bases', { recursive: true });
  await page.screenshot({ path: 'diag/e2e-screenshots/bases/rack-destroyed.png' });
  await page.keyboard.up('Space');

  // 3. Fly forward through where the rack was.
  await page.keyboard.down('w');
  await page.waitForFunction(
    (farX) => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions');
      const pid = localStorage.getItem('eqxAccountPlayerId') ?? localStorage.getItem('eqxPlayerId') ?? '';
      const p = raw ? (JSON.parse(raw) as Record<string, { x: number }>)[pid] : undefined;
      return !!p && p.x > farX + 40;
    },
    t.farX,
    { timeout: 10_000 },
  );
  await page.keyboard.up('w');
  expect((await readX())!).toBeGreaterThan(t.farX);
});
