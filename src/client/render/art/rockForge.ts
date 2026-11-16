/**
 * The asteroid forge (moved out of fields.ts to keep it under its size cap):
 * the same seeded outline the server builds its collider from, as a rounded,
 * lumpy body with craters; matte rock, no paint or lights. Pure.
 */
import { generateAsteroidVertices } from '../../../core/swarm/asteroidShape.js';
import { distanceInside, gridFor, hashStr, rasterPoly, rng, type Poly } from './raster.js';
import { lin, MAT, newFields, setAlbedo, valueNoise, type Fields } from './fieldsCore.js';

/** Rock base colours: plain, ice, crystal (the game's asteroid tints). */
export const ROCK_COLORS: Record<string, number> = { rock: 0x77746f, ice: 0x8fb4c8, crystal: 0x8a6fb0 };

/**
 * An asteroid: the same seeded outline the server builds its collider from
 * (`generateAsteroidVertices`, drawn with y flipped like `buildAsteroidGfx`).
 * A rounded, lumpy body with craters; matte rock, no paint or lights.
 */
export function forgeRock(shapeSeed: number, radius: number, resource: string | undefined, opts: { ppu: number }): Fields {
  const outline: Poly = generateAsteroidVertices(shapeSeed, radius).map((v) => [v.x, -v.y] as const);
  const g = gridFor([outline], opts.ppu, 2);
  const base = ROCK_COLORS[resource ?? 'rock'] ?? ROCK_COLORS['rock']!;
  const f = newFields(g, base);
  const n = g.w * g.h;
  const cov = rasterPoly(g, outline);
  for (let i = 0; i < n; i++) f.cov[i] = cov[i]!;
  const dist = distanceInside(f.cov, g.w, g.h);
  let maxD = 0;
  for (let i = 0; i < n; i++) if (dist[i]! > maxD) maxD = dist[i]!;
  const maxDu = Math.max(0.5, maxD / g.ppu);
  const seed = hashStr(`rock:${shapeSeed}`);
  const R = rng(seed);
  // A few craters, each a shallow bowl with a raised rim.
  const craters: Array<{ x: number; y: number; r: number }> = [];
  const nCr = 2 + Math.floor(R() * 4);
  for (let k = 0; k < nCr; k++) {
    const a = R() * Math.PI * 2, d = R() * radius * 0.55;
    craters.push({ x: Math.cos(a) * d, y: Math.sin(a) * d, r: radius * (0.12 + R() * 0.18) });
  }
  const col = lin(base);
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! <= 0) continue;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const t = Math.min(1, dist[i]! / g.ppu / maxDu);
      // Rounded dome, roughened by two octaves of noise.
      let h = maxDu * 0.6 * Math.sqrt(t * (2 - t));
      const nz = valueNoise(wx * 0.12, wy * 0.12, seed) * 0.6 + valueNoise(wx * 0.35, wy * 0.35, seed + 7) * 0.4;
      h += (nz - 0.5) * maxDu * 0.35 * t;
      let shade = 0.85 + 0.3 * nz;
      for (const c of craters) {
        const dd = Math.hypot(wx - c.x, wy - c.y) / c.r;
        if (dd < 1) { h -= (1 - dd * dd) * c.r * 0.35; shade *= 0.82 + 0.18 * dd; }
        else if (dd < 1.3) h += (1.3 - dd) * c.r * 0.25;
      }
      f.height[i] = h;
      f.mat[i] = MAT.ROCK;
      f.key[i] = base;
      setAlbedo(f, i, col, shade);
    }
  }
  return f;
}
