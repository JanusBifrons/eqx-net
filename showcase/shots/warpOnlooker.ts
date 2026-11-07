import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { Shot } from '../types.js';
import { targetUrl } from '../recorder.js';
import { sectorSites, warpDropPoint } from '../../src/core/galaxy/sectorSites.js';

/**
 * Phase 4 step 4c — warp seen from outside. A second pilot (its own browser
 * context, so its own player) spools beside the filmed ship and warps to a
 * gate pocket 170 km out: the engine glow builds, the hull streaks away and
 * two burning engine trails are left on its path, then burn out.
 */
const PILOT_X = 600;
const PILOT_Y = 250;

export const warpOnlooker: Shot = {
  id: 'warp-onlooker',
  section: 'mechanics',
  title: 'Someone warps out',
  caption: 'Seen from outside: the engines build, the ship streaks away and leaves two burning trails behind it.',
  features: ['P4'],
  docs: [],
  reel: false,
  server: 'solar',
  target: { galaxy: 'sol-prime', params: { solar: '1', spawnX: 0, spawnY: 0, art: 'machined', fx: 'new' } },
  hud: 'clean',
  durationMs: 15_000,
  async run(ctx) {
    const gate = sectorSites('sol-prime').find((s) => s.kind === 'gate')!;
    const drop = warpDropPoint(gate, PILOT_X, PILOT_Y);
    const len = Math.hypot(drop.x - PILOT_X, drop.y - PILOT_Y);
    const dx = (drop.x - PILOT_X) / len, dy = (drop.y - PILOT_Y) / len;

    const browser = ctx.page.context().browser() as Browser;
    const other: BrowserContext = await browser.newContext({ viewport: { width: 480, height: 270 } });
    try {
      const pilot: Page = await other.newPage();
      // Its own renderer runs in a worker: two main-thread renderers starve each other.
      const url = targetUrl(ctx.baseUrl, { galaxy: 'sol-prime', params: { solar: '1', spawnX: PILOT_X, spawnY: PILOT_Y } }, ctx.testId, 'none').replace('worker=0', 'worker=1');
      await pilot.goto(url);
      await pilot.waitForFunction(() => {
        const c = (globalThis as unknown as { __eqxClient?: { mirror?: { localPlayerId?: string | null; ships?: Map<string, unknown> } } }).__eqxClient;
        const id = c?.mirror?.localPlayerId;
        return !!id && !!c?.mirror?.ships?.get(id);
      }, undefined, { timeout: 30_000 });
      // The filmed page sees the second ship before we roll the warp.
      await ctx.page.waitForFunction(() => {
        const c = (globalThis as unknown as { __eqxClient?: { mirror?: { ships?: Map<string, unknown> } } }).__eqxClient;
        return (c?.mirror?.ships?.size ?? 0) >= 2;
      }, undefined, { timeout: 30_000 });
      // Frame the pilot with room ahead for the trails.
      await ctx.cinema.play([{ atMs: 0, smoothMs: 800, shot: { kind: 'hold', x: PILOT_X + dx * 900, y: PILOT_Y + dy * 900, zoom: 0.32 } }]);
      await ctx.sleep(1500);
      ctx.log(`pilot warps to (${Math.round(drop.x)}, ${Math.round(drop.y)})`);
      await pilot.evaluate(`globalThis.__eqxClient && globalThis.__eqxClient.requestWarp(${drop.x}, ${drop.y})`);
      await ctx.sleep(11_000);
    } finally {
      await other.close().catch(() => undefined);
    }
  },
};
