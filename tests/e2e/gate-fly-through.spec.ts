/**
 * Solid gate doors (plan docs/plans/door-power.md, slice 13) — a ship flies
 * through a Shield Gate that admits it once its doors are open, and is stopped
 * by the shut door leaves of one that doesn't. Crosses every seam the feature
 * spans: the server GateController steering the door segment as the ship
 * approaches, the segment reaching the client room-state row (decoded into
 * `doorA`), the rig posing the leaves as kinematic colliders in the server
 * worker and the client prediction world from the same `doorPosAt` clock, so
 * the rendered ship neither snaps back at an open gate nor slips through a
 * shut one.
 *
 * `gate-test` room (scenarioLayouts.GATE_TEST): two powered gates on y = −900.
 * West (x −400) opens for anyone not hostile; east (x 400) is owner-only and
 * owned by `scenario`, so a visiting pilot is locked out. The ship spawns 250 u
 * south of a gate facing +y — inside GATE_APPROACH_DEPTH (300 u), so an
 * admitted ship opens the doors without moving.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
const GATE_Y = -900;
const SPAWN_Y = -1150;
/** gateGeometry.DOOR_POS_MAX (3 s × 60 ticks × 15 levels): a fully open door. */
const DOOR_OPEN = 2700;

// Infra budget: cold Vite compile + join + settle. The doors take 3 s at full
// power and the flight ~3 s; the door wait below has its own bounded poll.
test.setTimeout(60_000);

async function joinAt(page: Page, x: number): Promise<void> {
  await page.goto(`${BASE_URL}?room=gate-test&testId=${randomUUID()}&spawnX=${x}&spawnY=${SPAWN_Y}`);
  await page.waitForFunction(
    () => {
      const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pred-stats');
      if (!raw) return false;
      try {
        return ((JSON.parse(raw) as { snapshotCount?: number }).snapshotCount ?? 0) >= 30;
      } catch {
        return false;
      }
    }, undefined,
    { timeout: 30_000 },
  );
  // Thrust only counts once the loading curtain lifts.
  await waitForInPlay(page);
}

/**
 * The gate at (gx, GATE_Y)'s door position on this client: its decoded
 * `doorA` segment read at the rig clock (`mirror.rigTick`). Inlines
 * core/structures/doorMotion.ts `doorPosAt` (one door clock; never integrate).
 * A gate row with no segment is a shut, still door (0), as the deck light
 * reads it. null until the gate's row and pose have arrived.
 */
async function doorPos(page: Page, gx: number): Promise<number | null> {
  return page.evaluate(([x, y]) => {
    interface Seg { p0: number; t0: number; dir: number; level: number }
    const m = (window as unknown as {
      __eqxClient?: { mirror?: {
        rigTick?: number;
        structures?: Map<number, { doorA?: Seg }>;
        swarm?: Map<number, { x: number; y: number }>;
      } };
    }).__eqxClient?.mirror;
    if (!m?.structures || !m.swarm || m.rigTick === undefined) return null;
    for (const [id, st] of m.structures) {
      const pose = m.swarm.get(id);
      if (!pose || Math.abs(pose.x - x) > 20 || Math.abs(pose.y - y) > 20) continue;
      const s = st.doorA;
      if (!s) return 0;
      const dt = m.rigTick > s.t0 ? m.rigTick - s.t0 : 0;
      return Math.min(2700, Math.max(0, Math.round(s.p0 + s.dir * s.level * dt)));
    }
    return null;
  }, [gx, GATE_Y] as const);
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

test('a gate that admits the ship opens its doors and the ship flies through', async ({ page }) => {
  await joinAt(page, -400);
  const start = await localY(page);
  expect(start, 'spawned south of the gate').not.toBeNull();
  expect(start!).toBeLessThan(GATE_Y - 200);
  // The ship waits inside the approach zone until the doors are fully open
  // (3 s of travel at full power) — a wait on door state, not a timeout.
  await expect
    .poll(() => doorPos(page, -400), { message: 'the admitting gate opened fully', timeout: 15_000 })
    .toBe(DOOR_OPEN);
  const peak = await flyNorth(page);
  console.log(`open gate: start y=${start!.toFixed(0)}, peak y=${peak.toFixed(0)} (doors at ${GATE_Y})`);
  expect(peak, 'the ship crossed the open gate').toBeGreaterThan(GATE_Y + 150);
});

test('the shut doors of a gate that does not admit the ship stop it', async ({ page }) => {
  await joinAt(page, 400);
  await expect.poll(() => doorPos(page, 400), { message: 'the locked gate is shut' }).toBe(0);
  const peak = await flyNorth(page);
  console.log(`locked gate: peak y=${peak.toFixed(0)} (doors at ${GATE_Y})`);
  // The shut leaves span the gap at y −900; a stopped ship's centre stays south.
  expect(peak, 'the shut door leaves stopped the ship').toBeLessThan(GATE_Y);
  expect(await doorPos(page, 400), 'the locked gate never opened').toBe(0);
});
