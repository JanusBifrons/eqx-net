import type { Shot } from '../types.js';

/** U1 — the living galaxy map: territories, outlines, live badges, LOD starfield. */
export const galaxyLanding: Shot = {
  id: 'galaxy-landing',
  section: 'opener',
  title: 'A living galaxy',
  caption: '21 sectors across four regions — live counts of drones, players and bases on every hex.',
  features: ['U1', 'M41'],
  docs: ['living-galaxy', 'galaxy-graph', 'single-canvas-galaxy'],
  reel: true,
  server: 'living',
  target: { landing: true },
  hud: 'clean',
  durationMs: 12_000,
  async run(ctx) {
    const { page } = ctx;
    await page.mouse.move(960, 540);
    // Slow push-in toward the core, then drift across the map, hovering hexes.
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, -120);
      await ctx.sleep(260);
    }
    await ctx.sleep(800);
    await page.mouse.down();
    await page.mouse.move(860, 560, { steps: 60 });
    await page.mouse.up();
    await ctx.sleep(600);
    const hovers: Array<[number, number]> = [
      [860, 520],
      [1000, 480],
      [1120, 600],
      [940, 640],
    ];
    for (const [x, y] of hovers) {
      await page.mouse.move(x, y, { steps: 25 });
      await ctx.sleep(700);
    }
  },
};
