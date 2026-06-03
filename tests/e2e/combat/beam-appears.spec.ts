/**
 * Deterministic combat split (2026-06-03, test-coverage-audit Phase 3) — was
 * combat.spec.ts tests 1+2, which held Space on `?room=sector` random ships.
 *
 * Only the interceptor fires a hitscan beam (`data-beam-active`) post weapons
 * rebalance. Spawn one in the engineering room (`test-sector`) and assert the
 * beam tracks the Space key. No target needed — the beam is visible whenever
 * the hold-beam hitscan is active.
 */
import { test, expect } from '@playwright/test';
import { launchTestClient, getBeamActive } from '../helpers/gameScenario';

test('hitscan beam appears while Space is held and clears on release', async ({ browser }) => {
  const { ctx, page } = await launchTestClient(browser, {
    spawnX: 0,
    spawnY: 0,
    shipKind: 'interceptor',
  });
  try {
    await page.keyboard.down('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      { timeout: 2_000 },
    );
    expect(await getBeamActive(page)).toBe(true);

    await page.keyboard.up('Space');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '0',
      { timeout: 2_000 },
    );
    expect(await getBeamActive(page)).toBe(false);
  } finally {
    await page.keyboard.up('Space').catch(() => undefined);
    await ctx.close();
  }
});
