/**
 * Living World — player-visible E2E (Invariant #9).
 *
 * The deterministic lifecycle edge cases (no-origin respawn after a
 * combat kill, shed-and-pause/refill, the guarded transition state
 * machine) are locked at the integration level
 * (tests/integration/sectorRoom/livingWorldDirector.test.ts) — that is
 * the level those bugs live at and where they run fast + deterministic.
 *
 * This E2E locks the end-to-end player-facing essence that integration
 * can't see: a real browser client joins a galaxy sector, and the
 * process-global LivingWorldDirector → SectorRoom hooks → swarm wire →
 * client pipeline actually makes hunter bots warp across sectors and
 * converge on the player's sector, visible in the HUD.
 *
 * Every assertion is OUTCOME-gated (poll /dev/population + HUD testids),
 * never perf/tick-gated, so a slow CI/worktree env just takes longer
 * rather than flaking (DETERMINISM.md philosophy).
 */
import { test, expect } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';
const SERVER_URL = process.env['PLAYWRIGHT_SERVER_URL'] ?? 'http://localhost:2567';

interface PopulationSnapshot {
  total: number;
  active: number;
  inTransit: number;
  respawning: number;
  perSector: Record<string, { players: number; bots: number }>;
}

async function getPopulation(): Promise<PopulationSnapshot | { ready: false }> {
  const res = await fetch(`${SERVER_URL}/dev/population`);
  return (await res.json()) as PopulationSnapshot | { ready: false };
}

test('living world: hunter bots converge on the sector the player is in', async ({ browser }) => {
  // Production director timings (1.5 s control tick, 3 s spool, 25 bots,
  // ≤4 transits/tick) mean convergence is tens of seconds; generous,
  // outcome-gated windows absorb a slow env.
  test.setTimeout(180_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // 1. The director seeds exactly 25 bots at boot, spread across the 7
  //    galaxy sectors. Lock the population invariant before joining.
  await expect
    .poll(async () => {
      const p = await getPopulation();
      return 'total' in p ? p.total : -1;
    }, { timeout: 40_000, intervals: [1000], message: '25 bots seeded at boot' })
    .toBe(25);

  // 2. Join galaxy-sol-prime as a real player.
  await page.goto(`${BASE_URL}/?galaxy=sol-prime`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await expect(page.locator('[data-testid="ship-stats-card"]')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="ship-count"]');
      return el !== null && parseInt(el.textContent?.replace(/\D+/g, '') ?? '0', 10) > 0;
    },
    { timeout: 30_000 },
  );

  // 3. With a player only in sol-prime, computeDesiredDistribution
  //    funnels the whole population there; planMigrations + the bot
  //    transit pipeline warp them across sectors. Poll until a clear
  //    majority has arrived (full 25 is slower under prod timings + the
  //    arrival cooldown — a strong majority proves the mechanism).
  await expect
    .poll(async () => {
      const p = await getPopulation();
      if (!('perSector' in p)) return -1;
      return p.perSector['sol-prime']?.bots ?? -1;
    }, {
      timeout: 130_000,
      intervals: [2000],
      message: 'hunter bots should converge on sol-prime (the player sector)',
    })
    .toBeGreaterThanOrEqual(13);

  // 4. Invariant still holds end-to-end; the player IS registered in the
  //    sector the bots converged on.
  const final = await getPopulation();
  expect('total' in final ? final.total : -1).toBe(25);
  expect('perSector' in final ? final.perSector['sol-prime']!.players : 0).toBeGreaterThanOrEqual(1);

  // 5. Player-visible: bots that reached sol-prime and hunt the player
  //    enter the client interest set, so the HUD swarm count is > 0.
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="swarm-count"]');
      return el !== null && parseInt(el.textContent?.replace(/\D+/g, '') ?? '0', 10) > 0;
    },
    { timeout: 30_000 },
  );

  await ctx.close();
});
