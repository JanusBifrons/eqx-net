/**
 * Edge radar, ships (RTS Part A owner decision): a ship an AI pilot flies shows
 * like any ship. There is no separate hidden-by-default category for it any
 * more; your own fleet draws in the own colour, anyone else's ship (pilot- or
 * AI-flown) in the player colour.
 */
import { describe, expect, it, vi } from 'vitest';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Camera } from './worker/Camera';
import { DEFAULT_RADAR_PREFS, OWN_SHIP_COLOUR, RadarPrefsSchema, RADAR_CATEGORIES } from '../../shared-types/settings/radar.js';

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

const { HaloRadar } = await import('./HaloRadar.js');
const { Container } = await import('pixi.js');

const W = 1280, H = 720;
function fakeCamera(scale = 1): Camera {
  return {
    parent: new Container(),
    scale: { x: scale, y: scale },
    screenWidth: W,
    screenHeight: H,
    toScreenInto(wx: number, wy: number, out: { x: number; y: number }) { out.x = W / 2 + wx * scale; out.y = H / 2 + wy * scale; },
    centerInto(out: { x: number; y: number }) { out.x = 0; out.y = 0; return out; },
  } as unknown as Camera;
}

const ship = (x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({ x, y, vx: 0, vy: 0, angle: 0, kind: 'fighter', ...extra });

function mirror(): RenderMirror {
  return {
    localPlayerId: 'me',
    ships: new Map([
      ['me', ship(0, 0)],
      // Another player's pilot-flown ship (east).
      ['them', ship(3000, 0)],
      // Another player's AI-flown ship (west).
      ['their-hull', ship(-3000, 0, { ownerPlayerId: 'them', isActive: false })],
      // My own AI-flown ship (north).
      ['my-hull', ship(0, 2000, { ownerPlayerId: 'me', isActive: false })],
    ]),
    swarm: new Map(),
    projectiles: new Map(),
  } as unknown as RenderMirror;
}

describe('HaloRadar ships (RTS Part A)', () => {
  it('every ship is a player contact; your fleet in the own colour, others in the player colour', () => {
    const halo = new HaloRadar(false);
    halo.init(fakeCamera());
    halo.update(mirror());
    const icons = halo.getDebugIcons();
    const byKey = new Map(icons.map((i) => [i.key, i]));
    const player = DEFAULT_RADAR_PREFS.desktop.categories.player.color;
    expect(byKey.get('ship:them')?.color).toBe(player);
    expect(byKey.get('ship:their-hull')?.color).toBe(player);
    expect(byKey.get('ship:their-hull')?.cat).toBe('player');
    expect(byKey.get('ship:my-hull')?.color).toBe(OWN_SHIP_COLOUR);
    expect(icons.every((i) => i.cat === 'player')).toBe(true);
  });

  it('the retired lingering category is gone; an old saved pref carrying it still parses', () => {
    expect(RADAR_CATEGORIES as readonly string[]).not.toContain('lingering');
    const old = structuredClone(DEFAULT_RADAR_PREFS.desktop) as unknown as { categories: Record<string, unknown> };
    old.categories['lingering'] = { enabled: false, shape: 'triangle', color: 0x6b9b7b, sizeMul: 0.9, opacityMul: 0.7 };
    const parsed = RadarPrefsSchema.safeParse(old);
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'lingering' in parsed.data.categories).toBe(false);
  });
});
