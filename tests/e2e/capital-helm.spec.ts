/**
 * Capital-ship R&D round 3 D â€” helm orders, end to end.
 *
 * A pilot joins the showcase fleet room flying a battleship (the room's
 * `pilotCapitals` test switch), taps empty space on the canvas, and the helm
 * takes over: the panel reads "course set" and the ship moves under its own
 * inputs (server-authoritative pose via `data-ship-x/y`), with the green
 * move marker drawn at the course point. Pressing W cancels
 * the course (WASD overrides the helm). A fighter in the same room gets no
 * helm panel.
 */
import { test, expect } from '@playwright/test';
import { launchTestClient } from './helpers/gameScenario';

const ROOM = 'showcase-capitals' as unknown as 'test-sector';
const SPAWN = { spawnX: 0, spawnY: -12000 }; // open space south of the fleet

async function shipPos(page: import('@playwright/test').Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-ship-x]') as HTMLElement | null;
    return { x: Number(el?.dataset['shipX'] ?? NaN), y: Number(el?.dataset['shipY'] ?? NaN) };
  });
}

/** The helm move marker as the renderer drew it (`__eqxArtStats`, `?worker=0`). */
async function helmMarkerShown(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => (globalThis as { __eqxArtStats?: () => { helmMarker?: boolean } }).__eqxArtStats?.().helmMarker === true);
}

test('a battleship pilot taps a course, the helm flies it, W cancels', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await launchTestClient(browser, {
    room: ROOM, ...SPAWN, shipKind: 'battleship', extraParams: { worker: '0' }, joinTimeoutMs: 60_000,
  });
  try {
    const panel = page.getByTestId('helm-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await expect(panel).toHaveAttribute('data-helm-active', '0');

    // Tap empty space up-right of the ship (the camera centres on it).
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.waitForFunction(() => !Number.isNaN(Number((document.querySelector('[data-ship-x]') as HTMLElement | null)?.dataset['shipX'])));
    const start = await shipPos(page);
    // Re-tap until it takes: on a cold page a busy frame between mouse-down and
    // mouse-up stretches the press past the 250 ms tap window (a drag).
    await expect.poll(async () => {
      await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.2);
      return panel.getAttribute('data-helm-active');
    }, { timeout: 10_000, intervals: [300] }).toBe('1');

    // Owner 2026-11-12: "no visible indicator of where and what was tapped".
    // The green move marker is drawn at the course point while it's active.
    await expect.poll(() => helmMarkerShown(page), { timeout: 5_000 }).toBe(true);

    // The ship gets under way by itself (a 5.8 km hull is slow: allow a few s).
    await expect.poll(async () => {
      const p = await shipPos(page);
      return Math.hypot(p.x - start.x, p.y - start.y);
    }, { timeout: 20_000 }).toBeGreaterThan(30);

    // WASD overrides and cancels the course.
    await page.keyboard.down('w');
    await expect(panel).toHaveAttribute('data-helm-active', '0', { timeout: 5_000 });
    await page.keyboard.up('w');
    // ...and the move marker goes with the cancelled course.
    await expect.poll(() => helmMarkerShown(page), { timeout: 5_000 }).toBe(false);

    // Speed buttons set the speed setting.
    await page.getByTestId('helm-speed-1').click();
    await expect(panel).toHaveAttribute('data-helm-speed', '1');
  } finally {
    await ctx.close();
  }
});

test('a fighter gets no helm panel', async ({ browser }) => {
  const { ctx, page } = await launchTestClient(browser, {
    room: ROOM, ...SPAWN, shipKind: 'fighter', extraParams: { worker: '0' },
  });
  try {
    // Once the local ship is in the mirror, helm availability has been decided.
    await page.waitForFunction(() => !Number.isNaN(Number((document.querySelector('[data-ship-x]') as HTMLElement | null)?.dataset['shipX'])));
    await expect(page.getByTestId('helm-panel')).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});

/** A battleship pilot zooms right out and the fleet's fighter drone gets its
 *  far-zoom icon (FarZoomIcons; counted by `__eqxArtStats().lodDots`). */
test('zoomed out from a battleship, fighters draw as icons', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await launchTestClient(browser, {
    room: ROOM, spawnX: 0, spawnY: -6000, shipKind: 'battleship', extraParams: { worker: '0' },
  });
  try {
    await expect(page.getByTestId('helm-panel')).toBeVisible({ timeout: 15_000 });
    const box = (await page.locator('canvas').first().boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(async () => {
      await page.mouse.wheel(0, 600);
      return page.evaluate(() => (globalThis as { __eqxArtStats?: () => { lodDots?: number } }).__eqxArtStats?.().lodDots ?? 0);
    }, { timeout: 20_000, intervals: [150] }).toBeGreaterThan(0);
  } finally {
    await ctx.close();
  }
});
