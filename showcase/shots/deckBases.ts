import type { Shot, ShotContext } from '../types.js';
import { touch, type Finger } from '../touch.js';
import { polar, type Pt } from '../touchPath.js';

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
