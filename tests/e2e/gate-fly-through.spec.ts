/**
 * Phase V gates (plan soft-leaping-truffle v2) — a ship flies through a Shield
 * Gate that admits it, and is stopped by one that doesn't. Crosses every seam
 * the feature spans: the server GateController opening the gate as the ship
 * approaches, the room-state open bit reaching the client, the client
 * prediction world dropping the span collider (derived walls), and the server
 * worker doing the same — so the rendered ship neither snaps back at an open
 * gate nor slips through a closed one.
 *
 * `gate-test` room (scenarioLayouts.GATE_TEST): two powered gates on y = −900.
 * West (x −400) opens for anyone not hostile; east (x 400) is owner-only and
 * owned by `scenario`, so a visiting pilot is locked out. The ship spawns 400 u
 * south of a gate facing +y and holds thrust + boost.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const GATE_Y = -900;

// Infra budget: cold Vite compile + join + settle. The flight itself is ~3 s.
test.setTimeout(60_000);

async function joinAt(page: Page, x: number): Promise<void> {
  await page.goto(`${BASE_URL}?room=gate-test&testId=${randomUUID()}&spawnX=${x}&spawnY=-1300`);
  await page.waitForFunction(
    () => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats');
      if (!raw) return false;
      try {
        return ((JSON.parse(raw) as { snapshotCount?: number }).snapshotCount ?? 0) >= 30;
      } catch {
        return false;
      }
    },
    { timeout: 30_000 },
  );
}

async function localY(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-ship-positions');
    if (!raw) return null;
    try {
      const ys = Object.values(JSON.parse(raw) as Record<string, { y: number }>).map((p) => p.y);
      return ys.length > 0 ? Math.max(...ys) : null;
    } catch {
      return null;
    }
  });
}

/** Hold thrust + boost north for ~3 s; return the furthest-north rendered y. */
async function flyNorth(page: Page): Promise<number> {
  await page.locator('[data-testid="game-surface"]').click();
  let peak = -Infinity;
  await page.keyboard.down('w');
  await page.keyboard.down('Shift');
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(100);
    const y = await localY(page);
    if (y !== null && y > peak) peak = y;
  }
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  return peak;
}

test('a ship flies through a gate that admits it', async ({ page }) => {
  await joinAt(page, -400);
  const start = await localY(page);
  expect(start, 'spawned south of the gate').not.toBeNull();
  expect(start!).toBeLessThan(GATE_Y - 200);
  const peak = await flyNorth(page);
  // eslint-disable-next-line no-console
  console.log(`open gate: start y=${start!.toFixed(0)}, peak y=${peak.toFixed(0)} (span at ${GATE_Y})`);
  expect(peak, 'the ship crossed the open gate').toBeGreaterThan(GATE_Y + 150);
});

test('a ship is stopped by a gate that does not admit it', async ({ page }) => {
  await joinAt(page, 400);
  const peak = await flyNorth(page);
  // eslint-disable-next-line no-console
  console.log(`locked gate: peak y=${peak.toFixed(0)} (span at ${GATE_Y})`);
  // The span's near face is at y −911; a stopped ship's centre stays south of it.
  expect(peak, 'the closed span stopped the ship').toBeLessThan(GATE_Y);
});
