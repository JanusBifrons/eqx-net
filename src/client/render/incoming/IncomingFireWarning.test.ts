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

  // Shells as events slice 2a (docs/architecture/shell-events.md §6). The
  // owner saw the countdown reset per shell: each shell of a salvo is first
  // seen on a different snapshot and arrives a little after the one before,
  // so when the first one passes, the group's "soonest arrival" jumps to the
  // next shell and the number goes UP. With the salvo known (shell_salvo:
  // `mirror.shellSalvos`), the marker counts down to the salvo's first shell
  // and then reads "now" until the salvo has passed: it never goes up.
  it('a 9-shell salvo whose shells are first seen on different snapshots: the countdown never goes up', () => {
    const cam = fakeCamera();
    const warn = new IncomingFireWarning();
    warn.init(cam);
    const m = mirrorWith([]);
    const salvos = new Map<string, { s: number; t: number; n: number; x0: number; y0: number }>();
    (m as unknown as { shellSalvos: typeof salvos }).shellSalvos = salvos;
    // Shell k starts 0.15k s of flight further back on the same line, so it
    // arrives 0.15k s after shell 0 (1.2 s across the salvo, one marker).
    const start = (k: number): number => -D - XL.speed * 0.15 * k;
    for (let k = 0; k < 9; k++) salvos.set(`proj-${k}`, { s: 7, t: 0, n: XL.maxTicks, x0: start(k), y0: 5 * k - 20 });
    const shown: number[] = [];
    const FRAME_MS = 16;
    for (let f = 0; f * FRAME_MS < (HALF_S + 2) * 1000; f++) {
      const ts = (f * FRAME_MS) / 1000;
      m.projectiles!.clear();
      for (let k = 0; k < 9; k++) {
        if (f < 3 * k) continue; // first seen on a later snapshot
        m.projectiles!.set(`proj-${k}`, shell(start(k) + XL.speed * ts, 5 * k - 20, XL.speed, 0));
      }
      warn.update(m, f * FRAME_MS);
      const mk = warn.getDebugMarkers();
      if (mk.length === 0) continue;
      expect(mk).toHaveLength(1); // one salvo, one marker
      shown.push(mk[0]!.label === 'now' ? 0 : Number.parseFloat(mk[0]!.label));
    }
    expect(shown.length).toBeGreaterThan(30);
    for (let i = 1; i < shown.length; i++) {
      expect(shown[i]!, `frame ${i}: ${shown[i - 1]} → ${shown[i]}`).toBeLessThanOrEqual(shown[i - 1]!);
    }
    expect(shown[shown.length - 1]).toBe(0); // "now" while the rest of the salvo passes
  });

  it('a later salvo from the same gun gets its own countdown', () => {
    const cam = fakeCamera();
    const warn = new IncomingFireWarning();
    warn.init(cam);
    // Both just fired (origin = where they are), arriving 0.3 s and 2.6 s out:
    // 2.3 s apart, past the 2 s window that would merge two salvos' markers.
    const a = -XL.speed * 0.3, b = -XL.speed * 2.6;
    expect(2.6).toBeLessThan(XL.maxTicks / 60); // both within flight
    const m = mirrorWith([['proj-1', shell(a, 0, XL.speed, 0)], ['proj-2', shell(b, 0, XL.speed, 0)]]);
    (m as unknown as { shellSalvos: Map<string, unknown> }).shellSalvos = new Map<string, unknown>([
      ['proj-1', { s: 1, t: 0, n: XL.maxTicks, x0: a, y0: 0 }],
      ['proj-2', { s: 2, t: 0, n: XL.maxTicks, x0: b, y0: 0 }],
    ]);
    warn.update(m, 0);
    const labels = warn.getDebugMarkers().map((k) => k.label).sort();
    expect(labels).toEqual([countdownLabel(0.3), countdownLabel(2.6)].sort());
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
