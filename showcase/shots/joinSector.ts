import type { Shot } from '../types.js';

/** U2 + M39 arrival — pick a sector, read its drawer, pick a ship, warp in. */
export const joinSector: Shot = {
  id: 'join-sector',
  section: 'opener',
  title: 'Choose a sector',
  caption: 'Inspect any sector, pick a hull from your fleet and warp straight in.',
  features: ['U2', 'M39'],
  docs: ['warp-visual'],
  reel: true,
  server: 'living',
  target: { landing: true },
  hud: 'clean',
  durationMs: 17_000,
  async run(ctx) {
    const { page } = ctx;
    await ctx.sleep(800);
    await page.evaluate(() =>
      (window as unknown as { __eqxGalaxyPick?: (k: string) => void }).__eqxGalaxyPick?.('sol-prime'),
    );
    await ctx.sleep(2600);
    await page.getByTestId('sector-drawer-join').click({ timeout: 8000 });
    await ctx.sleep(2200);
    await page.getByTestId('ship-picker-spawn').first().click({ timeout: 8000 });
  },
};
