import type { Shot } from '../types.js';
import { AS_PILOT, toScreen } from './_helpers.js';

const CAM = { x: 200, y: 150, zoom: 0.85 };

/** M23, M24, M26 — the build menu, placement ghost, connection preview, build bar. */
export const buildBase: Shot = {
  id: 'build-base',
  section: 'mechanics',
  title: 'Build',
  caption: 'Pick a structure, see its reach and every connection it would make, then watch it build.',
  features: ['M23', 'M24', 'M26'],
  docs: ['building', 'structures-and-power-grid'],
  reel: true,
  server: 'lean',
  ...AS_PILOT,
  target: { room: 'showcase-base' },
  hud: 'clean',
  durationMs: 15_000,
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'hold', x: CAM.x, y: CAM.y, zoom: CAM.zoom } }],
  async run(ctx) {
    const { page } = ctx;
    await ctx.sleep(600);
    await page.getByTestId('speed-dial-fab').click();
    await ctx.sleep(700);
    await page.getByTestId('speed-dial-build').click();
    await ctx.sleep(700);
    await page.getByTestId('build-cat-economy').click();
    await ctx.sleep(700);
    await page.getByTestId('build-solar').click();
    await ctx.sleep(600);
    // Sweep the ghost across the base so the connection preview re-forms.
    const a = toScreen(520, 380, CAM.x, CAM.y, CAM.zoom, ctx.viewport);
    const b = toScreen(-260, 300, CAM.x, CAM.y, CAM.zoom, ctx.viewport);
    const c = toScreen(-80, 420, CAM.x, CAM.y, CAM.zoom, ctx.viewport);
    await page.mouse.move(a.x, a.y, { steps: 30 });
    await ctx.sleep(900);
    await page.mouse.move(b.x, b.y, { steps: 60 });
    await ctx.sleep(900);
    await page.mouse.move(c.x, c.y, { steps: 30 });
    await ctx.sleep(700);
    await page.mouse.click(c.x, c.y);
  },
};
