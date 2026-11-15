/**
 * The tractor-emitter turret forge (mining barge). `bake.ts` routes the
 * 'tractor' gun family here; every other family goes to `forgeTurretGun`.
 * Pure.
 */
import { gridFor, rasterPoly } from './raster.js';
import { lin, MAT, newFields, paintOf, PALETTE, setAlbedo, type Fields } from './fieldsCore.js';
import type { TurretGunSpec } from './fields.js';

/**
 * A tractor emitter seen from above (mining barge): a round dish on a
 * turntable — a painted rim, a pale concave bowl with two trim rings, and a
 * glassy emitter boss in the middle. No barrel; it reads as a ring at play
 * zoom, unlike a laser's lens barrel.
 */
export function forgeTractorDish(spec: TurretGunSpec): Fields {
  const cap = spec.cap;
  const poly: Array<readonly [number, number]> = [];
  for (let k = 0; k < 32; k++) { const a = (k / 32) * Math.PI * 2; poly.push([Math.cos(a) * cap, Math.sin(a) * cap]); }
  const g = gridFor([poly], spec.ppu, 1.5);
  const f = newFields(g, paintOf(spec.paint));
  const c = rasterPoly(g, poly);
  for (let i = 0; i < c.length; i++) f.cov[i] = c[i]!;
  const paint = lin(f.paint), worn = lin(PALETTE.metalWorn), trim = lin(PALETTE.trim), glass = lin(PALETTE.glass);
  const H = cap * 0.5;
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! <= 0) continue;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const k = Math.hypot(wx, wy) / cap;
      let h: number, mat: number, col, key: number;
      if (k > 0.8) { h = H * (1 - (k - 0.8) * 1.5); mat = MAT.PAINT; col = paint; key = f.paint; }
      else if (k < 0.2) { h = H * 0.9 * Math.sqrt(1 - (k / 0.2) ** 2) + H * 0.2; mat = MAT.GLASS; col = glass; key = PALETTE.glass; }
      else { h = H * (0.15 + 0.6 * k); mat = MAT.METAL; col = worn; key = PALETTE.metal; }
      if (Math.abs(k - 0.8) < 0.035 || Math.abs(k - 0.5) < 0.03) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h -= H * 0.06; }
      f.height[i] = h; f.mat[i] = mat; f.key[i] = key;
      setAlbedo(f, i, col);
    }
  }
  return f;
}

