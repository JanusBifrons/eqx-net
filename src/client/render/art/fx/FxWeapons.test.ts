/**
 * New weapon effects (plan iridescent-seeking-rainbow v3, B3): bolts and
 * tracers are pooled sprite views; beams get a glow, a flowing strip, and a
 * flare only where they land.
 */
import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxBeams, FxProjectiles, fxProjectileStyle } from './FxWeapons.js';

/** An ArtService stand-in whose effect textures are ready at once. */
function fakeArt(): ArtService {
  const h = (): ArtHandle => ({ key: 'k', job: { type: 'fx', id: 'x' }, rig: undefined as never, state: 'ready', ship: null, struct: null,
    fx: { tex: Texture.WHITE, frames: [Texture.WHITE], w: 1, h: 1 } });
  return { fx: () => h() } as unknown as ArtService;
}

describe('fxProjectileStyle', () => {
  it('lasers are bolts, other projectiles tracers; beams and pulse orbs keep today\'s look', () => {
    expect(fxProjectileStyle('laser', false)).toBe('bolt');
    expect(fxProjectileStyle('autocannon', false)).toBe('tracer');
    expect(fxProjectileStyle(undefined, false)).toBe('tracer');
    expect(fxProjectileStyle('pulse-orb', false)).toBeNull();
    expect(fxProjectileStyle('laser', true)).toBeNull();
  });

  it('capital naval guns fire calibre-scaled shells (visible at capital zoom)', () => {
    for (const id of ['naval_s', 'naval_m', 'naval_l', 'naval_xl']) expect(fxProjectileStyle(id, false)).toBe('shell');
    const p = new FxProjectiles(fakeArt());
    p.beginFrame();
    p.draw('small', 'shell', 0, 0, 100, 0, 1, 3);
    p.draw('big', 'shell', 0, 0, 100, 0, 1, 6);
    p.endFrame();
    const kids = p.container.children as Array<{ visible: boolean; scale: { x: number } }>;
    // Each view adds head, core and 3 trail sprites, in that order.
    expect(kids[5]!.scale.x).toBeCloseTo(kids[0]!.scale.x * 2, 5);
  });
});

describe('FxProjectiles', () => {
  it('reuses views: a projectile gone this frame goes back to the pool', () => {
    const p = new FxProjectiles(fakeArt());
    p.beginFrame();
    p.draw('a', 'bolt', 0, 0, 100, 0, 1);
    p.draw('b', 'tracer', 10, 0, 0, 100, 1);
    p.endFrame();
    expect(p.liveCount()).toBe(2);
    const sprites = p.container.children.length;
    p.beginFrame();
    p.draw('b', 'tracer', 10, 5, 0, 100, 1);
    p.endFrame();
    expect(p.liveCount()).toBe(1);
    p.beginFrame();
    p.draw('c', 'bolt', 0, 0, 100, 0, 1); // takes a's pooled view
    p.draw('b', 'tracer', 10, 9, 0, 100, 1);
    p.endFrame();
    expect(p.container.children.length).toBe(sprites);
  });

  it('a bolt faces its velocity (game space, Y up)', () => {
    const p = new FxProjectiles(fakeArt());
    p.beginFrame();
    p.draw('a', 'bolt', 0, 0, 0, 100, 1); // moving "up" in game space
    p.endFrame();
    const head = p.container.children[0]!;
    expect(head.rotation).toBeCloseTo(-Math.PI / 2);
  });

  it('a far 16" shell heading south-east draws along its velocity, trail behind it (#376 review)', () => {
    // Review 2026-11-09: "far shell streaks run nearly vertical while their
    // barrels point south-east". Measured in a re-take: every shell's drawn
    // heading equalled its velocity and its frame-to-frame motion; the
    // vertical streaks were the backdrop's speed dust stretched along the
    // fighter's northward flight. This locks the shell side.
    const p = new FxProjectiles(fakeArt());
    const vx = 1626, vy = -1626; // ~2300 u/s, game space south-east
    p.beginFrame();
    p.draw('far', 'shell', 4000, -4000, vx, vy, 1, 6); // late in flight, far away
    p.endFrame();
    const [head, core, t0] = p.container.children as Array<{ rotation: number; position: { x: number; y: number } }>;
    const screenHeading = Math.atan2(-vy, vx); // pixi Y is down
    expect(head!.rotation).toBeCloseTo(screenHeading, 6);
    expect(core!.rotation).toBeCloseTo(screenHeading, 6);
    expect(t0!.rotation).toBeCloseTo(screenHeading, 6);
    // The first trail sprite sits behind the head, opposite the travel.
    const bx = t0!.position.x - head!.position.x, by = t0!.position.y - head!.position.y;
    expect(Math.atan2(by, bx)).toBeCloseTo(screenHeading - Math.PI, 6);
  });

  it('a shell streak never reaches ahead of the shell, nor back past where it was fired (owner 2026-11-12)', () => {
    // Long-guns clip: "the shots fired show even after they hit". At a
    // battleship's gunnery zoom the 3 px minimum width scales a 16" streak to
    // ~3.5 km, and the streak was CENTRED on the shell, so ~1.7 km of it ran
    // ahead: its front crossed a ~500 u hull and ran on before the shell
    // landed. A tracer's streak trails its shell, and cannot be longer than
    // the distance flown.
    const p = new FxProjectiles(fakeArt());
    const flown = 900;
    p.beginFrame();
    p.draw('s', 'shell', 0, 0, 2300, 0, 1, 90, flown); // moving +x, huge (gunnery zoom)
    p.endFrame();
    const kids = p.container.children as Array<{ visible: boolean; position: { x: number }; scale: { x: number }; anchor: { x: number }; texture: { width: number } }>;
    for (const s of kids.slice(0, 5)) {
      if (!s.visible) continue;
      const len = s.scale.x * s.texture.width;
      const front = s.position.x + (1 - s.anchor.x) * len;
      const back = s.position.x - s.anchor.x * len;
      expect(front, 'no part of the streak is ahead of the shell').toBeLessThanOrEqual(1e-6);
      expect(back, 'no part of the streak is behind the gun that fired it').toBeGreaterThanOrEqual(-flown - 1e-6);
    }
  });

  it('a just-fired shell is a thin short streak, not a fat block (owner 2026-11-12)', () => {
    // Capping only the LENGTH at the distance flown left the width at the
    // gunnery-zoom minimum, so for the first second a shell drew as a short
    // rectangle wider than long: "pixelated blocks" at the turrets. The
    // streak keeps its proportions while it grows.
    const p = new FxProjectiles(fakeArt());
    p.beginFrame();
    p.draw('s', 'shell', 0, 0, 2300, 0, 1, 90, 120); // 120 u out of the barrel
    p.endFrame();
    const kids = p.container.children as Array<{ visible: boolean; scale: { x: number; y: number }; texture: { width: number; height: number } }>;
    for (const s of kids.slice(0, 5)) {
      if (!s.visible) continue;
      const len = s.scale.x * s.texture.width;
      const wid = s.scale.y * s.texture.height;
      expect(wid, `a ${len.toFixed(0)} u streak drawn ${wid.toFixed(0)} u wide`).toBeLessThanOrEqual(len * 0.5 + 1);
    }
  });
});

describe('FxBeams', () => {
  it('a beam that lands gets a flare; a beam fading past its solid length gets a tail instead', () => {
    const b = new FxBeams(fakeArt(), 0x6fd0ff);
    b.setBeams([{ fromX: 0, fromY: 0, toX: 100, toY: 0 }, { fromX: 0, fromY: 50, toX: 300, toY: 50, solidLen: 120 }], 2, 0);
    const kids = b.container.children; // per beam: halo, flow, tail, muzzle, flare
    const [, , tail0, , flare0, , , tail1, , flare1] = kids;
    expect(flare0!.visible).toBe(true);
    expect(tail0!.visible).toBe(false);
    expect(flare1!.visible).toBe(false);
    expect(tail1!.visible).toBe(true);
  });

  it('remote beams: a miss fades over the last part of its range', () => {
    const b = new FxBeams(fakeArt(), 0xffaa44);
    b.setBeams([{ fromX: 0, fromY: 0, toX: 200, toY: 0 }], 1, 0, [false]);
    expect(b.container.children[4]!.visible).toBe(false); // no flare
    b.setBeams([{ fromX: 0, fromY: 0, toX: 200, toY: 0 }], 1, 0, [true]);
    expect(b.container.children[4]!.visible).toBe(true);
  });

  it('hides slots beyond the live count', () => {
    const b = new FxBeams(fakeArt(), 0x6fd0ff);
    b.setBeams([{ fromX: 0, fromY: 0, toX: 100, toY: 0 }, { fromX: 0, fromY: 0, toX: 100, toY: 0 }], 2, 0);
    b.setBeams([{ fromX: 0, fromY: 0, toX: 100, toY: 0 }], 1, 0);
    expect(b.container.children.slice(5).every((c) => !c.visible)).toBe(true);
  });
});
