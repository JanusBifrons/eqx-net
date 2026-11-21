/**
 * Machined art — the small turret guns (bolt / beam / charge / missile) seen
 * from above, in the house style of the rail turret and the style C structure
 * bases: dark gunmetal, worn bright edges, trim seams, bolts, the owner's
 * paint only as accent panels. Shared by fighters, capitals' small mounts and
 * structure turrets (`forgeTurretGun` routes the non-naval path here).
 *
 * Local space is Pixi-up (forward at -y). Heights are in WORLD units.
 * Footprint contract (muzzle points come from `core/combat/muzzle.ts`): the
 * barrel tip is exactly at -len, the housing stays inside radius `cap`, and
 * the missile launcher keeps its cap × 0.75·cap box.
 */
import { gridFor, hashStr, rasterPoly, type Poly } from './raster.js';
import { lin, MAT, newFields, paintOf, PALETTE, setAlbedo, valueNoise, type Fields } from './fieldsCore.js';
import type { TurretGunSpec } from './turretForge.js';

const GUN = 0x3a4048, GUN_DARK = 0x22262c, BORE = 0x0b0c10;
const COS8 = Math.cos(Math.PI / 8);

/** A barrel section: from v0 to v1 (0 pivot .. 1 tip) at half-width `half`. */
interface Seg { v0: number; v1: number; half: number; part: 'body' | 'shroud' | 'brake' | 'step' | 'lens' | 'coil' | 'tip' }

/** Barrel sections per family. `vh` is where the barrel leaves the housing. */
function barrelSegs(family: TurretGunSpec['family'], hw: number, vh: number, len: number, wid: number): Seg[] {
  const out = 1 - vh;
  const segs: Seg[] = [{ v0: 0, v1: 1, half: hw, part: 'body' }];
  if (family === 'bolt') {
    segs.push({ v0: vh + out * 0.06, v1: 1 - out * 0.32, half: hw * 1.22, part: 'shroud' });
    segs.push({ v0: 1 - out * 0.17, v1: 1, half: hw * 1.45, part: 'brake' });
  } else if (family === 'beam') {
    segs.push({ v0: 1 - out * 0.55, v1: 1 - out * 0.36, half: hw * 1.12, part: 'step' });
    segs.push({ v0: 1 - out * 0.36, v1: 1 - out * 0.18, half: hw * 1.26, part: 'step' });
    segs.push({ v0: 1 - out * 0.18, v1: 1, half: hw * 1.18, part: 'lens' });
  } else if (family === 'charge') {
    const a = vh + out * 0.1, b = 1 - out * 0.2;
    const n = Math.max(2, Math.min(6, Math.round(((b - a) * len) / Math.max(1e-3, wid * 0.8))));
    const pitch = (b - a) / n;
    for (let k = 0; k < n; k++) segs.push({ v0: a + k * pitch + pitch * 0.2, v1: a + k * pitch + pitch * 0.8, half: hw * 1.32, part: 'coil' });
    segs.push({ v0: 1 - out * 0.12, v1: 1, half: hw * 0.95, part: 'tip' });
  }
  return segs;
}

/** The faceted housing: an octagon with flats front, back and sides, its
 *  corners on radius `cap`; returns the distance inside its edge. */
function octDepth(x: number, y: number, a: number): number {
  const s = Math.SQRT1_2;
  return a - Math.max(Math.abs(x), Math.abs(y), Math.abs((x + y) * s), Math.abs((x - y) * s));
}

/** The missile launcher's chamfered box (cap × 0.75·cap). */
function boxDepth(x: number, y: number, cap: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), c = cap * 0.2;
  return Math.min(cap - ax, cap * 0.75 - ay, (cap * 1.75 - c - ax - ay) * Math.SQRT1_2);
}

/** Missile launch-cell centres: a 3 × 2 grid (exported for the tests). */
export function missileCells(cap: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const y of [-0.17, 0.33]) for (const x of [-0.52, 0, 0.52]) out.push([x * cap, y * cap]);
  return out;
}

export function forgeSmallGun(spec: TurretGunSpec): Fields {
  const { family, len, wid, cap, ppu } = spec;
  const hw = wid / 2;
  const rack = family === 'missile';
  const a = cap * COS8 * 0.99; // the octagon's apothem (corners just inside cap)
  const vh = Math.min(0.6, a / Math.max(1e-3, len));
  const segs = rack ? [] : barrelSegs(family, hw, vh, len, wid);
  const housePts: Array<[number, number]> = [];
  for (let k = 0; k < 8; k++) { const t = ((k + 0.5) / 8) * Math.PI * 2; housePts.push([Math.cos(t) * a / COS8, Math.sin(t) * a / COS8]); }
  const housePoly: Poly = housePts;
  const c = cap * 0.2, by = cap * 0.75;
  const rackPoly: Poly = [[-cap + c, -by], [cap - c, -by], [cap, -by + c], [cap, by - c], [cap - c, by], [-cap + c, by], [-cap, by - c], [-cap, -by + c]];
  const segPolys = segs.map((s): Poly => [[-s.half, -len * s.v1], [s.half, -len * s.v1], [s.half, -len * s.v0], [-s.half, -len * s.v0]]);
  const polys = rack ? [rackPoly] : [housePoly, ...segPolys];
  const g = gridFor(polys, ppu, 1.5);
  const f = newFields(g, paintOf(spec.paint));
  // Anti-aliased coverage from the same rasteriser as the hulls.
  for (const poly of polys) { const cv = rasterPoly(g, poly); for (let i = 0; i < cv.length; i++) if (cv[i]! > f.cov[i]!) f.cov[i] = cv[i]!; }
  const paint = lin(f.paint), gun = lin(GUN), gunDark = lin(GUN_DARK), worn = lin(PALETTE.metalWorn), trim = lin(PALETTE.trim), glass = lin(PALETTE.glass), bore = lin(BORE);
  const capH = cap * 0.55;
  const seed = hashStr('turret:' + family);
  const px = 1 / ppu;
  const groove = Math.max(cap * 0.035, 0.5 * px), edgeW = Math.max(cap * 0.05, 0.6 * px);
  const bevel = (rack ? 0.12 : 0.18) * cap;
  const mw = Math.min(Math.max(hw * 1.7, a * 0.25), a * 0.45);
  const boltR = Math.max(cap * 0.05, 0.55 * px);
  const bolts: Array<[number, number]> = rack
    ? [[-cap * 0.78, by * 0.82], [cap * 0.78, by * 0.82], [-cap * 0.78, -by * 0.82], [cap * 0.78, -by * 0.82]]
    : [[-a * 0.5, -a * 0.5], [a * 0.5, -a * 0.5], [-a * 0.5, a * 0.5], [a * 0.5, a * 0.5]];
  const cells = rack ? missileCells(cap) : [];
  const sleeve = cap * 0.21, mouth = Math.min(sleeve * 0.8, Math.max(cap * 0.13, 0.55 * px));
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! <= 0) continue;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const nz = valueNoise(wx * 0.6, wy * 0.6, seed);
      let h = -1, mat: number = MAT.NONE, col = gun, kk = 0.94 + 0.1 * nz, key = PALETTE.metal;
      const d = rack ? boxDepth(wx, wy, cap) : octDepth(wx, wy, a);
      if (d >= 0) {
        // Armour plate: a flat crown with a chamfered bevel to the edge.
        h = capH * (0.8 + 0.2 * Math.min(1, d / bevel)); mat = MAT.METAL;
        if (d < edgeW) { col = worn; kk = 0.8 + 0.08 * nz; }
        else if (Math.abs(d - bevel) < groove) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h -= capH * 0.04; }
        else if (d > bevel) {
          if (rack) {
            // Hazard band across the front edge: paint and dark diagonals.
            if (wy < -by + cap * 0.24) {
              if ((((wx + wy) / (cap * 0.22)) % 1 + 1) % 1 < 0.5) { mat = MAT.PAINT; col = paint; key = f.paint; } else col = gunDark;
            } else if (Math.abs(wy - cap * 0.08) < groove) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h -= capH * 0.04; }
            // Launch cells: dark round mouths in worn square sleeves.
            for (const [cx, cy] of cells) {
              const ex = Math.abs(wx - cx), ey = Math.abs(wy - cy);
              if (Math.max(ex, ey) > sleeve) continue;
              if (Math.hypot(ex, ey) < mouth) { mat = MAT.NOZZLE; col = bore; key = PALETTE.nozzle; h = capH * 0.4; kk = 1; }
              else { mat = MAT.METAL; key = PALETTE.metal; h = capH * 1.04; col = Math.max(ex, ey) > sleeve - edgeW ? worn : gunDark; }
            }
          } else {
            // Paint accent panels on the flanks, a hatch at the rear.
            if (Math.abs(wx) > a * 0.42 && Math.abs(wy) < a * 0.36) { mat = MAT.PAINT; col = paint; key = f.paint; kk = 0.92 + 0.1 * nz; }
            if (Math.abs(wx) < a * 0.22 && wy > a * 0.36 && wy < a * 0.7) {
              const rim = Math.min(a * 0.22 - Math.abs(wx), wy - a * 0.36, a * 0.7 - wy) < groove;
              col = rim ? trim : gunDark; key = rim ? PALETTE.trim : PALETTE.metal; mat = rim ? MAT.TRIM : MAT.METAL; h = capH * 0.97;
            }
            // Mantlet: the armoured block the barrel leaves through.
            if (wy < -a * 0.3 && Math.abs(wx) < mw) {
              mat = MAT.METAL; key = PALETTE.metal; col = gun; h = capH * 0.9;
              if (mw - Math.abs(wx) < groove || wy > -a * 0.3 - groove) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h = capH * 0.84; }
              else if (d < bevel + edgeW * 1.5) col = worn;
            }
          }
          for (const [bx, bY] of bolts) if (Math.hypot(wx - bx, wy - bY) < boltR) { mat = MAT.METAL; col = worn; key = PALETTE.metal; h += capH * 0.04; }
        }
      }
      // Barrel, drawn only where it rises above what is under it; its top
      // stays under the housing's crown, so the housing shades the barrel,
      // never the reverse (user, 2026-11-08).
      if (!rack && wy <= 0 && wy >= -len) {
        const v = -wy / len;
        let seg: Seg | null = null;
        for (const s of segs) if (v >= s.v0 && v <= s.v1 && Math.abs(wx) <= s.half) seg = s;
        if (seg) {
          const half = seg.half, u = wx / half, cyl = Math.sqrt(Math.max(0, 1 - u * u));
          const lift = seg.part === 'coil' || seg.part === 'brake' ? 0.66 : seg.part === 'shroud' || seg.part === 'step' ? 0.64 : 0.6;
          const bh = Math.max(0.05, capH * lift - half * (1 - cyl));
          if (bh > h) {
            h = bh; mat = MAT.METAL; col = gun; key = PALETTE.metal; kk = 0.95 + 0.08 * nz;
            const sv = (v - seg.v0) * len, ev = (seg.v1 - v) * len, ring = Math.max(hw * 0.25, 0.6 * px);
            if (Math.abs(u) > 0.82) col = gunDark;
            if (seg.part === 'body' && Math.abs(((v * len) % (wid * 1.6)) - wid * 0.8) < groove) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h -= 0.08 * half; }
            if (seg.part === 'shroud') {
              // Cooling slots across the shroud, worn bands at both ends.
              if (sv < ring || ev < ring) col = worn;
              else if (((v * len) / Math.max(hw * 0.9, 1.6 * px)) % 1 < 0.45 && Math.abs(u) < 0.7) { mat = MAT.NOZZLE; col = gunDark; key = PALETTE.nozzle; h -= half * 0.25; }
            }
            if (seg.part === 'brake') {
              col = worn; kk = 0.82;
              if (Math.abs(u) > 0.55 && Math.abs(sv - (seg.v1 - seg.v0) * len * 0.45) < ring * 0.7) { mat = MAT.NOZZLE; col = bore; key = PALETTE.nozzle; h -= half * 0.3; }
              if (ev < ring * 1.2 && Math.abs(u) < 0.55) { mat = MAT.NOZZLE; col = bore; key = PALETTE.nozzle; h -= half * 0.6; }
            }
            if (seg.part === 'step' && sv < ring) col = worn;
            if (seg.part === 'lens') {
              if (sv < ring) col = worn;
              else if (Math.abs(u) < 0.78) { mat = MAT.GLASS; col = glass; key = PALETTE.glass; }
            }
            if (seg.part === 'coil') {
              if (sv < ring * 0.6 || ev < ring * 0.6) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; } else col = worn;
            }
            if (seg.part === 'tip') { mat = MAT.GLASS; col = glass; key = PALETTE.glass; }
          }
        }
      }
      if (h < 0) continue;
      f.height[i] = h; f.mat[i] = mat; f.key[i] = key;
      setAlbedo(f, i, col, kk);
    }
  }
  return f;
}
