import type { Shot, ShotContext } from '../types.js';
import { artSettled } from './capitals.js';

/**
 * Mining-barge look options (plan partitioned-chasing-lark, PR 14), filmed per
 * look with `EQX_BARGE_LOOK=A|B|C` (the recorder passes it to the page as
 * `?bargeLook=`). Not in the reel: these are for the owner's pick.
 */
export const bargeLook: Shot = {
  id: 'barge-look',
  section: 'mechanics',
  title: 'Mining barge look',
  caption: 'A mining barge look option beside a battleship and a few small ships, for scale.',
  features: ['CAP'],
  docs: ['mining-and-salvage'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-barge-look', params: { sectorScale: '4', shipKind: 'fighter' } },
  hud: 'none',
  durationMs: 9_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    // A framed camera needs a free camera: watch as a spectator (record as is).
    await ctx.spectate();
  },
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'all', padding: 0.3, maxZoom: 3 } }],
};

/** The pilot flies the barge look (this room lets a player join in a capital)
 *  under full thrust, zoomed out until the stern engines are in frame. */
export const bargeEngines: Shot = {
  id: 'barge-engines',
  section: 'mechanics',
  title: 'Mining barge engines',
  caption: 'The mining barge look under full thrust: its oversized stern engines.',
  features: ['CAP'],
  docs: ['mining-and-salvage'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-barge-look', params: { sectorScale: '4', shipKind: 'barge-look', spawnX: -7000, spawnY: -2000, initialHull: 1_000_000 } },
  hud: 'none',
  durationMs: 16_000,
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    const c = ctx.px(960, 540);
    await ctx.page.mouse.move(c.x, c.y);
    await ctx.page.keyboard.down('ArrowUp');
    try {
      await wheelSteps(ctx, 100, 4, 200);
      await ctx.sleep(6000);
      await wheelSteps(ctx, 100, 6, 200);
      await ctx.sleep(6500);
    } finally {
      await ctx.page.keyboard.up('ArrowUp');
    }
  },
};

async function wheelSteps(ctx: ShotContext, dy: number, n: number, gapMs: number): Promise<void> {
  for (let i = 0; i < n; i++) { await ctx.page.mouse.wheel(0, dy); await ctx.sleep(gapMs); }
}
