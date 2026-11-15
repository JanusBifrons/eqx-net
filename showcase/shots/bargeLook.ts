import type { Shot } from '../types.js';
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

/** The pilot joins in the barge look (this room lets a player join in a
 *  capital), orders Full, then watches as a spectator from close astern so the
 *  oversized engines fill the frame (the follow camera cannot zoom past the
 *  whole hull). Spectating parks the hull, so the engines are seen at rest. */
export const bargeEngines: Shot = {
  id: 'barge-engines',
  section: 'mechanics',
  title: 'Mining barge engines',
  caption: 'The mining barge look from close astern: its oversized stern engines.',
  features: ['CAP'],
  docs: ['mining-and-salvage'],
  reel: false,
  server: 'capitals',
  target: { room: 'showcase-barge-look', params: { sectorScale: '4', shipKind: 'barge-look', spawnX: -7000, spawnY: -2000, initialHull: 1_000_000 } },
  hud: 'none',
  durationMs: 10_000,
  async startWhen(ctx) {
    await artSettled(ctx);
    await ctx.page.getByRole('button', { name: 'Full', exact: true }).first().click();
    await ctx.sleep(4000);
    await ctx.spectate();
  },
  camera: [
    { atMs: 0, smoothMs: 0, shot: { kind: 'track', target: 'local', zoom: 0.4, offsetY: -3900 } },
    { atMs: 5000, smoothMs: 1500, shot: { kind: 'track', target: 'local', zoom: 0.22, offsetY: -3200 } },
  ],
};
