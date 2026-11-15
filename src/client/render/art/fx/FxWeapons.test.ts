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

  // Hostile review 2026-11-15: the wake drew one line from the muzzle to the
  // slug and still crossed the gap ~1 s after the slug passed (a laser, not
  // a projectile). It is a tail behind the slug that disperses quickly.
  it('the wake is a tail: nothing visible more than a head + SLUG_WAKE_TAIL head lengths behind a native-size slug, wherever it is', () => {
    let now = 10_000;
    const p = new FxProjectiles(fakeArt(), () => 'high', () => now);
    // The head (~1.5 frames of travel) plus SLUG_WAKE_TAIL head lengths (~970 u).
    const N = turretFx.slugHeadLength(6_450, 16) * (1 + turretFx.SLUG_WAKE_TAIL);
    const check = (hx: number): void => {
      const vis = p.wakeLayer.children.filter((c) => c.visible) as Sprite[];
      expect(vis.length).toBeGreaterThan(0);
      for (const s of vis) {
        // Heading +x (rotation 0); Texture.WHITE is 1 px, so scale.x = length.
        expect(s.rotation).toBeCloseTo(0);
        expect(s.x - s.scale.x / 2, 'back end within N behind the slug').toBeGreaterThanOrEqual(hx - N - 1e-6);
        expect(s.x + s.scale.x / 2, 'nothing ahead of the slug').toBeLessThanOrEqual(hx + 1e-6);
      }
    };
    p.beginFrame(); p.draw('s', 'slug', 30_000, 0, 6_450, 0, 1, 5, 30_000); p.endFrame();
    check(30_000);
    now += 100;
    p.beginFrame(); p.draw('s', 'slug', 30_645, 0, 6_450, 0, 1, 5, 30_645); p.endFrame();
    check(30_645);
    // The slug hits: the frozen tail stays where it was, never stretches back.
    now += 200;
    p.beginFrame(); p.endFrame();
    check(30_645);
    // Fresh out of the barrel the tail never reaches behind the muzzle.
    p.beginFrame(); p.draw('m', 'slug', 400, 0, 6_450, 0, 1, 5, 400); p.endFrame();
    for (const s of p.wakeLayer.children.filter((c) => c.visible) as Sprite[]) {
      if (Math.abs(s.x - 400) > 1_000) continue; // the other slug's tail
      expect(s.x - s.scale.x / 2).toBeGreaterThanOrEqual(-1e-6);
    }
  });

  it('wake pieces older than 800 ms are gone; younger ones disperse (fade and widen)', () => {
    let now = 10_000;
    const p = new FxProjectiles(fakeArt(), () => 'high', () => now);
    const vis = (): Sprite[] => p.wakeLayer.children.filter((c) => c.visible) as Sprite[];
    p.beginFrame(); p.draw('s', 'slug', 30_000, 0, 6_450, 0, 1, 5, 30_000); p.endFrame();
    const a0 = vis()[0]!.alpha, w0 = vis()[0]!.scale.y;
    now += 250;
    p.beginFrame(); p.endFrame(); // the slug is gone
    expect(vis().length, 'still dispersing at 250 ms').toBeGreaterThan(0);
    expect(vis()[0]!.alpha).toBeLessThan(a0);
    expect(vis()[0]!.scale.y).toBeGreaterThan(w0);
    now += 550; // 800 ms since the slug last passed any of it
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

// Hostile review of rail take 6 (2026-11-15): the slug read as ONE long even
// white-lavender needle (~1 km) with no head, and for its first ~0.3 s its
// back end stayed pinned at the muzzle (a line out of the barrel: a laser).
// It is a compact very bright head, as long as ~1-2 frames of its travel
// (motion blur, with a minimum on-screen size), and a short violet tail that
// starts behind the head and is never anchored to the muzzle.
describe('FxProjectiles: the railgun slug is a slug, not a needle', () => {
  type S = { visible: boolean; x: number; scale: { x: number; y: number }; anchor: { x: number }; rotation: number; alpha: number };
  const SP = 6_450; // u/s, the railgun's real speed
  const FRAME_U = SP / 60; // one 60 fps frame of travel
  /** The head and core sprites of the (only) projectile view. */
  const headOf = (p: FxProjectiles): S => p.container.children[0] as unknown as S;
  /** A sprite's [back, front] along +x (Texture.WHITE is 1 px: scale = length). */
  const span = (s: S): [number, number] => [s.x - s.anchor.x * s.scale.x, s.x + (1 - s.anchor.x) * s.scale.x];

  it('the head is compact: 1-2 frames of travel long, not a kilometre', () => {
    const p = new FxProjectiles(fakeArt(), () => 'high', () => 0);
    p.beginFrame(); p.draw('s', 'slug', 30_000, 0, SP, 0, 1, 5, 30_000); p.endFrame();
    const [back, front] = span(headOf(p));
    expect(front).toBeCloseTo(30_000, 6);
    const len = front - back;
    expect(len, 'at least a frame of travel (reads as motion blur)').toBeGreaterThanOrEqual(FRAME_U);
    expect(len, 'at most two frames of travel').toBeLessThanOrEqual(2 * FRAME_U);
    // Every drawn projectile sprite (head, core, any trail) stays within the head.
    for (const c of p.container.children as unknown as S[]) {
      if (!c.visible || c.alpha <= 0.01) continue;
      const [b, f] = span(c);
      if (c.anchor.x === 0.5 && c.scale.x <= 3 * 16 * 1.01) continue; // a round bloom at the tip
      expect(b, 'nothing white trails behind the head').toBeGreaterThanOrEqual(back - 1e-6);
      expect(f).toBeLessThanOrEqual(30_000 + 1e-6);
    }
  });

  it('the head keeps a minimum on-screen size: never shorter than a few widths', () => {
    const p = new FxProjectiles(fakeArt(), () => 'high', () => 0);
    // Far zoom: the width floor scales the slug ×18 (size 90): the head may
    // not shrink to a dot or a square.
    p.beginFrame(); p.draw('s', 'slug', 300_000, 0, SP, 0, 1, 90, 300_000); p.endFrame();
    const h = headOf(p);
    expect(h.scale.x).toBeGreaterThanOrEqual(4 * h.scale.y);
  });

  it('the tail starts behind the head and is never anchored to the muzzle', () => {
    let now = 10_000;
    const p = new FxProjectiles(fakeArt(), () => 'high', () => now);
    // Muzzle at x = 0; the slug at `flown` along +x, frame by frame.
    for (let f = 1; f <= 20; f++) {
      const flown = f * FRAME_U;
      now = 10_000 + (f * 1000) / 60;
      p.beginFrame(); p.draw('s', 'slug', flown, 0, SP, 0, 1, 5, flown); p.endFrame();
      const [headBack] = span(headOf(p)); // = flown − head length
      const vis = (p.wakeLayer.children as unknown as S[]).filter((c) => c.visible && c.alpha > 0.01);
      let tailBack = Infinity;
      for (const s of vis) {
        const [b, fr] = span(s);
        expect(fr, `frame ${f}: the tail starts behind the head`).toBeLessThanOrEqual(headBack + 1e-6);
        tailBack = Math.min(tailBack, b);
      }
      if (vis.length > 0) {
        // Its back end leaves the muzzle as the slug flies: never pinned there.
        expect(tailBack, `frame ${f}: tail back end off the muzzle`).toBeGreaterThanOrEqual(Math.max(1, 0.4 * headBack));
      }
    }
  });

  it('the tail is short: within a few head lengths behind the head', () => {
    const p = new FxProjectiles(fakeArt(), () => 'high', () => 0);
    p.beginFrame(); p.draw('s', 'slug', 30_000, 0, SP, 0, 1, 5, 30_000); p.endFrame();
    const [headBack, front] = span(headOf(p));
    const hl = front - headBack;
    const vis = (p.wakeLayer.children as unknown as S[]).filter((c) => c.visible && c.alpha > 0.01);
    expect(vis.length).toBeGreaterThan(0);
    for (const s of vis) expect(span(s)[0]).toBeGreaterThanOrEqual(headBack - 8 * hl);
    // ...and fades toward its back end.
    const sorted = [...vis].sort((a, b) => b.x - a.x);
    expect(sorted[0]!.alpha).toBeGreaterThan(sorted[sorted.length - 1]!.alpha);
  });
});
