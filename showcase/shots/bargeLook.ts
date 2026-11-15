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
  camera: [{ atMs: 0, smoothMs: 0, shot: { kind: 'frame', group: 'all', padding: 0.45, maxZoom: 3 } }],
};

/**
 * The stern close-up under thrust: an NPC barge flies a straight line at
 * about 60 % of its top speed (its engines at full thrust; an AI ship's
 * engine level follows its speed), and the camera, as a spectator, tracks it
 * from astern with the stern in the upper half of the frame, clear of the
 * caption and the build bar (the camera moves, never the HUD).
 */
export const bargeStern: Shot = {
  id: 'barge-stern',
  section: 'mechanics',
  title: 'Mining barge engines',
  caption: 'The mining barge under way: its oversized stern engines at full thrust.',
  features: ['CAP'],
  docs: ['mining-and-salvage'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-barge-thrust', params: { sectorScale: '4', shipKind: 'fighter' } },
  hud: 'none',
  durationMs: 10_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    await ctx.page.waitForFunction(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient;
      let n = 0;
      c?.mirror.swarm.forEach((e) => { if (e.kind === 1) n++; });
      return n > 0;
    }, null, { timeout: 60_000, polling: 250 });
    await ctx.spectate();
  },
  async run(ctx) {
    const k = ctx.viewport.width / 1920;
    const id = await ctx.page.evaluate(() => {
      const c = (globalThis as { __eqxClient?: { mirror: { swarm: Map<number, { kind: number }> } } }).__eqxClient;
      let found: number | null = null;
      c?.mirror.swarm.forEach((e, eid) => { if (found === null && e.kind === 1) found = eid; });
      return found;
    });
    const target = id === null ? 'local' : `swarm-${id}`;
    await ctx.cinema.play([
      { atMs: 0, smoothMs: 0, shot: { kind: 'track', target, zoom: 0.18 * k, offsetY: -4000 } },
      { atMs: 5500, smoothMs: 1500, shot: { kind: 'track', target, zoom: 0.24 * k, offsetY: -4380 } },
    ]);
    await ctx.sleep(9_800);
  },
};

/** The pilot flies the barge look at full thrust with the game's follow
 *  camera, zoomed out to the whole hull and its plume. */
export const bargeThrust: Shot = {
  id: 'barge-thrust',
  section: 'mechanics',
  title: 'Mining barge at full thrust',
  caption: 'The mining barge look at full thrust: the whole hull and its plume.',
  features: ['CAP'],
  docs: ['mining-and-salvage'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-barge-look', params: { sectorScale: '4', shipKind: 'barge-look', spawnX: -7000, spawnY: -2000, initialHull: 1_000_000 } },
  hud: 'none',
  durationMs: 14_000,
  async startWhen(ctx) {
    await artSettled(ctx);
  },
  async run(ctx) {
    const c = ctx.px(960, 540);
    await ctx.page.mouse.move(c.x, c.y);
    await ctx.page.getByRole('button', { name: 'Full', exact: true }).first().click();
    await ctx.page.mouse.move(c.x, c.y);
    await ctx.page.keyboard.down('ArrowUp');
    try {
      await wheelSteps(ctx, 100, 6, 200);
      await ctx.sleep(11_500);
    } finally {
      await ctx.page.keyboard.up('ArrowUp');
    }
  },
};

async function wheelSteps(ctx: ShotContext, dy: number, n: number, gapMs: number): Promise<void> {
  for (let i = 0; i < n; i++) { await ctx.page.mouse.wheel(0, dy); await ctx.sleep(gapMs); }
}
