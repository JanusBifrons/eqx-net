/**
 * Command view camera: pan and zoom do not stutter.
 *
 * Reported (owner smoke test, RTS branch, 2026-11-14): "The commander view has
 * issues with zoom and pan, it weirdly stutters and stuff, like it thinks I've
 * still got a ship travelling fast or something."
 *
 * Cause: the speed effects (C3: speed zoom-out + streaking dust). They measure
 * the speed of whatever the camera follows; with nothing followed (command
 * view) they measured the camera centre itself, against the renderer clock.
 * So a WASD pan, a middle-drag or a wheel zoom around the cursor read as
 * "flying fast": the view zoomed out by up to 20 % while panning and eased
 * back when it stopped, and the raw centre-vs-clock speed swung frame to frame
 * (the same uneven-clock breathing fixed for the follow camera, see
 * `speedFxSample.ts`). Players have the Machined backdrop on by default;
 * automation has it off, which is why no spec saw it: this one turns it on.
 *
 * Steps (`?worker=0` for the camera probes; the renderer code is the same
 * class on the worker path): join galaxy-test in command view, send the own
 * hull a move order, then record the camera per frame while (1) nothing is
 * pressed, (2) WASD pans, (3) the wheel zooms in off-centre.
 */
import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { launchGalaxyTestClient } from './helpers/gameScenario';

const SURFACE = '[data-testid="game-surface"]';

interface Frame { cx: number; cy: number; scale: number; speedZoom: number }

/** Start (or restart) a per-frame camera recorder in the page. */
async function startRecording(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = globalThis as unknown as {
      __camRec?: Frame[]; __camRecOn?: boolean;
      __eqxCameraCenter?: () => { x: number; y: number };
      __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number };
      __eqxArtStats?: () => { backdrop?: { speedZoom: number } };
    };
    w.__camRec = [];
    if (w.__camRecOn) return;
    w.__camRecOn = true;
    const step = (): void => {
      const c = w.__eqxCameraCenter?.();
      const a = w.__eqxWorldToScreen?.(c?.x ?? 0, c?.y ?? 0);
      const b = w.__eqxWorldToScreen?.((c?.x ?? 0) + 1000, c?.y ?? 0);
      if (c && a && b) {
        w.__camRec!.push({ cx: c.x, cy: c.y, scale: (b.x - a.x) / 1000, speedZoom: w.__eqxArtStats?.().backdrop?.speedZoom ?? NaN });
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

const takeRecording = (page: Page): Promise<Frame[]> =>
  page.evaluate(() => (globalThis as unknown as { __camRec: Frame[] }).__camRec.slice());

test.describe('Command view camera @feature', () => {
  test('pan and zoom move only by the player: no follow, no speed zoom, no back-jumps', async ({ browser }) => {
    // Infrastructure: cold galaxy join + the first-visit backdrop bake.
    test.setTimeout(120_000);
    const { ctx, page } = await launchGalaxyTestClient(browser, {
      testId: randomUUID(), shipKind: 'fighter', spawnX: 0, spawnY: 0, startMode: 'command',
      extraParams: { art: 'machined', fx: 'new' },
    });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-pilot-mode') === 'spectator',
      undefined, { timeout: 15_000 },
    );
    await page.waitForFunction(
      () => (globalThis as { __eqxArtStats?: () => { backdrop?: { on: boolean } } }).__eqxArtStats?.().backdrop?.on === true,
      undefined, { timeout: 45_000 },
    );

    // ── Own hull under the AI pilot, flying a move order. ────────────────
    const hullAt = async (): Promise<{ x: number; y: number } | null> => {
      const p = await page.evaluate(() => {
        const m = (globalThis as { __eqxClient?: { mirror: { localPlayerId: string | null; ships: Map<string, { isActive?: boolean; ownerPlayerId?: string; x: number; y: number }> } } }).__eqxClient?.mirror;
        const toScreen = (globalThis as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } }).__eqxWorldToScreen;
        for (const e of [...(m?.ships?.values() ?? [])]) {
          if (e.isActive === false && e.ownerPlayerId === m?.localPlayerId && toScreen) return toScreen(e.x, e.y);
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
    const box = (await page.locator(SURFACE).boundingBox())!;
    const seq0 = Number(await page.locator(SURFACE).getAttribute('data-fleet-order-seq'));
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.2, { button: 'right' });
    await page.waitForFunction(
      (s) => Number(document.querySelector('[data-testid="game-surface"]')?.getAttribute('data-fleet-order-seq')) > s,
      seq0, { timeout: 3_000 },
    );
    // Park the pointer in a corner so nothing hovers the canvas centre.
    await page.mouse.move(box.x + 5, box.y + box.height - 5);
    await page.waitForTimeout(600); // the hull gets under way (not a game-time wait: we only need it moving)

    // ── 1. No input: the camera holds while the own hull flies. ─────────
    await startRecording(page);
    await page.waitForTimeout(1_200); // measurement window
    const idle = await takeRecording(page);
    expect(idle.length, 'idle frames recorded').toBeGreaterThan(5);
    const idleDrift = Math.max(...idle.map((f) => Math.hypot(f.cx - idle[0]!.cx, f.cy - idle[0]!.cy)));
    expect(idleDrift, 'camera centre moved with no input (following a ship?)').toBeLessThan(0.5);
    expect(Math.max(...idle.map((f) => Math.abs(f.scale / idle[0]!.scale - 1))), 'zoom moved with no input').toBeLessThan(0.001);

    // ── 2. WASD pan: centre moves one way, the zoom stays put. ──────────
    await startRecording(page);
    await page.keyboard.down('d');
    try {
      await page.waitForTimeout(1_500); // measurement window
    } finally {
      await page.keyboard.up('d');
    }
    await page.waitForTimeout(300);
    const pan = await takeRecording(page);
    expect(pan.length, 'pan frames recorded').toBeGreaterThan(5);
    expect(pan[pan.length - 1]!.cx - pan[0]!.cx, 'D pans the view right').toBeGreaterThan(50);
    let backJumps = 0;
    for (let i = 1; i < pan.length; i++) if (pan[i]!.cx < pan[i - 1]!.cx - 1e-6) backJumps++;
    expect(backJumps, 'pan centre went backwards').toBe(0);
    const panSpeedZoom = Math.min(...pan.map((f) => f.speedZoom));
    const panScaleSwing = Math.max(...pan.map((f) => Math.abs(f.scale / pan[0]!.scale - 1)));
    expect(panSpeedZoom, `speed zoom engaged while panning (scale swing ${panScaleSwing.toFixed(4)})`).toBe(1);
    expect(panScaleSwing, 'zoom changed while only panning').toBeLessThan(0.001);

    // ── 3. Wheel zoom in off-centre: scale eases one way, no speed zoom. ─
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.3);
    await startRecording(page);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(900); // measurement window (the zoom ease)
    const zoom = await takeRecording(page);
    expect(zoom[zoom.length - 1]!.scale / zoom[0]!.scale, 'wheel zoomed in').toBeGreaterThan(1.05);
    let zoomBack = 0;
    for (let i = 1; i < zoom.length; i++) if (zoom[i]!.scale < zoom[i - 1]!.scale * (1 - 1e-6)) zoomBack++;
    expect(zoomBack, 'zoom-in eased backwards on some frame').toBe(0);
    expect(Math.min(...zoom.map((f) => f.speedZoom)), 'speed zoom engaged while wheel-zooming').toBe(1);

    await ctx.close();
  });
});
