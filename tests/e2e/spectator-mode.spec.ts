import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

/**
 * Phase 4 WS-A1 — Spectator / Construction mode (locked decisions D3–D7).
 *
 * On the local ship's death the client must transition INSTANTLY into spectator
 * (NO death modal — the old DeathOverlay "You Died/Respawn" path is removed),
 * detach the follow camera (free-roam), swap input to pan/zoom (no fire/thrust),
 * and still allow full construction with no ship. A speed-dial toggle round-
 * trips pilot↔spectator.
 *
 * Determinism: spectator is a CLIENT-LOCAL, un-networked state (D5), so this
 * drives the client death path directly via the DEV-only `__eqxKillLocalShip()`
 * hook (the same DEV-hook pattern as `__eqxTriggerRespawnCascade`). No hostile
 * fire / TTK wait needed — a 1-2 s spec.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

async function join(page: Page, opts: { worker0?: boolean } = {}): Promise<void> {
  const params = new URLSearchParams({
    room: 'test-sector-fast',
    shipKind: 'scout',
    spawnX: '0',
    spawnY: '0',
    testId: `spectator-${randomUUID()}`,
  });
  // `?worker=0` forces the MAIN-THREAD PixiRenderer so `__eqxCameraCenter` (which
  // reads the renderer's `Camera` synchronously) works — the worker camera lives
  // off-thread.
  if (opts.worker0) params.set('worker', '0');
  await page.goto(`${BASE_URL}?${params}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 15_000 },
  );
  await page.locator('[data-testid="speed-dial-fab"]').waitFor({ timeout: 10_000 });
}

function pilotMode(page: Page): Promise<string> {
  return page
    .locator('[data-testid="game-surface"]')
    .getAttribute('data-pilot-mode')
    .then((v) => v ?? '');
}

async function killLocalShip(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __eqxKillLocalShip?: () => void }).__eqxKillLocalShip?.();
  });
}

test('death → instant spectator, NO death modal', async ({ page }) => {
  test.setTimeout(45_000);
  await join(page);
  expect(await pilotMode(page)).toBe('pilot');

  await killLocalShip(page);

  // pilotMode flips to spectator immediately…
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator',
    { timeout: 5_000 },
  );
  // …and the blocking DeathOverlay never appears.
  await expect(page.locator('[data-testid="death-overlay"]')).toHaveCount(0);
});

test('spectator camera free-roams (drag pans, no follow snap-back)', async ({ page }) => {
  test.setTimeout(45_000);
  await join(page, { worker0: true });
  await killLocalShip(page);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator',
    { timeout: 5_000 },
  );

  const surface = page.locator('[data-testid="game-surface"]');
  const box = (await surface.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const readCenter = (): Promise<{ x: number; y: number }> =>
    page.evaluate(() => {
      const w = window as unknown as { __eqxCameraCenter?: () => { x: number; y: number } };
      return w.__eqxCameraCenter ? w.__eqxCameraCenter() : { x: NaN, y: NaN };
    });

  const before = await readCenter();

  // Drag the canvas — in spectator the camera pans and STAYS (no follow yanks
  // it back to a ship that no longer exists).
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 220, cy - 160, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400); // let momentum settle

  const after = await readCenter();
  // The world point at screen centre moved (the camera panned) and did not
  // snap back to a followed ship.
  const moved = Math.hypot(after.x - before.x, after.y - before.y);
  expect(moved, `camera centre should move on a spectator drag (before=${JSON.stringify(before)} after=${JSON.stringify(after)})`).toBeGreaterThan(20);
});

test('spectator input is pan, not thrust — the ship does NOT move on W', async ({ page }) => {
  test.setTimeout(45_000);
  await join(page);

  // Read the local ship's mirror position (game-space). Stable when input is
  // gated; advances when thrust reaches the ship.
  const localPos = (): Promise<{ x: number; y: number } | null> =>
    page.evaluate(() => {
      const el = document.querySelector('[data-testid="game-surface"]') as HTMLElement | null;
      const lid = el?.dataset['localPlayerId'] ?? '';
      const posns = JSON.parse(el?.dataset['shipPositions'] ?? '{}') as Record<string, { x: number; y: number }>;
      return lid && posns[lid] ? posns[lid] : null;
    });

  // Baseline: in PILOT mode, W thrusts the ship (sanity that input reaches it).
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      const lid = el?.getAttribute('data-local-player-id') ?? '';
      const posns = JSON.parse(el?.getAttribute('data-ship-positions') ?? '{}') as Record<string, unknown>;
      return lid !== '' && posns[lid] != null;
    },
    { timeout: 10_000 },
  );

  // Enter spectator via the always-visible toggle (Phase 5 — moved out of the
  // speed-dial). The ship persists server-side; input gates.
  await page.locator('[data-testid="spectator-toggle"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator',
    { timeout: 5_000 },
  );

  // Let the ship settle (any residual velocity decays), then sample.
  await page.waitForTimeout(600);
  const before = await localPos();
  expect(before, 'the ship should still exist server-side while spectating').not.toBeNull();

  // Press W: in spectator this is gated, so it must NOT thrust the ship.
  await page.keyboard.down('w');
  await page.waitForTimeout(700);
  await page.keyboard.up('w');
  await page.waitForTimeout(300);
  const after = await localPos();
  expect(after).not.toBeNull();
  const moved = Math.hypot(after!.x - before!.x, after!.y - before!.y);
  expect(moved, `W must NOT thrust the ship while spectating (moved ${moved.toFixed(1)}u)`).toBeLessThan(15);
});

test('construction works while spectating (place a structure with no ship)', async ({ page }) => {
  test.setTimeout(45_000);
  await join(page);

  const swarmCount = (): Promise<number> =>
    page
      .locator('[data-testid="swarm-count"]')
      .textContent()
      .then((t) => parseInt((t ?? '0').replace(/\D/g, '') || '0', 10));
  const before = await swarmCount();

  await killLocalShip(page);
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator',
    { timeout: 5_000 },
  );

  // Build → pick a Solar while in spectator (no active ship). On Desktop Chrome
  // (non-touch) the placement model is one-click-place; the ghost anchors to the
  // CAMERA CENTRE in spectator (no ship to anchor ahead of), so a click on the
  // canvas commits the placement there.
  await page.locator('[data-testid="speed-dial-fab"]').click();
  await page.locator('[data-testid="speed-dial-build"]').click();
  await page.locator('[data-testid="build-cat-economy"]').click();
  await expect(page.locator('[data-testid="build-solar"]')).toBeVisible({ timeout: 5_000 });
  await page.locator('[data-testid="build-solar"]').click();

  // The placement ghost is up (camera-anchored). Wait until the renderer reports
  // a chosen world point (`data-placement-screen-x`), then click to commit.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-placement-screen-x') != null,
    { timeout: 5_000 },
  );
  const surface = page.locator('[data-testid="game-surface"]');
  const box = (await surface.boundingBox())!;
  // Click off-centre so the structure isn't on top of any seed entity.
  await page.mouse.click(box.x + box.width / 2 + 80, box.y + box.height / 2 - 60);

  await page.waitForFunction(
    (b) => {
      const t = document.querySelector('[data-testid="swarm-count"]')?.textContent ?? '0';
      return parseInt(t.replace(/\D/g, '') || '0', 10) > b;
    },
    before,
    { timeout: 10_000 },
  );
  expect(await swarmCount()).toBeGreaterThan(before);
});

test('pilot/spectate toggle round-trips pilot↔spectator', async ({ page }) => {
  test.setTimeout(45_000);
  await join(page);
  expect(await pilotMode(page)).toBe('pilot');

  // Phase 5 — the always-visible two-button toggle (out of the speed-dial). Click
  // Spectate to detach, Pilot to return (re-clicking an active exclusive toggle
  // is a no-op, so the round-trip uses the OTHER button).
  await page.locator('[data-testid="spectator-toggle"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator',
    { timeout: 5_000 },
  );

  await page.locator('[data-testid="pilot-toggle"]').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'pilot',
    { timeout: 5_000 },
  );
});
