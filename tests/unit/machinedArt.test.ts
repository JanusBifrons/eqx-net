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
import { forgeShip, forgeStructure, shipParts } from '../../src/client/render/art/fields';
import { DEFAULT_RIG, litFrame } from '../../src/client/render/art/shade';
import { pixelFrame } from '../../src/client/__art-lab__/pixel';
import { insidePoly } from '../../src/client/render/art/raster';
import { getShipKind } from '../../src/shared-types/shipKinds';
import { AT_AUTHORED_SHIP_SCALE } from '../../src/shared-types/shipScale/config.js';

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

  // Lab-only pixel look, locked at the authored 1× sizes.
  it.runIf(AT_AUTHORED_SHIP_SCALE)('pixel frames use only ramp colours (no blended in-betweens)', () => {
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

describe('art lab bake (round 2 speedups)', () => {
  it('the sliding-window box blur matches a naive blur', async () => {
    const { boxBlur } = await import('../../src/client/render/art/raster');
    const w = 23, h = 17, r = 3;
    const src = new Float32Array(w * h).map((_, i) => ((i * 2654435761) >>> 0) / 4294967296);
    const got = boxBlur(src, w, h, r);
    const at = (a: Float32Array, x: number, y: number): number => a[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let k = -r; k <= r; k++) s += at(src, x + k, y); tmp[y * w + x] = s / (2 * r + 1); }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let k = -r; k <= r; k++) s += at(tmp, x, y + k);
      expect(got[y * w + x]!).toBeCloseTo(s / (2 * r + 1), 4);
    }
  });

  it('seed variants stay within the shared set', async () => {
    const { seedVariant, STRUCT_SEED_VARIANTS } = await import('../../src/client/render/art/bake');
    const seen = new Set<number>();
    for (let s = -20; s < 200; s++) seen.add(seedVariant(s));
    expect(seen.size).toBe(STRUCT_SEED_VARIANTS);
    for (const v of seen) expect(v >= 1 && v <= STRUCT_SEED_VARIANTS).toBe(true);
  });

  it('a structure bake is deterministic and capped in size', async () => {
    const { runBake, STRUCT_MAX_SIDE } = await import('../../src/client/render/art/bake');
    const job = { type: 'struct' as const, id: 'teleporter_large', seed: 1 };
    const a = runBake(job, DEFAULT_RIG), b = runBake(job, DEFAULT_RIG);
    expect(Math.max(a.w, a.h)).toBeLessThanOrEqual(STRUCT_MAX_SIDE + 2);
    expect(hashBytes(a.frames[0]!.data)).toBe(hashBytes(b.frames[0]!.data));
    expect(a.frames[1]!.w).toBe(Math.ceil(a.w / 2)); // half-res light overlay
  });
});

// Bake hash at the authored 1× sizes (a 2× bake differs by design).
describe.runIf(AT_AUTHORED_SHIP_SCALE)('FORGE_VERSION lock', () => {
  // Baked art is cached on players' devices under FORGE_VERSION. If the forge's
  // output changes but the version does not, players keep seeing the OLD art.
  // When this fails: bump FORGE_VERSION in src/client/render/art/bakeStore.ts
  // AND update the recorded hash below, in the same change.
  it('reference bakes match the hash recorded for this FORGE_VERSION', async () => {
    const { runBake } = await import('../../src/client/render/art/bake');
    const { FORGE_VERSION } = await import('../../src/client/render/art/bakeStore');
    let h = 2166136261;
    for (const j of [{ type: 'ship' as const, id: 'fighter' }, { type: 'ship' as const, id: 'havok' }, { type: 'struct' as const, id: 'turret', seed: 1 }]) {
      for (const f of runBake(j, DEFAULT_RIG).frames) for (let i = 0; i < f.data.length; i++) { h ^= f.data[i]!; h = Math.imul(h, 16777619); }
    }
    expect({ version: FORGE_VERSION, hash: (h >>> 0).toString(16) }).toEqual({ version: 'r2.4', hash: '49b83b2b' });
  });
});

describe('A4 recipes: scrap and asteroids keep their collider shapes', () => {
  const maskMismatch = (cov: Float32Array, g: { w: number; h: number; ppu: number; ox: number; oy: number }, inside: (x: number, y: number) => boolean): number => {
    let bad = 0;
    for (let ty = 0; ty < g.h; ty++) for (let tx = 0; tx < g.w; tx++) {
      const covered = cov[ty * g.w + tx]! > 0.5;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      if (covered === inside(wx, wy)) continue;
      const d = 1 / g.ppu;
      if (![[d, 0], [-d, 0], [0, d], [0, -d]].some(([dx, dy]) => inside(wx + dx!, wy + dy!) === covered)) bad++;
    }
    return bad;
  };

  it('a scrap piece matches its component outline within one texel', async () => {
    const { forgeScrap } = await import('../../src/client/render/art/fields');
    const { shipScrapGroups } = await import('../../src/core/geometry/shipScrapGroups');
    const { shipShapeScale } = await import('../../src/core/geometry/shipHullOutline');
    const groups = shipScrapGroups('havok');
    expect(groups.length).toBeGreaterThan(0);
    const scale = shipShapeScale(getShipKind('havok'));
    for (let c = 0; c < groups.length; c++) {
      const f = forgeScrap('havok', c, { ppu: 3 });
      const polys = groups[c]!.parts.map((p) => p.points.map(([x, y]) => [x * scale, y * scale] as const));
      expect(maskMismatch(f.cov, f.g, (x, y) => polys.some((p) => insidePoly(p, x, y))), `component ${c}`).toBe(0);
      expect(f.navLights).toHaveLength(0); // a dead piece has no running lights
      expect(f.nozzles).toHaveLength(0);
    }
  });

  it('an asteroid matches the seeded outline the server uses, and bakes the same each time', async () => {
    const { forgeRock } = await import('../../src/client/render/art/fields');
    const { generateAsteroidVertices } = await import('../../src/core/swarm/asteroidShape');
    for (const [id, r] of [[7, 40], [123, 90]] as const) {
      const f = forgeRock(id, r, undefined, { ppu: 1.5 });
      const outline = generateAsteroidVertices(id, r).map((v) => [v.x, -v.y] as const);
      expect(maskMismatch(f.cov, f.g, (x, y) => insidePoly(outline, x, y))).toBe(0);
    }
    const a = litFrame(forgeRock(9, 60, 'ice', { ppu: 1.5 }), DEFAULT_RIG, 0.4);
    const b = litFrame(forgeRock(9, 60, 'ice', { ppu: 1.5 }), DEFAULT_RIG, 0.4);
    expect(hashBytes(a.data)).toBe(hashBytes(b.data));
  });
});
