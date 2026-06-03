/**
 * 2026-06-03 deterministic rewrite (test-coverage-audit Phase 3) — was a
 * random spray-and-sweep with a weak `<=` assertion ("random sweep may miss
 * everything if RNG is unkind"), which provided no real coverage when the
 * sweep missed.
 *
 * Deterministic geometry via the `combat-drone-test` room: ONE peaceful
 * (PassiveDroneBehaviour → stationary), hull-exposed heavy (kind=1, 540 HP)
 * parked at (0,200). An interceptor at (0,0)/angle0 fires a hitscan beam
 * straight up +y (200u < 250u range) and is GUARANTEED to destroy it. Hard
 * assertion: the drone count drops by EXACTLY 1 (1 → 0).
 */
import { test, expect, type Page } from '@playwright/test';
import { launchTestClient } from './helpers/gameScenario';

async function droneCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-swarm-detail') ?? '{}';
    return Object.values(JSON.parse(raw) as Record<string, { kind: number }>).filter((e) => e.kind === 1).length;
  });
}

test('hitscan beam destroys a parked drone: count drops by exactly 1', async ({ browser }) => {
  const { ctx, page } = await launchTestClient(browser, {
    room: 'combat-drone-test',
    spawnX: 0,
    spawnY: 0,
    initialAngle: 0,
    shipKind: 'interceptor',
  });
  try {
    // Wait for the seeded drone to appear in the swarm mirror.
    await page.waitForFunction(
      () => {
        const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-swarm-detail') ?? '{}';
        return Object.values(JSON.parse(raw) as Record<string, { kind: number }>).filter((e) => e.kind === 1).length === 1;
      },
      undefined,
      { timeout: 10_000 },
    );
    const initial = await droneCount(page);
    expect(initial).toBe(1);

    // Hold fire: the interceptor's beam (≈156 DPS) destroys the 540-HP heavy
    // in ~3.5 s. The drone is stationary, so the x=0 beam keeps landing.
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => {
        const raw = document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-swarm-detail') ?? '{}';
        return Object.values(JSON.parse(raw) as Record<string, { kind: number }>).filter((e) => e.kind === 1).length === 0;
      },
      undefined,
      { timeout: 8_000 },
    );
    expect(await droneCount(page)).toBe(initial - 1);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});
