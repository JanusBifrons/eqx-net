/**
 * Art lab forge (plan soft-leaping-truffle v5, round 1).
 *
 *  - Deterministic: the same kind bakes to the same bytes (art is a function
 *    of the kind id, so every client sees the same ship).
 *  - Silhouette-true: the baked mask matches the collider polygon within one
 *    texel (the forge must never change a silhouette: collider == visual).
 *  - Pixel frames only use colours from the palette ramps + the outline (no
 *    invented in-between colours, which is what makes it read as pixel art).
 */
import { describe, expect, it } from 'vitest';
import { forgeShip, forgeStructure, shipParts } from '../../src/client/__art-lab__/forge/fields';
import { DEFAULT_RIG, litFrame, pixelFrame } from '../../src/client/__art-lab__/forge/shade';
import { insidePoly } from '../../src/client/__art-lab__/forge/raster';
import { getShipKind } from '../../src/shared-types/shipKinds';

const SHIPS = ['fighter', 'heavy', 'missile-frigate', 'trader-hauler', 'havok', 'robot-hexagon'];

function hashBytes(b: Uint8ClampedArray): number {
  let h = 2166136261;
  for (let i = 0; i < b.length; i++) { h ^= b[i]!; h = Math.imul(h, 16777619); }
  return h >>> 0;
}

describe('art lab forge', () => {
  it.each(SHIPS)('%s bakes deterministically', (id) => {
    const a = litFrame(forgeShip(id, { ppu: 3 }), DEFAULT_RIG, 0.7);
    const b = litFrame(forgeShip(id, { ppu: 3 }), DEFAULT_RIG, 0.7);
    expect(hashBytes(a.data)).toBe(hashBytes(b.data));
  });

  it.each(SHIPS)('%s mask matches the collider within 1 texel', (id) => {
    const ppu = 3;
    const f = forgeShip(id, { ppu });
    const parts = shipParts(getShipKind(id));
    const { w, h, ox, oy } = f.g;
    let bad = 0;
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        const covered = f.cov[ty * w + tx]! > 0.5;
        const wx = (tx + 0.5 - ox) / ppu, wy = (ty + 0.5 - oy) / ppu;
        const inside = parts.some((p) => insidePoly(p.pts, wx, wy));
        if (covered === inside) continue;
        // A mismatch is fine only right on the edge: some neighbour within a
        // texel must agree.
        const d = 1 / ppu;
        const near = [[d, 0], [-d, 0], [0, d], [0, -d]].some(([dx, dy]) => parts.some((p) => insidePoly(p.pts, wx + dx!, wy + dy!)) === covered);
        if (!near) bad++;
      }
    }
    expect(bad).toBe(0);
  });

  it('pixel frames use only ramp colours (no blended in-betweens)', () => {
    const f = forgeShip('heavy', { ppu: 4 });
    const fr = pixelFrame(f, DEFAULT_RIG, { pd: 1, steps: 4, dither: 0.3, rotation: 0.4, outline: true });
    const colours = new Set<number>();
    for (let i = 0; i < fr.w * fr.h; i++) {
      const a = fr.data[i * 4 + 3]!;
      expect(a === 0 || a === 255).toBe(true);
      if (a) colours.add((fr.data[i * 4]! << 16) | (fr.data[i * 4 + 1]! << 8) | fr.data[i * 4 + 2]!);
    }
    // A handful of materials × 4 steps + emissives + outline: a small palette.
    expect(colours.size).toBeLessThan(40);
  });

  it('structures bake from the existing draw plans', () => {
    for (const id of ['capital', 'solar', 'turret', 'teleporter']) {
      const f = forgeStructure(id, { ppu: 0.5 });
      let covered = 0;
      for (let i = 0; i < f.cov.length; i++) if (f.cov[i]! > 0.5) covered++;
      expect(covered, id).toBeGreaterThan(f.cov.length * 0.2);
    }
  });
});
