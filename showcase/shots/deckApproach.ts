import type { Shot, ShotContext, ShotTarget } from '../types.js';

/**
 * Diagnosis stills of the deck runway approach lights
 * (`src/client/render/pixi/deckApproachLights.ts`) as a fighter pilot sees
 * them on a phone: the `deck-bases` room's sparse base has a fence gate at
 * (-4550, 0), turned 90°, whose outside is west, so its lamps run west along
 * y = 0 from x = -4690 (red/green edge rows at y = ±175). The fighter spawns
 * between lamps 1 and 2 (on the centre line at the zoom cap). Review take, not in the reel. With
 * `EQX_APPROACH_SNAPS=<dir>` it saves stills there:
 *   a-spawn-zoom.png   — the fighter's default start zoom;
 *   b-zoom-cap.png     — fully zoomed in (`?zoom=` past the cap is clamped);
 *   c-strobe-NN.png    — a burst at the zoom cap, to catch the rabbit strobe;
 *   d-build-view.png   — the Build camera (Build toggle, pulled back);
 *   e-zoom-cap-edge.png — the zoom cap beside the red (port) edge row.
 */
const SNAP_DIR = process.env['EQX_APPROACH_SNAPS'] ?? '';
const ROOM = 'deck-bases';
const BASE = { shipKind: 'fighter', spawnX: -4890, spawnY: 90, initialHull: 1_000_000 };

/** Log the camera zoom (CSS px per world unit) and where lamps 0 and 9 land
 *  on screen, then save a still. */
async function snap(ctx: ShotContext, tag: string): Promise<void> {
  const d = await ctx.page.evaluate(() => {
    const w = window as unknown as { __eqxWorldToScreen?: (x: number, y: number) => { x: number; y: number } };
    const f = w.__eqxWorldToScreen;
    if (!f) return null;
    const a = f(-4690, 0), b = f(-4690 - 9 * 135, 0), c = f(-4690, 175);
    return { zoom: Math.hypot(b.x - a.x, b.y - a.y) / (9 * 135), lamp0: a, lamp9: b, port0: c };
  });
  ctx.log('snap ' + tag + ' ' + JSON.stringify(d));
  if (SNAP_DIR !== '') await ctx.page.screenshot({ path: SNAP_DIR + '/' + tag + '.png' }).catch(() => undefined);
}

function target(params: Record<string, string | number>): ShotTarget {
  return { room: ROOM, params: { ...BASE, ...params } };
}

export const deckApproachStills: Shot = {
  id: 'deck-approach-stills',
  section: 'mechanics',
  title: 'Base platforms: runway approach lights (stills)',
  caption: 'A fighter beside a deck gate\'s approach lights, at spawn zoom and fully zoomed in (review stills).',
  features: ['ART'],
  docs: ['procedural-bases'],
  reel: false,
  server: 'lean',
  viewport: 'phone-landscape',
  target: target({}),
  hud: 'full',
  durationMs: 90_000,
  endsWithRun: true,
  async run(ctx) {
    await ctx.sleep(2500);
    await snap(ctx, 'a-spawn-zoom');
    await ctx.page.getByTestId('build-toggle').first().tap({ timeout: 5000 }).catch((e: unknown) => ctx.log('build tap failed ' + String(e)));
    await ctx.sleep(2500);
    await snap(ctx, 'd-build-view');
    // At the cap the view is ~280 world units wide: centre on the lamp row,
    // midway between lamps 1 and 2 so the hull covers neither. A fresh room
    // (own testId): a rejoin of the same room keeps the old hull's pose.
    await ctx.enter(target({ zoom: 50, spawnX: -4892, spawnY: 0, testId: ctx.testId + '-cap' }));
    await ctx.sleep(2500);
    await snap(ctx, 'b-zoom-cap');
    for (let i = 0; i < 16; i++) {
      await snap(ctx, 'c-strobe-' + String(i).padStart(2, '0'));
      await ctx.sleep(40);
    }
    // The red (port) edge row at the cap, beside edge lamps 1 and 2.
    await ctx.enter(target({ zoom: 50, spawnX: -4892, spawnY: 175, testId: ctx.testId + '-edge' }));
    await ctx.sleep(2500);
    await snap(ctx, 'e-zoom-cap-edge');
  },
};
