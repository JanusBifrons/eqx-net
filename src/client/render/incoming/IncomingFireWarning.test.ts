/**
 * Incoming-fire warning, renderer side: a naval shell on course for the
 * local ship gets a fall-point marker (and, its shells being off screen, the
 * edge radar's incoming chevron); one passing far away gets neither. Plus the
 * far-shell minimum on-screen size in the projectile updater.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ProjectileRenderState, RenderMirror } from '@core/contracts/IRenderer';
import type { Camera } from '../worker/Camera';

vi.mock('pixi.js', () => {
  class FakeContainer {
    x = 0; y = 0; rotation = 0; alpha = 1; visible = true; eventMode = 'auto';
    parent: FakeContainer | null = null;
    children: FakeContainer[] = [];
    scale = { x: 1, y: 1, set(v: number, w?: number): void { this.x = v; this.y = w ?? v; } };
    addChild(...cs: FakeContainer[]): FakeContainer { for (const c of cs) { c.parent = this; this.children.push(c); } return cs[0]!; }
    removeChild(c: FakeContainer): void { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
    destroy(): void { /* noop */ }
  }
  class FakeGraphics extends FakeContainer {}
  for (const m of ['clear', 'circle', 'fill', 'stroke', 'moveTo', 'lineTo', 'closePath', 'rect', 'poly', 'roundRect']) {
    (FakeGraphics.prototype as unknown as Record<string, unknown>)[m] = function (this: unknown) { return this; };
  }
  class FakeText extends FakeContainer {
    text: string;
    anchor = { set(): void { /* noop */ } };
    constructor(o: { text: string }) { super(); this.text = o.text; }
  }
  class FakeTextStyle { constructor(public o: unknown) {} }
  class FakeSprite extends FakeContainer {}
  return { Container: FakeContainer, Graphics: FakeGraphics, Text: FakeText, TextStyle: FakeTextStyle, Sprite: FakeSprite, Texture: { EMPTY: {} } };
});

const { IncomingFireWarning } = await import('./IncomingFireWarning.js');
const { HaloRadar } = await import('../HaloRadar.js');
const { Container } = await import('pixi.js');
const { updateProjectileSprites } = await import('../pixi/projectileSpriteUpdater.js');

const W = 1280, H = 720;
const { getWeapon } = await import('@core/combat/WeaponCatalogue');
const { countdownLabel } = await import('./incomingFire.js');
const XL = getWeapon('naval_xl') as { speed: number; maxTicks: number };
/** Half the 16" shell's flight under the current range profile, in s and u. */
const HALF_S = XL.maxTicks / 120;
const D = XL.speed * HALF_S;
/** A fighter's widest view: 12.8k × 7.2k u at scale 0.1, centred on (0, 0). */
function fakeCamera(scale = 0.1): Camera {
  const stage = new Container();
  return {
    parent: stage,
    scale: { x: scale, y: scale },
    screenWidth: W,
    screenHeight: H,
    toScreenInto(wx: number, wy: number, out: { x: number; y: number }) { out.x = W / 2 + wx * scale; out.y = H / 2 + wy * scale; },
    centerInto(out: { x: number; y: number }) { out.x = 0; out.y = 0; return out; },
  } as unknown as Camera;
}

function mirrorWith(shells: Array<[string, ProjectileRenderState]>): RenderMirror {
  return {
    localPlayerId: 'me',
    ships: new Map([['me', { x: 0, y: 0, vx: 0, vy: 0, angle: 0, kind: 'fighter' }]]),
    swarm: new Map(),
    projectiles: new Map(shells),
  } as unknown as RenderMirror;
}

const shell = (x: number, y: number, vx: number, vy: number): ProjectileRenderState =>
  ({ x, y, vx, vy, ownerId: 'swarm-9', weaponId: 'naval_xl' });

describe('IncomingFireWarning', () => {
  it('marks a shell on course with a countdown, and the radar points at it off screen', () => {
    const cam = fakeCamera(0.5);
    const warn = new IncomingFireWarning();
    warn.init(cam);
    const halo = new HaloRadar(false);
    halo.init(cam);
    halo.setIncoming(warn);
    // 16" shell half its flight west, flying straight at the fighter; zoomed in so the gun is off screen.
    const m = mirrorWith([['p1', shell(-D, 0, XL.speed, 0)]]);
    warn.update(m, 0);
    halo.update(m);
    const markers = warn.getDebugMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]!.label).toBe(countdownLabel(HALF_S));
    // The fall point is the ship's own position (screen centre).
    expect(markers[0]!.x).toBeCloseTo(W / 2, 3);
    expect(markers[0]!.y).toBeCloseTo(H / 2, 3);
    const chev = halo.getDebugIncoming();
    expect(chev).not.toBeNull();
    expect(chev!.label).toBe(countdownLabel(HALF_S));
    expect(chev!.x).toBeLessThan(W / 4); // on the left (west) edge
  });

  it('draws nothing for a shell passing far away, or for the pilot\'s own shot', () => {
    const cam = fakeCamera();
    const warn = new IncomingFireWarning();
    warn.init(cam);
    const halo = new HaloRadar(false);
    halo.init(cam);
    halo.setIncoming(warn);
    const own: ProjectileRenderState = { ...shell(-D, 0, XL.speed, 0), ownerId: 'me' };
    const m = mirrorWith([['far', shell(-D, D / 2, XL.speed, 0)], ['own', own]]);
    warn.update(m, 0);
    halo.update(m);
    expect(warn.markerCount()).toBe(0);
    expect(halo.getDebugIncoming()).toBeNull();
  });

  it('groups a 3-gun salvo into one marker and clears it when the shells are gone', () => {
    const cam = fakeCamera();
    const warn = new IncomingFireWarning();
    warn.init(cam);
    const m = mirrorWith([
      ['a', shell(-D, 10, XL.speed, 0)],
      ['b', shell(-D, -15, XL.speed, 0)],
      ['c', shell(-D - 100, 0, XL.speed, 0)],
    ]);
    warn.update(m, 0);
    const markers = warn.getDebugMarkers();
    expect(markers).toHaveLength(1);
    expect(markers[0]!.count).toBe(3);
    m.projectiles!.clear();
    warn.update(m, 16);
    expect(warn.markerCount()).toBe(0);
  });

  it('does not warn about a shell that will run out of flight first', () => {
    const cam = fakeCamera();
    const warn = new IncomingFireWarning();
    warn.init(cam);
    // naval_s: 60+ ticks of flight at ~1800 u/s reaches a few km, not 30.
    const m = mirrorWith([['s', { x: -30_000, y: 0, vx: 1800, vy: 0, ownerId: 'swarm-9', weaponId: 'naval_s' }]]);
    warn.update(m, 0);
    expect(warn.markerCount()).toBe(0);
  });
});

describe('projectile updater — far naval shells keep a minimum on-screen size', () => {
  it('scales the classic shell dot up at a wide zoom, and leaves it alone close in', () => {
    const shipContainer = new Container();
    const sprites = new Map();
    const ctx = { shipContainer, projectileSprites: sprites, projSeenScratch: new Set<string>(), cameraScale: 0.03 };
    const m = mirrorWith([['p', shell(-5_000, 0, XL.speed, 0)]]);
    updateProjectileSprites(m, ctx as never);
    const g = sprites.get('p') as { scale: { x: number } };
    // 8 u dot × 0.03 px/u = 0.24 px → scaled to 3 px.
    expect(8 * 0.03 * g.scale.x).toBeCloseTo(3, 6);
    ctx.cameraScale = 1;
    updateProjectileSprites(m, ctx as never);
    expect(g.scale.x).toBe(1);
  });
});
