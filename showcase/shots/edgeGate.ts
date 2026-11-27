import type { Shot, ShotContext } from '../types.js';
import { touch, type Finger } from '../touch.js';

/**
 * Edge feel P3 (.resume/edge-feel-plan.md): a gate in a shield fence run on the
 * `deck` test room's base, by touch. A first post; Gate on the placing strip;
 * a gate two edges away (the run fills the posts up to its seam first, then the
 * gate); Gate off and one more post from the gate's far end. Review take, not
 * in the reel.
 */
const FIRST: readonly [number, number] = [-1950, -375.28];
/** The seam midpoint between (-650, -375) and (-650, 375). */
const GATE: readonly [number, number] = [-650, 0];
/** On screen below the gate, on the plate's middle hex. */
const NEXT: readonly [number, number] = [0, -750.56];

async function tapId(ctx: ShotContext, id: string): Promise<void> {
  const el = ctx.page.getByTestId(id).first();
  ctx.log(id + ' ' + JSON.stringify(await el.evaluate((e) => ({ dis: (e as HTMLButtonElement).disabled, txt: document.body.innerText.match(/Can.t build[^\n]*/)?.[0] ?? '' })).catch(() => 'missing')));
  await el.click({ timeout: 5000 });
}

const SNAP_DIR = process.env.EQX_GATE_SNAPS ?? '';
/** Log where the ghost snapped (and, for review, save a still). */
async function note(ctx: ShotContext, tag: string): Promise<void> {
  const d = await ctx.page.evaluate(() => {
    const ds = (document.querySelector('[data-testid="game-surface"]') as HTMLElement | null)?.dataset ?? {};
    return { wx: ds.placementWorldX, wy: ds.placementWorldY, txt: document.body.innerText.match(/Can.t build[^\n]*/)?.[0] ?? '' };
  });
  ctx.log('note ' + tag + ' ' + JSON.stringify(d));
  if (SNAP_DIR !== '') await ctx.page.screenshot({ path: SNAP_DIR + '/' + tag + '.png' }).catch(() => undefined);
}

/** Press a placing-strip button with the finger, as a phone does (a mouse
 *  click would leave the desktop hover tooltip over the next button). */
async function press(ctx: ShotContext, f: Finger, id: string): Promise<void> {
  const box = await ctx.page.getByTestId(id).first().boundingBox();
  if (box === null) { ctx.log(id + ' missing'); return; }
  await f.tap(box.x + box.width / 2, box.y + box.height / 2);
}

/** Place, unless the ghost is refused (the take goes on; the log says why). */
async function confirm(ctx: ShotContext, f: Finger): Promise<void> {
  const el = ctx.page.getByTestId('placement-confirm').first();
  if (await el.isDisabled().catch(() => true)) { ctx.log('confirm skipped: disabled'); return; }
  await press(ctx, f, 'placement-confirm');
}

async function tapRead(ctx: ShotContext, f: Finger, x: number, y: number): Promise<{ wx: number; wy: number; px: number; py: number }> {
  await f.tap(x, y);
  await ctx.sleep(500);
  return ctx.page.evaluate(() => {
    const d = (document.querySelector('[data-testid="game-surface"]') as HTMLElement | null)?.dataset ?? {};
    return { wx: Number(d.placementWorldX), wy: Number(d.placementWorldY), px: Number(d.placementScreenX), py: Number(d.placementScreenY) };
  });
}

export const edgeGatePhone: Shot = {
  id: 'edge-gate-phone',
  section: 'mechanics',
  title: 'A gate in a shield fence',
  caption: 'A gate in a shield fence: Gate on the placing strip puts a gate in the run, filling the posts up to it first (review take).',
  features: ['ART'],
  docs: ['procedural-bases'],
  reel: false,
  server: 'lean',
  viewport: 'phone-landscape',
  target: { room: 'deck', params: { shipKind: 'fighter', initialHull: 1_000_000, zoom: 0.4 } },
  hud: 'full',
  durationMs: 24_000,
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
      // First post.
      const p0 = at(FIRST);
      await f.tap(p0.x, p0.y);
      await ctx.sleep(900);
      await note(ctx, '1-first');
      await confirm(ctx, f);
      await ctx.sleep(2000);
      // Gate on: the hover shows the posts up to the seam, then the gate.
      await press(ctx, f, 'placement-gate');
      await ctx.sleep(900);
      const g = at(GATE);
      await f.tap(g.x, g.y);
      await ctx.sleep(1800);
      await note(ctx, '2-gate-hover');
      await confirm(ctx, f);
      await ctx.sleep(3200);
      await note(ctx, '3-gate-planned');
      // Gate off: back to posts, the run goes on from the gate's far end.
      await press(ctx, f, 'placement-gate');
      await ctx.sleep(900);
      const p1 = at(NEXT);
      await f.tap(p1.x, p1.y);
      await ctx.sleep(1500);
      await note(ctx, '4-next-hover');
      await confirm(ctx, f);
      await ctx.sleep(900);
      // Build (n): the planned posts and gate are sent together.
      await press(ctx, f, 'placement-build');
      await ctx.sleep(3000);
      await note(ctx, '5-end');
      await press(ctx, f, 'placement-cancel');
      await ctx.sleep(800);
    } finally {
      await pad.dispose();
    }
  },
};
