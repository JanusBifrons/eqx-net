/**
 * The vaporise death blast at the renderer seam (filmed: beam-vaporise-subcap
 * v10, the flash never showed). Three causes, each locked here:
 * - the dying hull was the pilot's parked (lingering) hull, which is not in
 *   the active sprite map, so the blast was sized for a 40 u fallback
 *   (`dyingHullDiameter`: its kind's outline);
 * - the flash was too small for its glow texture and had no floor, so a
 *   small ship's vaporise showed a dot (`VAPORISE_MIN_RADIUS`);
 * - the flash drew under the heavy beam (`stackVaporiseOverBeams`).
 */
import { describe, expect, it } from 'vitest';
import { Container, Sprite, Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../art/ArtService.js';
import { FxExplosions } from '../art/fx/FxExplosions.js';
import { shipExtent } from '../art/fields.js';
import { deathBlastFor, dyingHullDiameter, type DeathBlast } from './deathBlast.js';
import { spawnVaporiseBlast, stackVaporiseOverBeams, VAPORISE_MIN_RADIUS } from './vaporiseBlast.js';

function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: Array.from({ length: 16 }, () => Texture.WHITE), w: 1, h: 1 } });
  return { fx: () => h() } as unknown as ArtService;
}

const blank = (): DeathBlast => ({ scale: 0, linger: 0, vaporise: false, tint: 0, seconds: 0 });

function firstFrameFlash(diameter: number): { halfWidth: number; alpha: number } {
  const fx = new FxExplosions(fakeArt(), () => 'high');
  const db = deathBlastFor(true, false, 'missile-frigate', blank(), true);
  expect(spawnVaporiseBlast(null, fx, 0, 0, diameter, 1000, db)).toBe(true);
  fx.tick(1000);
  const lit = (fx.overLayer.children as Sprite[]).filter((s) => s.visible);
  return { halfWidth: Math.max(0, ...lit.map((s) => s.width / 2)), alpha: Math.max(0, ...lit.map((s) => s.alpha)) };
}

describe('spawnVaporiseBlast: the flash reads on the kill frame', () => {
  it.each([88, 120, 200])('a %i u sub-cap: the flash is wider than the hull, at full strength', (d) => {
    const f = firstFrameFlash(d);
    expect(f.halfWidth).toBeGreaterThanOrEqual(d);
    expect(f.alpha).toBeGreaterThanOrEqual(0.85);
  });

  it('a tiny ship still gets the minimum flash (reads at fight zoom, past the 60 u heavy beam)', () => {
    const f = firstFrameFlash(12);
    expect(f.halfWidth).toBeGreaterThanOrEqual(VAPORISE_MIN_RADIUS * 2);
    expect(VAPORISE_MIN_RADIUS).toBeGreaterThanOrEqual(60);
  });
});

describe('dyingHullDiameter', () => {
  const box = (w: number, h: number): Container => {
    const c = new Container();
    const s = new Sprite(Texture.WHITE); s.width = w; s.height = h; c.addChild(s);
    return c;
  };

  it('a parked (lingering) hull is sized from its kind, not the 40 u fallback', () => {
    expect(dyingHullDiameter(undefined, 'missile-frigate')).toBe(2 * shipExtent('missile-frigate'));
    expect(dyingHullDiameter(undefined, 'missile-frigate')).toBeGreaterThan(80);
  });

  it('the active sprite wins; an unknown kind with nothing drawn falls back to 40', () => {
    expect(dyingHullDiameter(box(30, 20), 'missile-frigate')).toBe(30);
    expect(dyingHullDiameter(undefined, null)).toBe(40);
    expect(dyingHullDiameter(undefined, 'no-such-kind')).toBe(40);
  });
});

describe('stackVaporiseOverBeams', () => {
  it('puts the vaporise layer above every beam container', () => {
    const ships = new Container();
    const fx = new FxExplosions(fakeArt(), () => 'high');
    ships.addChild(fx.smokeLayer, fx.fireLayer);
    const beams = [new Container(), new Container()];
    ships.addChild(...beams);
    stackVaporiseOverBeams(ships, fx);
    const at = ships.getChildIndex(fx.overLayer);
    for (const b of beams) expect(at).toBeGreaterThan(ships.getChildIndex(b));
  });
});
