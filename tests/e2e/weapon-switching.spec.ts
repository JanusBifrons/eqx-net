/**
 * Weapon loadout E2E suite (weapons/energy/AI overhaul §5.2 — reworked from
 * the old per-weapon-picker suite).
 *
 * The per-weapon picker (Beam/Laser boxes + 1/2/Q hotkeys) is GONE. Each ship
 * fires its catalogue-bound loadout (scout/fighter/heavy/gunship → bolts,
 * interceptor → beams, missile-frigate → missiles) and the pilot selects the
 * active SLOT via the MUI SlotSelector. This suite asserts:
 *   1. No per-weapon picker; a single-slot toggle is present.
 *   2. A bolt ship (scout) fires PROJECTILES, never a hitscan beam.
 *   3. A beam ship (interceptor) fires a hitscan BEAM.
 *   4. The bolt ghost is cleaned up after expiry (no stuck duplicates).
 *
 * Determinism (test-harness philosophy — "bespoke trigger, never bump
 * timeouts"): lock-to-fire (2026-11-09) means a weapon group fires only at a
 * COMPLETED lock, so the fire tests join `auto-fire-test` (one peaceful drone
 * 150 u dead ahead, 10× time so case 4's ghost-TTL expiry is a few hundred
 * ms) with `instantLock=1`: the AUTO group locks the drone within ~0.1 s and
 * fires on its own — no synthetic keyboard (headless focus made Space flaky)
 * and no test-only fire hook. The wait succeeding IS the assertion.
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { toManual } from './helpers/fireControl';
import { waitForInPlay } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;

async function joinClient(browser: Browser, shipKind = 'scout', fire = false) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const room = fire ? 'auto-fire-test&instantLock=1&initialHull=5000' : 'test-sector-fast';
  await page.goto(`${BASE_URL}?room=${room}&shipKind=${shipKind}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    }, undefined,
    { timeout: 12000 },
  );
  // Fire (and the AUTO lock) only start once the loading curtain lifts.
  if (fire) await waitForInPlay(page);
  return { ctx, page };
}

function surface(page: Page) {
  return page.locator('[data-testid="game-surface"]');
}

async function getProjectileCount(page: Page): Promise<number> {
  return parseInt((await surface(page).getAttribute('data-projectile-count')) ?? '0', 10);
}

// ---------------------------------------------------------------------------
// 1. No per-weapon picker; the slot selector is present
// ---------------------------------------------------------------------------
test('slot selector replaces the per-weapon picker', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    // The old per-weapon boxes are gone.
    await expect(page.locator('[data-testid="weapon-selector"]')).toHaveCount(0);
    // Speed-dial UI refactor (Phase 1): slot selection moved out of the thumb
    // cluster into the consolidated SpeedDial. The action is in the DOM but
    // collapsed until the dial is opened — open it, then assert the slot action
    // is reachable. Generous render-settle window, not a game-time wait.
    await page.locator('[data-testid="speed-dial-fab"]').click({ timeout: 10_000 });
    await expect(page.locator('[data-testid="slot-selector"]')).toBeVisible({ timeout: 10_000 });
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 2. A bolt ship fires PROJECTILES, never a hitscan beam
// ---------------------------------------------------------------------------
test('a scout (bolt loadout) fires projectiles, not a beam', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout', true);
  try {
    // The AUTO group locks the drone ahead and fires; wait for a projectile
    // (ghost bolt) — the HUD/curtain and the lock are the only waits.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="game-surface"]');
        return (
          el !== null &&
          parseInt(el.getAttribute('data-projectile-count') ?? '0', 10) > 0 &&
          el.getAttribute('data-beam-active') !== '1'
        );
      }, undefined,
      { timeout: 10_000 },
    );
    // A bolt ship must NOT have an active hitscan beam.
    expect(await surface(page).getAttribute('data-beam-active')).not.toBe('1');
    expect(await getProjectileCount(page)).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 3. A beam ship fires a hitscan BEAM
// ---------------------------------------------------------------------------
test('an interceptor (beam loadout) fires a hitscan beam', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'interceptor', true);
  try {
    // The AUTO group locks the drone ahead and fires; wait for the beam — the
    // wait succeeding IS the assertion (the live beam only persists ~220 ms
    // per fire, so a post-wait read would race the fade).
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1',
      undefined,
      { timeout: 10_000 },
    );
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Regression: bolt ghost sprites are cleaned up after expiry
// ---------------------------------------------------------------------------
test('bolt ghost sprites are cleaned up after expiry — no static duplicates', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout', true);
  try {
    // The AUTO group fires at the drone until a ghost exists…
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="game-surface"]');
        return el !== null && parseInt(el.getAttribute('data-projectile-count') ?? '0', 10) > 0;
      }, undefined,
      { timeout: 10_000 },
    );
    // …then STOP firing (MAN drops the lock; nothing is held) and wait for it to expire (ghost TTL + projectile
    // lifetime, compressed 10× in test-sector-fast). The point is the ghost
    // ISN'T stuck at its spawn position.
    await toManual(page);
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="game-surface"]');
        return el !== null && parseInt(el.getAttribute('data-projectile-count') ?? '0', 10) === 0;
      }, undefined,
      { timeout: 10_000 },
    );
    expect(await getProjectileCount(page)).toBe(0);
  } finally {
    await ctx.close();
  }
});
