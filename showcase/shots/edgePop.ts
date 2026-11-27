import type { Shot, ShotContext } from '../types.js';
import { touch, type Finger } from '../touch.js';

/**
 * Edge feel P4 (.resume/edge-feel-plan.md): placing a shield fence run on the
 * `deck` test room's base, by touch. The ghost's deck-slot outline pops as it
 * snaps to a new corner, and each post pops (flash + ring of sparks) as it
 * lands. Review take, not in the reel.
 */
/** Deck corners in the middle of the phone's build view: a first post, then two runs. */
const RUN: ReadonlyArray<[number, number]> = [[-1950, -375.28], [-650, -375.28], [-650, 375.28]];

async function tapId(ctx: ShotContext, id: string): Promise<void> {
  const el = ctx.page.getByTestId(id).first();
  ctx.log(id + ' ' + JSON.stringify(await el.evaluate((e) => ({ dis: (e as HTMLButtonElement).disabled, txt: document.body.innerText.match(/Can.t build[^\n]*/)?.[0] ?? '' })).catch(() => 'missing')));
  await el.click({ timeout: 5000 });
}

async function tapRead(ctx: ShotContext, f: Finger, x: number, y: number): Promise<{ wx: number; wy: number; px: number; py: number }> {
  await f.tap(x, y);
  await ctx.sleep(500);
  return ctx.page.evaluate(() => {
    const d = (document.querySelector('[data-testid="game-surface"]') as HTMLElement | null)?.dataset ?? {};
    return { wx: Number(d.placementWorldX), wy: Number(d.placementWorldY), px: Number(d.placementScreenX), py: Number(d.placementScreenY) };
  });
}

export const edgePopPhone: Shot = {
  id: 'edge-pop-phone',
  section: 'mechanics',
  title: 'Placing a shield fence',
  caption: 'Placing a shield fence: each fence post pops as it lands, and a building’s slot outline pops as it snaps (review take).',
  features: ['ART'],
  docs: ['structures-and-power-grid'],
  reel: false,
  server: 'lean',
  viewport: 'phone-landscape',
  target: { room: 'deck', params: { shipKind: 'fighter', initialHull: 1_000_000, zoom: 0.4 } },
  hud: 'full',
  durationMs: 26_000,
  async run(ctx) {
    const pad = await touch(ctx.page, ctx.log);
    try {
      const f = pad.finger();
      await ctx.sleep(800);
      await tapId(ctx, 'build-toggle');
      await ctx.sleep(700);
      await tapId(ctx, 'right-rail-build');
      await ctx.sleep(500);
      await tapId(ctx, 'build-cat-defence');
      await ctx.sleep(400);
      await ctx.page.locator('[data-testid="build-shield_pylon"] button').first().click({ timeout: 5000 });
      await ctx.sleep(900);
      // The game's own build camera: two taps, read back where each landed.
      const vw = ctx.viewport.width, vh = ctx.viewport.height;
      const a = await tapRead(ctx, f, vw * 0.3, vh * 0.3), b = await tapRead(ctx, f, vw * 0.7, vh * 0.7);
      const sx = (b.wx - a.wx) / (b.px - a.px), sy = (b.wy - a.wy) / (b.py - a.py);
      ctx.log('calibration ' + JSON.stringify({ a, b, sx, sy }));
      const at = ([x, y]: readonly [number, number]) => ({ x: a.px + (x - a.wx) / sx, y: a.py + (y - a.wy) / sy });
      // First post: tap the corner and plan it.
      const p0 = at(RUN[0]!);
      await f.tap(p0.x, p0.y);
      await ctx.sleep(900);
      await tapId(ctx, 'placement-confirm');
      await ctx.sleep(2200);
      // Run: tap near the next corner (the slot snaps), then on it, then place.
      const p1 = at(RUN[1]!);
      await f.tap(p0.x + (p1.x - p0.x) * 0.55, p0.y + (p1.y - p0.y) * 0.55);
      await ctx.sleep(1100);
      await f.tap(p1.x, p1.y);
      await ctx.sleep(1100);
      await tapId(ctx, 'placement-confirm');
      await ctx.sleep(2600);
      const p2 = at(RUN[2]!);
      await f.tap(p2.x, p2.y);
      await ctx.sleep(1100);
      await tapId(ctx, 'placement-confirm');
      await ctx.sleep(900);
      // Build (n): the planned posts are sent together and pop as they land.
      await tapId(ctx, 'placement-build');
      await ctx.sleep(2500);
      // A building on the deck: its slot outline pops as the ghost snaps slot to slot.
      await tapId(ctx, 'right-rail-build');
      await ctx.sleep(500);
      await tapId(ctx, 'build-cat-economy');
      await ctx.sleep(400);
      await ctx.page.locator('[data-testid="build-solar"] button').first().click({ timeout: 5000 });
      await ctx.sleep(900);
      for (const [fx, fy] of [[0.42, 0.45], [0.5, 0.52], [0.58, 0.45], [0.5, 0.38]] as const) {
        await f.tap(vw * fx, vh * fy);
        await ctx.sleep(1000);
      }
      await tapId(ctx, 'placement-cancel');
      await ctx.sleep(600);
    } finally {
      await pad.dispose();
    }
  },
};
