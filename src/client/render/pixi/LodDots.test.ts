/**
 * Capital-ship R&D round 3 E1 — screen-size LOD: below `dotPx` on screen a
 * ship or drone becomes a tinted dot and its sprite stops rendering; back
 * above `dotPx × hysteresis` it returns. The tier only flips on a crossing.
 */
import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { LodDots, LOD_DOT_COLORS, LOD_TIERS, isDotTier } from './LodDots.js';
import type { RenderMirror } from '../../../core/contracts/IRenderer.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';

function mirror(): RenderMirror {
  return {
    localPlayerId: 'me',
    ships: new Map([
      ['me', { x: 0, y: 0, angle: 0, kind: 'battleship' }],
      ['p2', { x: 100, y: 0, angle: 0, kind: 'fighter' }],
    ]),
    swarm: new Map([[7, { x: 50, y: 50, angle: 0, radius: 24, kind: 1, shipKind: 'robot-square' }]]),
  } as unknown as RenderMirror;
}

function sprites(): Map<string, Container> {
  const m = new Map<string, Container>();
  for (const k of ['me', 'p2', 'swarm-7']) m.set(k, new Container());
  return m;
}

describe('LOD dots', () => {
  it('thresholds have hysteresis', () => {
    expect(isDotTier(LOD_TIERS.dotPx - 0.1, false)).toBe(true);
    expect(isDotTier(LOD_TIERS.dotPx + 0.1, false)).toBe(false);
    expect(isDotTier(LOD_TIERS.dotPx + 0.1, true)).toBe(true); // still inside the band
    expect(isDotTier(LOD_TIERS.dotPx * LOD_TIERS.hysteresis + 0.1, true)).toBe(false);
  });

  it('at a capital pilot\'s far zoom, fighters and drones are dots and the battleship is not', () => {
    const lod = new LodDots();
    const m = mirror(), s = sprites();
    const scale = 0.03; // the battleship's zoom-out floor ≈ 0.15 / 4.8
    lod.update(m, s, scale);
    expect(2 * getShipKind('fighter').radius * scale).toBeLessThan(LOD_TIERS.dotPx);
    expect(s.get('p2')!.renderable).toBe(false);
    expect(s.get('swarm-7')!.renderable).toBe(false);
    expect(s.get('me')!.renderable).toBe(true);
    expect(lod.dotCount).toBe(2);
    const dots = lod.container.children.filter((c) => c.visible);
    expect(dots.length).toBe(2);
    expect(dots.map((d) => (d as unknown as { tint: number }).tint).sort()).toEqual([LOD_DOT_COLORS.player, LOD_DOT_COLORS.robots].sort());
  });

  it('zooming back in restores the sprites; a departed entity loses its dot', () => {
    const lod = new LodDots();
    const m = mirror(), s = sprites();
    lod.update(m, s, 0.03);
    lod.update(m, s, 1);
    expect(s.get('p2')!.renderable).toBe(true);
    expect(s.get('swarm-7')!.renderable).toBe(true);
    expect(lod.dotCount).toBe(0);
    m.swarm!.delete(7);
    lod.update(m, s, 1);
    expect(lod.container.children.length).toBe(2);
  });
});
