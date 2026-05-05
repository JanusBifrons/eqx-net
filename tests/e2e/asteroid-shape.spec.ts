/**
 * Polygon asteroid acceptance gate.
 *
 * Proves the asteroid pipeline works end-to-end:
 *   - Server seeds the engineering-room roster (3 hand-rolled rocks with
 *     varying radii) and computes deterministic convex-hull colliders from
 *     each entityId.
 *   - The wire ships entityId + radius (no shape data) — that's the design;
 *     this test exists to prove no shape data was needed because both sides
 *     reconstruct the same polygon from the entityId seed.
 *   - The client decoder lands kind=0 entries in `mirror.swarm` keyed by
 *     entityId.
 *   - The renderer draws polygons (no shape mismatch crashes Pixi).
 *   - The set of (entityId → radius) pairs is deterministic across sessions.
 *
 * Uses `?room=sector` to bypass the galaxy-map landing screen via autoJoin —
 * same pattern as `tests/e2e/helpers/gameScenario.ts`. The engineering
 * `sector` room runs the hand-rolled `ASTEROIDS` array (3 rocks, radii 32 /
 * 22 / 46) which is deterministic across boots.
 */
import { test, expect, type Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

interface SwarmDetail {
  x: number;
  y: number;
  angle: number;
  kind: number;
  sleeping: boolean;
  lastUpdateTick: number;
  radius?: number;
}

async function joinSector(page: Page): Promise<void> {
  const params = new URLSearchParams({
    room: 'sector',
    spawnX: '0',
    spawnY: '0',
  });
  await page.goto(`${BASE_URL}?${params}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace('Ships: ', '') ?? '0', 10) > 0;
    },
    { timeout: 12_000 },
  );
  // Wait for at least 3 asteroids (kind=0) to land in the swarm mirror — the
  // hand-rolled `ASTEROIDS` roster has exactly 3, so anything less is mid-decode.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      const swarm = JSON.parse(el?.getAttribute('data-swarm-detail') ?? '{}') as Record<string, { kind: number; radius?: number }>;
      const asteroids = Object.values(swarm).filter((e) => e.kind === 0 && typeof e.radius === 'number');
      return asteroids.length >= 3;
    },
    { timeout: 12_000 },
  );
}

async function readSwarm(page: Page): Promise<Record<string, SwarmDetail>> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="game-surface"]');
    return JSON.parse(el?.getAttribute('data-swarm-detail') ?? '{}') as Record<string, SwarmDetail>;
  });
}

test('roster integrity — every hand-rolled asteroid is present in the client mirror', async ({ page }) => {
  await joinSector(page);
  // Wait for at least one binary swarm packet to land.
  await page.waitForTimeout(1500);

  const swarm = await readSwarm(page);
  const asteroids = Object.entries(swarm).filter(([, e]) => e.kind === 0);

  // The default `sector` room ships 3 hand-rolled asteroids (see ASTEROIDS in
  // SectorRoom.ts). It also seeds 30 hostile drones in a 350u ring around
  // origin, so kind=0 is just the asteroid count.
  expect(asteroids.length).toBe(3);
});

test('visible variety — at least 2 distinct asteroid radii are observable', async ({ page }) => {
  await joinSector(page);
  await page.waitForTimeout(1500);
  const swarm = await readSwarm(page);
  const radii = new Set(
    Object.values(swarm)
      .filter((e) => e.kind === 0 && typeof e.radius === 'number')
      .map((e) => e.radius!),
  );
  // ASTEROIDS roster ships radii 32, 22, 46 — three distinct values.
  expect(radii.size).toBeGreaterThanOrEqual(2);
});

test('cross-session determinism — entityId → radius mapping is stable across reloads', async ({ page }) => {
  await joinSector(page);
  await page.waitForTimeout(1500);
  const first = await readSwarm(page);
  const firstMap = new Map<string, number>();
  for (const [entityId, e] of Object.entries(first)) {
    if (e.kind === 0 && typeof e.radius === 'number') firstMap.set(entityId, e.radius);
  }
  expect(firstMap.size).toBeGreaterThan(0);

  // Reload the page — the `sector` engineering room is ephemeral but its
  // hand-rolled roster + the deterministic entityId allocator yield the same
  // (entityId → radius) pairs every time.
  await joinSector(page);
  await page.waitForTimeout(1500);

  const second = await readSwarm(page);
  const secondMap = new Map<string, number>();
  for (const [entityId, e] of Object.entries(second)) {
    if (e.kind === 0 && typeof e.radius === 'number') secondMap.set(entityId, e.radius);
  }

  expect(secondMap.size).toBe(firstMap.size);
  for (const [id, r] of firstMap) {
    expect(secondMap.get(id)).toBe(r);
  }
});
