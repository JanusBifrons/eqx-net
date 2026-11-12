/**
 * Far-zoom ship icons (owner decision 2026-11-12, replaces the round-3 E1 LOD
 * dots). A capital pilot zoomed right out (floor ~0.03) saw the 8 parked
 * fighters only as ~3 px yellow squares, invisible on a phone. Now every ship
 * and drone whose true sprite gets small on screen gains a constant-size
 * heading chevron (`FAR_ICON.sizePx`) coloured by relationship, fading in as
 * the sprite shrinks so nothing pops; below `solidPx` the icon is fully opaque
 * and the sprite stops rendering.
 */
import { describe, expect, it } from 'vitest';
import { Container, Sprite } from 'pixi.js';
import {
  FarZoomIcons,
  FAR_ICON,
  farIconAlpha,
  farIconRelation,
  isIconOnly,
  DEFAULT_FAR_ICON_COLOURS,
} from './FarZoomIcons.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { GAMEPLAY_MIN_ZOOM, startZoomForScale } from '../../../shared-types/shipScale/tuning.js';
import { SHIP_SCALE } from '../../../shared-types/shipScale/config.js';

function mirror(): RenderMirror {
  return {
    localPlayerId: 'me',
    ships: new Map([
      ['me', { x: 0, y: 0, angle: 0, kind: 'battleship' }],
      ['p2', { x: 100, y: 0, angle: 0, kind: 'fighter' }],
    ]),
    swarm: new Map([
      [7, { x: 50, y: 50, angle: 0, radius: 24, kind: 1, shipKind: 'robot-square', isHostileToLocal: true }],
      [8, { x: 60, y: 50, angle: 0, radius: 24, kind: 1, shipKind: 'robot-square' }],
      [9, { x: 70, y: 50, angle: 0, radius: 24, kind: 0 }], // asteroid: out of scope
    ]),
  } as unknown as RenderMirror;
}

function sprites(): Map<string, Container> {
  const m = new Map<string, Container>();
  for (const k of ['me', 'p2', 'swarm-7', 'swarm-8', 'swarm-9']) m.set(k, new Container());
  // Posed as the sprite updaters do: (x, -y), rotation -angle.
  m.get('p2')!.position.set(100, 0);
  m.get('swarm-7')!.position.set(50, -50);
  m.get('swarm-8')!.position.set(60, -50);
  m.get('p2')!.rotation = 1.2;
  m.get('swarm-7')!.rotation = -0.7;
  return m;
}

function iconOf(icons: FarZoomIcons, x: number, y: number): Sprite {
  const hit = icons.container.children.find((c) => c.x === x && c.y === y);
  if (!hit) throw new Error(`no icon at ${x},${y}`);
  return hit as Sprite;
}

describe('far-zoom icon decision (pure)', () => {
  it('fades in as the true sprite shrinks: none when big, solid when tiny, linear between', () => {
    expect(farIconAlpha(FAR_ICON.fadeStartPx)).toBe(0);
    expect(farIconAlpha(FAR_ICON.fadeStartPx * 3)).toBe(0);
    expect(farIconAlpha(FAR_ICON.solidPx)).toBe(1);
    expect(farIconAlpha(1)).toBe(1);
    const mid = (FAR_ICON.fadeStartPx + FAR_ICON.solidPx) / 2;
    expect(farIconAlpha(mid)).toBeCloseTo(0.5, 5);
    // Monotone: smaller on screen ⇒ never less visible.
    let prev = -1;
    for (let d = 40; d >= 0; d -= 0.5) {
      const a = farIconAlpha(d);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });

  it('the icon is solid before the sprite is hidden (no pop), with hysteresis on the swap', () => {
    // The sprite is hidden only where the icon already fully covers it.
    for (let d = 0; d < FAR_ICON.solidPx; d += 0.5) {
      if (isIconOnly(d, false)) expect(farIconAlpha(d)).toBe(1);
    }
    expect(isIconOnly(FAR_ICON.solidPx - 0.1, false)).toBe(true);
    expect(isIconOnly(FAR_ICON.solidPx + 0.1, false)).toBe(false);
    expect(isIconOnly(FAR_ICON.solidPx + 0.1, true)).toBe(true); // inside the band
    expect(isIconOnly(FAR_ICON.solidPx * FAR_ICON.hysteresis + 0.1, true)).toBe(false);
    // The icon is a clear marker, roughly 8–12 px.
    expect(FAR_ICON.sizePx).toBeGreaterThanOrEqual(8);
    expect(FAR_ICON.sizePx).toBeLessThanOrEqual(12);
    // The icon is never smaller than the sprite it replaces.
    expect(FAR_ICON.sizePx).toBeGreaterThanOrEqual(FAR_ICON.solidPx);
  });

  // Shipping ship scale (2×) only: at the authored 1× a fighter is half as wide.
  it.runIf(SHIP_SCALE >= 2)('normal play is untouched: at the spawn zoom no small ship gets an icon; at the fighter floor it does', () => {
    const spawnZoom = startZoomForScale(0.5); // PixiRenderer DEFAULT_GAMEPLAY_ZOOM at the ship scale
    for (const id of ['scout', 'fighter']) {
      expect(farIconAlpha(2 * getShipKind(id).radius * spawnZoom)).toBe(0);
      expect(farIconAlpha(2 * getShipKind(id).radius * GAMEPLAY_MIN_ZOOM)).toBeGreaterThan(0);
    }
  });

  it('relationship: you, other pilots (friendly), hostile drones, traders, everything else neutral', () => {
    expect(farIconRelation(true, false, false, undefined)).toBe('self');
    expect(farIconRelation(false, true, false, 'fighter')).toBe('friendly');
    expect(farIconRelation(false, false, true, 'robot-square')).toBe('hostile');
    expect(farIconRelation(false, false, false, 'robot-square')).toBe('neutral');
    expect(farIconRelation(false, false, false, 'trader-hauler')).toBe('trader');
    expect(farIconRelation(false, false, true, 'trader-hauler')).toBe('hostile');
  });
});

describe('FarZoomIcons (renderer)', () => {
  it("at a capital pilot's far zoom, fighters and drones become solid heading icons and the battleship keeps its art", () => {
    const icons = new FarZoomIcons();
    const m = mirror(), s = sprites();
    const scale = 0.03; // the battleship's zoom-out floor ≈ 0.15 / 4.8
    icons.update(m, s, scale);
    expect(2 * getShipKind('fighter').radius * scale).toBeLessThan(FAR_ICON.solidPx);
    expect(s.get('p2')!.renderable).toBe(false);
    expect(s.get('swarm-7')!.renderable).toBe(false);
    expect(s.get('swarm-9')!.renderable).toBe(true); // asteroids keep their art
    expect(s.get('me')!.renderable).toBe(true);
    expect(icons.iconCount).toBe(3);

    const fighter = iconOf(icons, 100, 0);
    const hostile = iconOf(icons, 50, -50);
    const neutral = iconOf(icons, 60, -50);
    expect(fighter.alpha).toBe(1);
    // Points along the ship's heading.
    expect(fighter.rotation).toBeCloseTo(1.2, 6);
    expect(hostile.rotation).toBeCloseTo(-0.7, 6);
    // Constant on-screen size, whatever the zoom.
    expect(fighter.scale.x * fighter.texture.width * scale).toBeCloseTo(FAR_ICON.sizePx, 4);
    expect(fighter.tint).toBe(DEFAULT_FAR_ICON_COLOURS.friendly);
    expect(hostile.tint).toBe(DEFAULT_FAR_ICON_COLOURS.hostile);
    expect(neutral.tint).toBe(DEFAULT_FAR_ICON_COLOURS.neutral);
    // One texture for every icon, so they batch into one draw call.
    const tex = new Set(icons.container.children.map((c) => (c as Sprite).texture.source));
    expect(tex.size).toBe(1);
  });

  it('in the fade band the icon is translucent over the still-drawn sprite', () => {
    const icons = new FarZoomIcons();
    const m = mirror(), s = sprites();
    const r = getShipKind('fighter').radius;
    const midPx = (FAR_ICON.fadeStartPx + FAR_ICON.solidPx) / 2;
    const scale = midPx / (2 * r);
    icons.update(m, s, scale);
    const fighter = iconOf(icons, 100, 0);
    expect(fighter.visible).toBe(true);
    expect(fighter.alpha).toBeCloseTo(0.5, 2);
    expect(s.get('p2')!.renderable).toBe(true);
    expect(fighter.scale.x * fighter.texture.width * scale).toBeCloseTo(FAR_ICON.sizePx, 4);
  });

  it('a hidden sprite (mid warp run) hides its icon too', () => {
    const icons = new FarZoomIcons();
    const m = mirror(), s = sprites();
    s.get('p2')!.visible = false;
    icons.update(m, s, 0.03);
    // Only the two drones' icons show; the warping fighter's stays hidden.
    expect(icons.container.children.filter((c) => c.visible).length).toBe(2);
  });

  it('zooming back in restores the sprites; a departed entity loses its icon', () => {
    const icons = new FarZoomIcons();
    const m = mirror(), s = sprites();
    icons.update(m, s, 0.03);
    icons.update(m, s, 1);
    expect(s.get('p2')!.renderable).toBe(true);
    expect(s.get('swarm-7')!.renderable).toBe(true);
    expect(icons.iconCount).toBe(0);
    expect(icons.container.children.every((c) => !c.visible)).toBe(true);
    const before = icons.container.children.length;
    m.swarm!.delete(7);
    icons.update(m, s, 1);
    expect(icons.container.children.length).toBe(before - 1);
  });

  it('radar colour prefs recolour the icons', () => {
    const icons = new FarZoomIcons();
    icons.setColours({ hostile: 0x112233, friendly: 0x445566, neutral: 0x778899, trader: 0xaabbcc });
    const m = mirror(), s = sprites();
    icons.update(m, s, 0.03);
    expect(iconOf(icons, 50, -50).tint).toBe(0x112233);
    expect(iconOf(icons, 100, 0).tint).toBe(0x445566);
  });
});
