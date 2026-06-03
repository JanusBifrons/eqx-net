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
 * timeouts"): fire is driven by the framework's `__eqxClient.triggerFireForTest`
 * hook, NOT synthetic keyboard events (headless keyboard focus + the
 * wall-clock-anchored per-RAF fire dispatch made `keyboard.down('Space')`
 * flaky). The trigger calls the same `sendFire` path directly. Because the
 * fired weapon resolves from the local ship's MIRROR kind (set by the first
 * snapshot, not instantly on join), each fire test RE-FIRES inside a
 * `waitForFunction` until the visual appears — self-settling past the spawn
 * window with no fixed sleep, and the wait succeeding IS the assertion. Room
 * is the controlled `test-sector-fast` engineering room (testMode, no drones,
 * 10× time so case 4's ghost-TTL expiry is a few hundred ms).
 */
import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function joinClient(browser: Browser, shipKind = 'scout') {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}?room=test-sector-fast&shipKind=${shipKind}`);
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 12000 },
  );
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
    // The slot selector mounts once the HUD has the local ship kind (which
    // arrives with the first snapshots, not instantly on join) — generous
    // render-settle window, not a game-time wait.
    await expect(page.locator('[data-testid="slot-selector"]')).toBeVisible({ timeout: 10_000 });
  } finally {
    await ctx.close();
  }
});

// ---------------------------------------------------------------------------
// 2. A bolt ship fires PROJECTILES, never a hitscan beam
// ---------------------------------------------------------------------------
test('a scout (bolt loadout) fires projectiles, not a beam', async ({ browser }) => {
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    // Re-fire until a projectile (ghost bolt) registers — self-settles past
    // the spawn window where the mirror kind isn't set yet.
    await page.waitForFunction(
      () => {
        (window as unknown as { __eqxClient?: { triggerFireForTest(id: string): boolean } })
          .__eqxClient?.triggerFireForTest('laser');
        const el = document.querySelector('[data-testid="game-surface"]');
        return (
          el !== null &&
          parseInt(el.getAttribute('data-projectile-count') ?? '0', 10) > 0 &&
          el.getAttribute('data-beam-active') !== '1'
        );
      },
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
  const { ctx, page } = await joinClient(browser, 'interceptor');
  try {
    // Re-fire until the beam is active — the wait succeeding IS the assertion
    // (the live beam only persists ~220 ms per fire, so a post-wait read would
    // race the fade).
    await page.waitForFunction(
      () => {
        (window as unknown as { __eqxClient?: { triggerFireForTest(id: string): boolean } })
          .__eqxClient?.triggerFireForTest('hitscan');
        return document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-beam-active') === '1';
      },
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
  const { ctx, page } = await joinClient(browser, 'scout');
  try {
    // Fire (re-trying past the spawn window) until a ghost exists…
    await page.waitForFunction(
      () => {
        (window as unknown as { __eqxClient?: { triggerFireForTest(id: string): boolean } })
          .__eqxClient?.triggerFireForTest('laser');
        const el = document.querySelector('[data-testid="game-surface"]');
        return el !== null && parseInt(el.getAttribute('data-projectile-count') ?? '0', 10) > 0;
      },
      { timeout: 10_000 },
    );
    // …then STOP firing and wait for it to expire (ghost TTL + projectile
    // lifetime, compressed 10× in test-sector-fast). The point is the ghost
    // ISN'T stuck at its spawn position.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="game-surface"]');
        return el !== null && parseInt(el.getAttribute('data-projectile-count') ?? '0', 10) === 0;
      },
      { timeout: 10_000 },
    );
    expect(await getProjectileCount(page)).toBe(0);
  } finally {
    await ctx.close();
  }
});
