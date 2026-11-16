/**
 * Machined art in the real game (plan iridescent-seeking-rainbow, A3).
 *
 * With `?art=machined` the renderer bakes ship art on workers. Until a ship's
 * art is ready it draws today's vector look, then swaps to the Machined
 * sprite. `?artDelayMs=` holds every bake back so the fallback is observable;
 * `__eqxArtStats` (main-thread renderer, hence `?worker=0`) reports what is
 * drawn. With no flag the look is unchanged from today.
 */
import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { launchTestClient } from './helpers/gameScenario';
import { DEFAULT_BASE_URL } from './helpers/ports';

interface ArtStats { mode: string; machinedSprites: number; classicShipSprites: number; ready?: number; pending?: number; failed?: number; pages?: number; workers?: number }
const stats = (page: Page): Promise<ArtStats> =>
  page.evaluate(() => (window as unknown as { __eqxArtStats: () => ArtStats }).__eqxArtStats());

test.describe('Machined art', () => {
  test('a ship draws today\'s look while its art bakes, then swaps to Machined', async ({ browser }) => {
    const { ctx, page } = await launchTestClient(browser, {
      spawnX: 0, spawnY: 0, room: 'test-sector-fast', shipKind: 'heavy',
      extraParams: { worker: '0', art: 'machined', artDelayMs: '9000', zoom: '3' },
      // Reads the fallback look while bakes are held back, i.e. behind the
      // curtain (which now waits for the Machined art), so don't wait for play.
      waitForInPlay: false,
    });
    await page.waitForFunction(() => {
      const s = (window as unknown as { __eqxArtStats?: () => { classicShipSprites: number; machinedSprites: number } }).__eqxArtStats?.();
      return !!s && s.classicShipSprites + s.machinedSprites > 0;
    }, undefined, { timeout: 10_000 });
    const before = await stats(page);
    expect(before.mode).toBe('machined');
    expect(before.machinedSprites, 'nothing is Machined while bakes are held back').toBe(0);
    expect(before.classicShipSprites, 'the ship falls back to today\'s look').toBeGreaterThan(0);
    expect(before.pending ?? 0).toBeGreaterThan(0);

    await page.waitForFunction(
      () => (window as unknown as { __eqxArtStats: () => { machinedSprites: number } }).__eqxArtStats().machinedSprites > 0,
      undefined, { timeout: 20_000 },
    );
    const after = await stats(page);
    expect(after.failed ?? 0).toBe(0);
    expect(after.ready ?? 0).toBeGreaterThan(0);
    expect(after.pages ?? 0).toBeGreaterThan(0);

    mkdirSync('diag/e2e-screenshots/machined-art', { recursive: true });
    await page.screenshot({ path: 'diag/e2e-screenshots/machined-art/heavy-machined.png' });
    await ctx.close();
  });

  test('without the flag nothing changes: no art service, today\'s look', async ({ browser }) => {
    const { ctx, page } = await launchTestClient(browser, {
      spawnX: 0, spawnY: 0, room: 'test-sector-fast', extraParams: { worker: '0' },
    });
    await page.waitForFunction(() => {
      const s = (window as unknown as { __eqxArtStats?: () => { classicShipSprites: number } }).__eqxArtStats?.();
      return !!s && s.classicShipSprites > 0;
    }, undefined, { timeout: 10_000 });
    const s = await stats(page);
    expect(s.mode).toBe('classic');
    expect(s.machinedSprites).toBe(0);
    expect(s.workers).toBeUndefined();
    await ctx.close();
  });
});

test.describe('Machined art — structures and asteroids', () => {
  test('a prebuilt base draws structures and its asteroid in Machined once baked', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const base = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
    await page.goto(`${base}?room=structure-scenario-test&worker=0&art=machined&zoom=0.4&spawnX=0&spawnY=520&testId=${crypto.randomUUID()}`);
    // Capital + 2 solar + miner + turret (+ the asteroid) all become Machined.
    await page.waitForFunction(
      () => ((window as unknown as { __eqxArtStats?: () => { machinedSprites: number } }).__eqxArtStats?.().machinedSprites ?? 0) >= 6,
      undefined, { timeout: 30_000 },
    );
    const s = await stats(page);
    expect(s.failed ?? 0).toBe(0);
    mkdirSync('diag/e2e-screenshots/machined-art', { recursive: true });
    await page.screenshot({ path: 'diag/e2e-screenshots/machined-art/base-machined.png' });
    await ctx.close();
  });
});

test.describe('Machined art — warm-up', () => {
  test('the landing galaxy map bakes the common art before any sector is joined', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const base = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
    await page.goto(`${base}?worker=0&art=machined`);
    // No room joined: only the warm-up is asking for art. Ships (~15) and the
    // common structures (~18) all become ready while the map is up.
    await page.waitForFunction(
      () => ((window as unknown as { __eqxArtStats?: () => { ready?: number } }).__eqxArtStats?.().ready ?? 0) >= 25,
      undefined, { timeout: 30_000 },
    );
    const s = await stats(page);
    expect(s.machinedSprites, 'no game sprites yet: this is all warm-up').toBe(0);
    expect(s.failed ?? 0).toBe(0);
    await ctx.close();
  });

  test('with ?fx=new the effect textures bake too, through the worker pool (plan iridescent-seeking-rainbow v3, B1)', async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    const base = process.env['PLAYWRIGHT_BASE_URL'] ?? DEFAULT_BASE_URL;
    await page.goto(`${base}?worker=0&art=machined&fx=new`);
    type FxStats = { fxReady?: number; fxPending?: number; failed?: number; lastFailure?: string };
    await page.waitForFunction(
      () => { const st = (window as unknown as { __eqxArtStats?: () => FxStats }).__eqxArtStats?.(); return (st?.fxReady ?? 0) >= 19 && st?.fxPending === 0; },
      undefined, { timeout: 30_000 },
    );
    const s = await page.evaluate(() => (window as unknown as { __eqxArtStats: () => FxStats }).__eqxArtStats());
    expect(s.fxPending).toBe(0);
    expect(s.failed ?? 0, s.lastFailure).toBe(0);
    // Without the flag no effect textures are asked for.
    await page.goto(`${base}?worker=0&art=machined`);
    await page.waitForFunction(() => !!(window as unknown as { __eqxArtStats?: () => unknown }).__eqxArtStats, undefined, { timeout: 30_000 });
    const off = await page.evaluate(() => (window as unknown as { __eqxArtStats: () => FxStats }).__eqxArtStats());
    expect((off.fxReady ?? 0) + (off.fxPending ?? 0)).toBe(0);
    await ctx.close();
  });
});

test.describe('New backdrop (plan iridescent-seeking-rainbow v3, B2)', () => {
  type BdStats = { backdrop?: { on: boolean; nebula: string | null } };
  // Infrastructure cost only: a cold room join plus the first-visit bake of
  // the backdrop textures on the worker pool (no game-time wait).
  test.describe.configure({ timeout: 90_000 });
  test('in a sector with ?fx=new the baked backdrop replaces today\'s starfield', async ({ browser }) => {
    const { ctx, page } = await launchTestClient(browser, {
      spawnX: 0, spawnY: 0, room: 'test-sector-fast', shipKind: 'fighter',
      extraParams: { worker: '0', art: 'machined', fx: 'new' },
    });
    await page.waitForFunction(
      () => (window as unknown as { __eqxArtStats?: () => BdStats }).__eqxArtStats?.().backdrop?.on === true,
      undefined, { timeout: 30_000 },
    );
    const s = await page.evaluate(() => (window as unknown as { __eqxArtStats: () => BdStats & { failed?: number } }).__eqxArtStats());
    expect(s.backdrop!.nebula, 'a nebula was chosen for the sector').toMatch(/^(emission|reflection|dark):\d+$/);
    // C1: the sector's own sky (landmarks placed from its key).
    expect((s.backdrop as { sky?: string }).sky ?? '', 'the sector laid out its landmarks').toMatch(/(planet|gasGiant|moon|nebulaPatch|galaxy)@/);
    expect(s.failed ?? 0).toBe(0);
    mkdirSync('diag/e2e-screenshots/machined-art', { recursive: true });
    await page.screenshot({ path: 'diag/e2e-screenshots/machined-art/backdrop.png' });
    await ctx.close();
  });

  test('without ?fx=new there is no new backdrop', async ({ browser }) => {
    const { ctx, page } = await launchTestClient(browser, {
      spawnX: 0, spawnY: 0, room: 'test-sector-fast', shipKind: 'fighter',
      extraParams: { worker: '0', art: 'machined' },
    });
    await page.waitForFunction(() => !!(window as unknown as { __eqxArtStats?: () => BdStats }).__eqxArtStats?.().backdrop, undefined, { timeout: 20_000 });
    const s = await page.evaluate(() => (window as unknown as { __eqxArtStats: () => BdStats }).__eqxArtStats());
    expect(s.backdrop).toMatchObject({ on: false, nebula: null });
    await ctx.close();
  });
});

test.describe('Nebulae (plan nebulae-galaxy-regions): only in nebula sectors', () => {
  // Infrastructure cost only: cold room join + first-visit backdrop bake.
  test.describe.configure({ timeout: 90_000 });
  type Bd = { backdrop?: { on: boolean; density: number } };
  // Which galaxy sectors hold a nebula, and how thick, is unit-locked
  // (nebulaField.test.ts, Backdrop.sky.test.ts): E2E never joins a live
  // galaxy room. Here the real client path: a room off the galaxy map is
  // clear, and the look R&D override (?neblook=) draws at full depth.
  for (const arm of [{ name: 'a sector with no nebula is clear', params: {}, inside: false },
    { name: 'the ?neblook= override puts you deep in a nebula', params: { neblook: 'blend', nebseed: '8' }, inside: true }]) {
    test(arm.name, async ({ browser }) => {
      const { ctx, page } = await launchTestClient(browser, {
        spawnX: 0, spawnY: 0, room: 'test-sector-fast', shipKind: 'fighter',
        extraParams: { worker: '0', art: 'machined', fx: 'new', ...arm.params },
      });
      await page.waitForFunction(
        () => (window as unknown as { __eqxArtStats?: () => Bd }).__eqxArtStats?.().backdrop?.on === true,
        undefined, { timeout: 45_000 },
      );
      const s = await page.evaluate(() => (window as unknown as { __eqxArtStats: () => Bd }).__eqxArtStats());
      expect(s.backdrop!.density).toBe(arm.inside ? 1 : 0);
      if (arm.inside) {
        mkdirSync('diag/e2e-screenshots/machined-art', { recursive: true });
        await page.screenshot({ path: 'diag/e2e-screenshots/machined-art/inside-nebula.png' });
      }
      await ctx.close();
    });
  }
});

test.describe('Speed effects (plan iridescent-seeking-rainbow v5, C3)', () => {
  // Infrastructure cost only: cold room join + first-visit backdrop bake.
  test.describe.configure({ timeout: 90_000 });
  type Bd = { backdrop?: { on: boolean; speed: number; speedZoom: number; speedLevel: string } };
  const bd = (page: Page): Promise<Bd['backdrop']> =>
    page.evaluate(() => (window as unknown as { __eqxArtStats: () => Bd }).__eqxArtStats().backdrop);

  for (const arm of [{ speedfx: '1', zooms: true }, { speedfx: '0', zooms: false }]) {
    test(`flying fast ${arm.zooms ? 'zooms the view out a little' : 'with speed effects off keeps the zoom'} (?speedfx=${arm.speedfx})`, async ({ browser }) => {
      const { ctx, page } = await launchTestClient(browser, {
        spawnX: 0, spawnY: 0, room: 'test-sector-fast', shipKind: 'fighter',
        extraParams: { worker: '0', art: 'machined', fx: 'new', speedfx: arm.speedfx },
      });
      await page.waitForFunction(
        () => (window as unknown as { __eqxArtStats?: () => Bd }).__eqxArtStats?.().backdrop?.on === true,
        undefined, { timeout: 45_000 },
      );
      expect((await bd(page))!.speedLevel).toBe(arm.zooms ? 'large' : 'off');
      expect((await bd(page))!.speedZoom).toBe(1);
      // Controls unlock when the loading screen lifts, which now waits for the
      // Machined art (`RendererFeedback.artReady`): fly only after the reveal.
      await page.waitForSelector('[data-loading-active="0"]', { state: 'attached', timeout: 45_000 });
      await page.keyboard.down('KeyW');
      await page.keyboard.down('Shift');
      try {
        // The state under test: eased speed well up (and, with the effects on,
        // the camera zoomed out). The timeout is a deadline, not a pace.
        await page.waitForFunction(
          (zooms) => {
            const b = (window as unknown as { __eqxArtStats: () => Bd }).__eqxArtStats().backdrop!;
            return zooms ? b.speedZoom < 0.95 : b.speed > 0.5;
          },
          arm.zooms, { timeout: 15_000 },
        );
        const b = (await bd(page))!;
        if (arm.zooms) expect(b.speedZoom).toBeGreaterThanOrEqual(0.8);
        else expect(b.speedZoom).toBe(1);
        if (arm.zooms) {
          mkdirSync('diag/e2e-screenshots/machined-art', { recursive: true });
          await page.screenshot({ path: 'diag/e2e-screenshots/machined-art/speed-large.png' });
        }
      } finally {
        await page.keyboard.up('Shift').catch(() => undefined);
        await page.keyboard.up('KeyW').catch(() => undefined);
      }
      await ctx.close();
    });
  }
});
