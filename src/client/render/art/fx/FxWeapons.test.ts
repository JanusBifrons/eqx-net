/**
 * New weapon effects (plan iridescent-seeking-rainbow v3, B3): bolts and
 * tracers are pooled sprite views; beams get a glow, a flowing strip, and a
 * flare only where they land.
 */
import { describe, expect, it } from 'vitest';
import { Texture, type Sprite } from 'pixi.js';
import type { ArtHandle, ArtService } from '../ArtService.js';
import { FxBeams, FxProjectiles, fxProjectileStyle, FX_GLOW_OVER_CORE } from './FxWeapons.js';
import { HEAVY_BEAM_MIN_SCREEN_PX, HEAVY_BEAM_STYLE } from '../../beamStyles.js';
import * as turretFx from './turretFx.js';

/** 0xRRGGBB → [r, g, b]. */
const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

describe('the railgun muzzle flash', () => {
  // Hostile review 2026-11-15: the flash read mostly neutral grey-white.
  it('flash and its hull light are white-blue: blue-dominant, still bright', () => {
    const fx = turretFx as unknown as Record<string, number | undefined>;
    for (const name of ['RAIL_FLASH_TINT', 'RAIL_FLASH_LIGHT']) {
      const c = fx[name];
      expect(c, name).toBeTypeOf('number');
      const [r, g, b] = rgb(c!);
      expect(b, `${name} blue full`).toBeGreaterThanOrEqual(250);
      expect(r, `${name} red well under blue`).toBeLessThanOrEqual(0.6 * b);
      expect(g, `${name} green under blue`).toBeLessThanOrEqual(0.8 * b);
      expect((r + g + b) / 3, `${name} bright, not navy`).toBeGreaterThanOrEqual(150);
    }
  });
});

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

  // At capital zoom the heavy beam's core is floored at 12 px; its 60 u halo
  // (20 u × glowScale 3) was ~2 px there, inside the core, so the glow never
  // showed. The halo stays wider than the on-screen core.
  it('the heavy beam halo stays wider than its screen-floored core at capital zoom', () => {
    const b = new FxBeams(fakeArt(), 0xffaa44);
    const cam = 0.03;
    b.setBeams([{ fromX: 0, fromY: 0, toX: 3000, toY: 0, style: HEAVY_BEAM_STYLE }], 1, 0, [true], cam);
    const halo = b.container.children[0]!;
    const coreW = HEAVY_BEAM_MIN_SCREEN_PX / cam;
    expect(halo.scale.y) // WHITE is 1 px tall
      .toBeGreaterThanOrEqual(coreW * FX_GLOW_OVER_CORE.halo * 0.88 - 1e-6);
    // A fighter beam keeps its own world-size halo.
    b.setBeams([{ fromX: 0, fromY: 0, toX: 300, toY: 0 }], 1, 0, [true], cam);
    expect(halo.scale.y).toBeLessThanOrEqual(20);
  });

  it('hides slots beyond the live count', () => {
    const b = new FxBeams(fakeArt(), 0x6fd0ff);
    b.setBeams([{ fromX: 0, fromY: 0, toX: 100, toY: 0 }, { fromX: 0, fromY: 0, toX: 100, toY: 0 }], 2, 0);
    b.setBeams([{ fromX: 0, fromY: 0, toX: 100, toY: 0 }], 1, 0);
    expect(b.container.children.slice(5).every((c) => !c.visible)).toBe(true);
  });
});

describe('FxProjectiles: the railgun slug wake', () => {
  it('a slug leaves a wake that lingers after it is gone, then fades (pieces per effects tier)', () => {
    let now = 10_000;
    let q: 'high' | 'medium' | 'low' | 'minimal' = 'high';
    const p = new FxProjectiles(fakeArt(), () => q, () => now);
    const shown = (): number => p.wakeLayer.children.filter((c) => c.visible).length;
    p.beginFrame();
    p.draw('s', 'slug', 3000, 0, 6000, 0, 1, 2, 3000); // 3 km out of the barrel
    p.endFrame();
    expect(shown()).toBe(10);
    now += 300;
    p.beginFrame(); p.endFrame(); // the slug is gone (it hit)
    expect(p.wakeCount()).toBe(1);
    expect(shown()).toBeGreaterThan(0);
    now += 2_000; // past SLUG_WAKE_LIFE_S
    p.beginFrame(); p.endFrame();
    expect(shown()).toBe(0);
    expect(p.wakeCount()).toBe(0);
    q = 'medium';
    p.beginFrame(); p.draw('t', 'slug', 3000, 0, 6000, 0, 1, 2, 3000); p.endFrame();
    expect(shown()).toBe(6);
    q = 'minimal';
    p.beginFrame(); p.draw('t', 'slug', 3100, 0, 6000, 0, 1, 2, 3100); p.endFrame();
    expect(shown()).toBe(0);
  });

  // The owner's pick (2026-11-15, from five filmed versions): v6's look with
  // v4's longer trail. The wake runs from the muzzle to the slug and lingers
  // ~1.6 s where the slug passed, each piece fading and spreading as it goes.
  it('the wake runs back from the slug toward the muzzle and lingers ~1.6 s of flight behind it', () => {
    let now = 10_000;
    const p = new FxProjectiles(fakeArt(), () => 'high', () => now);
    const SP = 6_450;
    const vis = (): Sprite[] => p.wakeLayer.children.filter((c) => c.visible && c.alpha > 0.01) as Sprite[];
    const back = (): number => Math.min(...vis().map((s) => s.x - s.scale.x / 2));
    // Fresh out of the barrel (3 km flown): the wake reaches the muzzle.
    p.beginFrame(); p.draw('s', 'slug', 3_000, 0, SP, 0, 1, 5, 3_000); p.endFrame();
    expect(vis().length).toBe(10);
    expect(back(), 'reaches back to the muzzle').toBeLessThanOrEqual(300);
    for (const s of vis()) {
      expect(s.rotation).toBeCloseTo(0); // heading +x; Texture.WHITE: scale.x = length
      expect(s.x + s.scale.x / 2, 'nothing ahead of the slug').toBeLessThanOrEqual(3_000 * 1.05);
    }
    // 30 km down range: the wake still shows ~1.5 s of flight behind it (a
    // long trail, many kilometres), but nothing older than its life.
    const p2 = new FxProjectiles(fakeArt(), () => 'high', () => now);
    p2.beginFrame(); p2.draw('s', 'slug', 30_000, 0, SP, 0, 1, 5, 30_000); p2.endFrame();
    const v2 = p2.wakeLayer.children.filter((c) => c.visible && c.alpha > 0.01) as Sprite[];
    const back2 = Math.min(...v2.map((s) => s.x - s.scale.x / 2));
    expect(30_000 - back2, 'a long trail: over 1 s of flight behind the slug').toBeGreaterThanOrEqual(SP);
    expect(30_000 - back2, 'no older than its life').toBeLessThanOrEqual(SP * turretFx.SLUG_WAKE_LIFE_S + 30_000 / 10);
  });

  it('after the slug hits, its wake lingers over a second, fading and widening, then is gone', () => {
    let now = 10_000;
    const p = new FxProjectiles(fakeArt(), () => 'high', () => now);
    const vis = (): Sprite[] => p.wakeLayer.children.filter((c) => c.visible) as Sprite[];
    p.beginFrame(); p.draw('s', 'slug', 3_000, 0, 6_450, 0, 1, 5, 3_000); p.endFrame();
    const last = (): Sprite => vis().reduce((a, b) => (b.x > a.x ? b : a));
    const a0 = last().alpha, w0 = last().scale.y;
    now += 1_000;
    p.beginFrame(); p.endFrame(); // the slug is gone
    expect(vis().length, 'still lingering at 1 s').toBeGreaterThan(0);
    expect(last().alpha).toBeLessThan(a0);
    expect(last().scale.y).toBeGreaterThan(w0);
    now += 700; // past SLUG_WAKE_LIFE_S since the slug last passed any of it
    p.beginFrame(); p.endFrame();
    expect(vis().length).toBe(0);
    expect(p.wakeCount()).toBe(0);
  });

  it('shells and bolts leave no wake', () => {
    const p = new FxProjectiles(fakeArt(), () => 'high', () => 0);
    p.beginFrame();
    p.draw('a', 'shell', 0, 0, 100, 0, 1, 3, 500);
    p.draw('b', 'bolt', 0, 0, 100, 0, 1);
    p.endFrame();
    expect(p.wakeLayer.children.length).toBe(0);
  });
});

// The owner's pick (2026-11-15): v6's slug, a long white-hot streak (~1 km
// at its native size, 200 × its radius) with trail streaks behind it.
describe('FxProjectiles: the railgun slug is the long white streak', () => {
  type S = { visible: boolean; x: number; scale: { x: number; y: number }; anchor: { x: number }; alpha: number };
  /** A sprite's [back, front] along +x (Texture.WHITE is 1 px: scale = length). */
  const span = (s: S): [number, number] => [s.x - s.anchor.x * s.scale.x, s.x + (1 - s.anchor.x) * s.scale.x];

  it('the head is a ~1 km streak ending at the slug, with trail streaks behind it', () => {
    const p = new FxProjectiles(fakeArt(), () => 'high', () => 0);
    p.beginFrame(); p.draw('s', 'slug', 30_000, 0, 6_450, 0, 1, 5, 30_000); p.endFrame();
    const kids = p.container.children as unknown as S[];
    const [back, front] = span(kids[0]!);
    expect(front).toBeCloseTo(30_000, 6);
    expect(front - back, '200 × its size: ~1 km').toBeCloseTo(1_000, 6);
    const trails = kids.slice(2).filter((c) => c.visible && c.alpha > 0.01);
    expect(trails.length, 'three trail streaks').toBe(3);
    for (const t of trails) expect(span(t)[1]).toBeLessThan(30_000);
  });

  it('just out of the barrel the streak is no longer than the distance flown', () => {
    const p = new FxProjectiles(fakeArt(), () => 'high', () => 0);
    p.beginFrame(); p.draw('s', 'slug', 300, 0, 6_450, 0, 1, 5, 300); p.endFrame();
    const [back, front] = span(p.container.children[0] as unknown as S);
    expect(front).toBeCloseTo(300, 6);
    expect(back).toBeGreaterThanOrEqual(-1e-6);
  });
});
