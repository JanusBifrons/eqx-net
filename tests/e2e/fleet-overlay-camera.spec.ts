/**
 * Command view: selection markers stay on their ships while the camera moves
 * (since RTS Part A the marker is the one SelectionBracket, drawn in the
 * ticker; the probe reads its first bracket).
 *
 * Reported (hostile review of the filmed rts-command take, 2026-11-14,
 * 17.25–17.4 s and ~20.5 s): during a camera pan every selection ring sat
 * ~20 px ahead of its ship, then the ships "snapped into" the rings in one
 * jump when the camera stopped.
 *
 * Cause: the overlay (one screen-space Graphics) was redrawn inside
 * `PixiRenderer.update()`, projecting through the camera as it stood BEFORE
 * the frame's `camera.tick` (in the Pixi ticker), while the world rendered
 * with the camera AFTER it. So each ring lagged one frame of camera motion.
 *
 * The probe (`__eqxFleetRingProbe`, `?worker=0`) records, at the point the
 * frame renders (after the camera tick), the first ring's drawn centre and its
 * ship sprite's screen point. Pan with WASD (Command view) and compare.
 */
import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchGalaxyTestClient } from './helpers/gameScenario';

const SURFACE = '[data-testid="game-surface"]';

interface Probe { id: string; ringX: number; ringY: number; shipX: number; shipY: number; frames: number }

test.describe('Fleet overlay vs camera @feature', () => {
  test('selection markers stay on their ships during a camera pan', async ({ browser }) => {
    test.setTimeout(90_000);
    const a = await launchGalaxyTestClient(browser, {
      testId: randomUUID(), shipKind: 'fighter', spawnX: 0, spawnY: 0, startMode: 'command',
    });
    const { page } = a;
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator', undefined,
      { timeout: 15_000 },
    );
    const hullAt = async (): Promise<{ x: number; y: number } | null> => {
      const p = await page.evaluate(() => {
        const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { isActive?: boolean; ownerPlayerId?: string; x: number; y: number }> } } }).__eqxClient?.mirror;
        const toScreen = (globalThis as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } }).__eqxWorldToScreen;
        for (const e of [...(m?.ships?.values() ?? [])].filter((e) => e.isActive === false)) {
          if (e.ownerPlayerId === m?.localPlayerId && toScreen) return toScreen(e.x, e.y);
        }
        return null;
      });
      if (p === null) return null;
      const box = (await page.locator(SURFACE).boundingBox())!;
      return { x: p.x + box.x, y: p.y + box.y };
    };
    await expect.poll(hullAt, { timeout: 15_000, message: 'own parked hull drawn' }).not.toBeNull();
    await expect.poll(async () => {
      const sel = await page.locator(SURFACE).getAttribute('data-fleet-sel-count');
      if (sel === '1') return sel;
      const h = await hullAt();
      if (h) await page.mouse.click(h.x, h.y);
      return sel;
    }, { timeout: 6_000, intervals: [500], message: 'click selects the hull' }).toBe('1');

    const probe = (): Promise<Probe | null> =>
      page.evaluate(() => (globalThis as { __eqxFleetRingProbe?: () => Probe | null }).__eqxFleetRingProbe?.() ?? null);
    await probe(); // switch the capture on
    await expect.poll(async () => (await probe())?.frames ?? 0, { timeout: 3_000, message: 'ring probe captures' }).toBeGreaterThan(2);

    // Still camera: ring on ship (sanity).
    const still = (await probe())!;
    expect(Math.hypot(still.ringX - still.shipX, still.ringY - still.shipY), `still: ${JSON.stringify(still)}`).toBeLessThan(1.5);

    // Pan (WASD in Command view) and sample frames while the camera moves.
    await page.keyboard.down('d');
    await page.keyboard.down('w');
    let worst = 0;
    let worstAt: Probe | null = null;
    let moved = 0;
    let lastShipX = NaN;
    const startFrames = (await probe())!.frames;
    for (let i = 0; i < 25; i++) {
      const p = (await probe())!;
      const d = Math.hypot(p.ringX - p.shipX, p.ringY - p.shipY);
      if (d > worst) { worst = d; worstAt = p; }
      if (Number.isFinite(lastShipX) && Math.abs(p.shipX - lastShipX) > 0.5) moved++;
      lastShipX = p.shipX;
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    }
    await page.keyboard.up('w');
    await page.keyboard.up('d');
    expect((await probe())!.frames - startFrames, 'frames rendered while panning').toBeGreaterThan(5);
    expect(moved, 'the camera actually panned (the ship moved on screen)').toBeGreaterThan(3);
    expect(worst, `ring off its ship during the pan by ${worst.toFixed(1)} px: ${JSON.stringify(worstAt)}`).toBeLessThan(1.5);
    await a.ctx.close();
  });
});
