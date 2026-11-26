import type { Shot, ShotContext } from '../types.js';
import { touch, type Finger } from '../touch.js';
import { polar, type Pt } from '../touchPath.js';
import { localPose } from './_pilot.js';

/**
 * Base platforms (docs: .resume/base-platforms-plan.md): a phone pilot flies a
 * loop over the sparse generated base in the `deck-bases` test room — hex deck
 * plates, roads with junction boxes, cables under, solar rigs, the fence ring.
 * Touch only: left thumb on the move stick, right thumb on boost for the first
 * leg. Zoom asks for 0.12; the game clamps it to the phone's zoom-out floor
 * for the fighter, which is what a player sees at full zoom-out.
 */
type Rect = { x: number; y: number; width: number; height: number };

async function rectOf(ctx: ShotContext, sel: string): Promise<Rect | null> {
  const loc = ctx.page.locator(sel);
  if ((await loc.count().catch(() => 0)) === 0) return null;
  return loc.first().boundingBox({ timeout: 300 }).catch(() => null);
}

/** Push the stick `angle` (screen radians, 0 = right) for `ms`. */
async function steer(f: Finger, anchor: Pt, angle: number, ms: number): Promise<void> {
  const p = polar(anchor, 30, angle);
  await f.dragTo(p.x, p.y, { ms: 350 });
  await f.hold(ms);
}

export const deckBasesPhone: Shot = {
  id: 'deck-bases-phone',
  section: 'mechanics',
  title: 'Base platforms: flying over a deck base',
  caption: 'Bases stand on a hex deck: roads, cables under, solar rigs and a fence ring (review take).',
  features: ['ART'],
  docs: ['procedural-bases'],
  reel: false,
  server: 'lean',
  viewport: 'phone-landscape',
  target: { room: 'deck-bases', params: { shipKind: 'fighter', spawnX: -2600, spawnY: -400, zoom: 0.12, initialHull: 1_000_000 } },
  hud: 'full',
  durationMs: 24_000,
  async run(ctx) {
    const pad = await touch(ctx.page, ctx.log);
    try {
      const left = pad.finger();
      const right = pad.finger();
      const zone = await rectOf(ctx, '[data-testid="hud-move-zone"]');
      const anchor = zone
        ? { x: zone.x + Math.min(120, zone.width * 0.3), y: zone.y + zone.height * 0.62 }
        : { x: 120, y: ctx.viewport.height - 110 };
      const boost = await rectOf(ctx, '[data-testid="hud-boost"]');
      await ctx.sleep(1500);
      await left.down(anchor.x, anchor.y);
      if (boost) await right.down(boost.x + boost.width / 2, boost.y + boost.height / 2);
      await steer(left, anchor, 0, 6000); // east across the base
      if (boost) await right.up();
      await steer(left, anchor, -Math.PI / 4, 2500); // bank north-east
      await steer(left, anchor, -Math.PI / 2, 3500); // north
      await steer(left, anchor, Math.PI, 6500); // back west along the north side
      await left.dragTo(anchor.x, anchor.y, { ms: 300 });
      await left.up();
      await ctx.sleep(1500);
    } finally {
      await pad.dispose();
    }
  },
};

/** The sparse base's road, hex by hex (plate-centre road tiles of the
 *  `deck-bases` room's sparse base, seed 7): in from the west end, along the
 *  row through the junction to the east end. */
const ROAD_ROUTE: ReadonlyArray<[number, number]> = [
  [-3900, 0], [-3250, 1126], [-1950, 1126], [-650, 1126], [0, 2252],
  [1300, 2252], [2600, 2252], [3900, 2252], [4550, 1126],
];

/** Steer the stick at each route point in turn from the ship's live pose,
 *  like a thumb following the road; stop at the end or after `maxMs`. */
async function followRoute(ctx: ShotContext, f: Finger, anchor: Pt, route: ReadonlyArray<[number, number]>, maxMs: number): Promise<void> {
  const t0 = Date.now(); // -- real time: shot pacing, outside the game
  let i = 0;
  while (i < route.length && Date.now() - t0 < maxMs) { // -- real time: shot pacing
    const p = await localPose(ctx);
    if (p) {
      const [tx, ty] = route[i]!;
      if (Math.hypot(tx - p.x, ty - p.y) < 260) { i++; continue; }
      const q = polar(anchor, 30, Math.atan2(ty - p.y, tx - p.x));
      await f.moveTo(q.x, q.y);
    }
    await ctx.sleep(80);
  }
}

/** Fighter's-eye view (the game's normal fighter zoom): fly along the base's
 *  road so the deck's scale reads against the ship. Touch stick only. */
export const deckBasesRoadPhone: Shot = {
  id: 'deck-bases-road-phone',
  section: 'mechanics',
  title: 'Base platforms: following a deck road',
  caption: 'A fighter at normal zoom follows a base road across the hex deck (review take).',
  features: ['ART'],
  docs: ['procedural-bases'],
  reel: false,
  server: 'lean',
  viewport: 'phone-landscape',
  target: { room: 'deck-bases', params: { shipKind: 'fighter', spawnX: -4300, spawnY: -300, initialHull: 1_000_000 } },
  hud: 'full',
  durationMs: 30_000,
  async run(ctx) {
    const pad = await touch(ctx.page, ctx.log);
    try {
      const left = pad.finger();
      const zone = await rectOf(ctx, '[data-testid="hud-move-zone"]');
      const anchor = zone
        ? { x: zone.x + Math.min(120, zone.width * 0.3), y: zone.y + zone.height * 0.62 }
        : { x: 120, y: ctx.viewport.height - 110 };
      await ctx.sleep(1500);
      await left.down(anchor.x, anchor.y);
      await followRoute(ctx, left, anchor, ROAD_ROUTE, 26_000);
      await left.dragTo(anchor.x, anchor.y, { ms: 300 });
      await left.up();
      await ctx.sleep(1000);
    } finally {
      await pad.dispose();
    }
  },
};
