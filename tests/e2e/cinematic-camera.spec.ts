import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from '@playwright/test';

/**
 * Cinematic camera + clean-frame HUD (docs/architecture/cinematic-camera.md).
 *
 * Locks the end-to-end seam the showcase capture pipeline depends on:
 *   - `?cinematic=1` hides the DOM HUD (speed-dial) while the canvas keeps
 *     rendering; `__eqxCinema.setHud('full')` brings it back mid-session.
 *   - `__eqxCinema.play()` takes the camera away from the local-ship follow
 *     (a `hold` cut lands exactly on the requested GAME-space point — Y-up,
 *     so this also locks the pixi Y-flip at the IRenderer boundary).
 *   - A `track` shot converges on the RENDERED sprite pose (not raw mirror).
 *   - A `release` cue hands the camera back to gameplay follow.
 *
 * `?worker=0` so `__eqxCameraCenter` can read the main-thread camera.
 */

const BASE_URL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:5173';

type Cue = { atMs: number; shot: Record<string, unknown>; smoothMs?: number };

async function join(page: Page): Promise<void> {
  const params = new URLSearchParams({
    room: 'test-sector-fast',
    shipKind: 'scout',
    spawnX: '400',
    spawnY: '-300',
    worker: '0',
    cinematic: '1',
    testId: `cinematic-${randomUUID()}`,
  });
  await page.goto(`${BASE_URL}?${params}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="game-surface"]');
      return el !== null && el.getAttribute('data-local-player-id') !== '';
    },
    { timeout: 15_000 },
  );
}

function cameraCenter(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() =>
    (window as unknown as { __eqxCameraCenter: () => { x: number; y: number } }).__eqxCameraCenter(),
  );
}

function play(page: Page, cues: Cue[]): Promise<void> {
  return page.evaluate((c) => {
    (window as unknown as { __eqxCinema: { play: (c: unknown) => void } }).__eqxCinema.play(c);
  }, cues);
}

test('cinematic HUD + scripted camera take over and release cleanly', async ({ page }) => {
  test.setTimeout(45_000);
  await join(page);

  // Clean frame: the speed-dial exists but is hidden by the HUD-mode class.
  const fab = page.locator('[data-testid="speed-dial-fab"]');
  await expect(fab).toBeAttached({ timeout: 15_000 });
  await expect(fab).toBeHidden();
  await page.evaluate(() => (window as unknown as { __eqxCinema: { setHud: (m: string) => void } }).__eqxCinema.setHud('full'));
  await expect(fab).toBeVisible();

  // Hold cut → camera lands exactly on the GAME-space point, away from the ship.
  await play(page, [{ atMs: 0, shot: { kind: 'hold', x: 3000, y: 2000, zoom: 1 }, smoothMs: 0 }]);
  await expect
    .poll(async () => {
      const c = await cameraCenter(page);
      return Math.hypot(c.x - 3000, c.y - 2000);
    }, { timeout: 5_000 })
    .toBeLessThan(1);
  expect(await page.evaluate(() => (window as unknown as { __eqxCinema: { isScripted: () => boolean } }).__eqxCinema.isScripted())).toBe(true);

  // Track the local ship's RENDERED sprite with a game-space offset.
  await play(page, [{ atMs: 0, shot: { kind: 'track', target: 'local', zoom: 1, offsetX: 250, offsetY: 0 }, smoothMs: 0 }]);
  await expect
    .poll(async () => {
      const c = await cameraCenter(page);
      return Math.hypot(c.x - 650, c.y - -300);
    }, { timeout: 5_000 })
    .toBeLessThan(20);

  // Release → back on the local ship (follow resumes), director inactive.
  await play(page, [{ atMs: 0, shot: { kind: 'release' } }]);
  await expect
    .poll(async () => {
      const c = await cameraCenter(page);
      return Math.hypot(c.x - 400, c.y - -300);
    }, { timeout: 5_000 })
    .toBeLessThan(20);
  expect(await page.evaluate(() => (window as unknown as { __eqxCinema: { isScripted: () => boolean } }).__eqxCinema.isScripted())).toBe(false);
});
