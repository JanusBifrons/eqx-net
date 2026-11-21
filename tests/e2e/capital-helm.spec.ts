/**
 * Helm modes, end to end (owner, 2026-11-21): Fly is manual piloting only.
 *
 * A pilot joins the showcase fleet room flying a battleship (a playable
 * capital). In Fly there is no ship-speed telegraph (the helm panel) and a
 * tap on empty space sets no course (no helm order, no move marker); W flies
 * the capital by hand (server-authoritative pose via `data-ship-x/y`). A
 * fighter shows no helm panel in Fly either. Tap-to-move and ship speed are
 * Command controls; the helm's own steering is still exercised through the
 * programmatic course hook in `autopilot-round-rock.spec.ts`.
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

async function localShipReady(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => !Number.isNaN(Number((document.querySelector('[data-ship-x]') as HTMLElement | null)?.dataset['shipX'])),
    undefined,
    { timeout: 15_000 },
  );
}

/** The helm move marker as the renderer drew it (`__eqxArtStats`, `?worker=0`). */
async function helmMarkerShown(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => (globalThis as { __eqxArtStats?: () => { helmMarker?: boolean } }).__eqxArtStats?.().helmMarker === true);
}

type EqxHelmWindow = { __eqxClient?: { getHelmOrder(): { active: boolean } } };

test('Fly is manual: a battleship pilot gets no speed telegraph, a tap sets no course, W flies it', async ({ browser }) => {
  test.setTimeout(120_000);
  const { ctx, page } = await launchTestClient(browser, {
    room: ROOM, ...SPAWN, shipKind: 'battleship', extraParams: { worker: '0' }, joinTimeoutMs: 60_000,
  });
  try {
    await localShipReady(page);
    await expect(page.getByTestId('helm-panel')).toHaveCount(0);

    // Tap empty space up-right of the ship (the camera centres on it): no course.
    const box = (await page.locator('canvas').first().boundingBox())!;
    const start = await shipPos(page);
    for (let i = 0; i < 3; i++) await page.mouse.click(box.x + box.width * 0.8, box.y + box.height * 0.2);
    await page.waitForTimeout(1_000);
    const active = await page.evaluate(() => (window as unknown as EqxHelmWindow).__eqxClient?.getHelmOrder().active ?? false);
    expect(active, 'a Fly tap sets no helm course').toBe(false);
    expect(await helmMarkerShown(page), 'no move marker in Fly').toBe(false);

    // WASD / the thumbstick fly the capital directly (a 5.8 km hull is slow: allow a few s).
    await page.keyboard.down('w');
    try {
      await expect.poll(async () => {
        const p = await shipPos(page);
        return Math.hypot(p.x - start.x, p.y - start.y);
      }, { timeout: 20_000 }).toBeGreaterThan(30);
    } finally {
      await page.keyboard.up('w');
    }
  } finally {
    await ctx.close();
  }
});

test('a fighter shows no helm panel in Fly either', async ({ browser }) => {
  const { ctx, page } = await launchTestClient(browser, {
    room: ROOM, ...SPAWN, shipKind: 'fighter', extraParams: { worker: '0' },
  });
  try {
    // Once the local ship is in the mirror, helm availability has been decided.
    await localShipReady(page);
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
    await localShipReady(page);
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
