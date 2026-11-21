/**
 * Machined art — the naval gunhouse (capital main / secondary turrets, quad
 * AA, coastal defence guns), in the house style of the rail turret and the
 * style C structure bases: dark gunmetal armour with worn bright edges, trim
 * seams and bolts, the owner's paint only as an accent band across the roof.
 *
 * Local space is Pixi-up (forward at -y). Heights are in WORLD units.
 */
import { gridFor, hashStr, rasterPoly, type Poly } from './raster.js';
import { NAVAL_BARREL_SPAN } from '../../../core/combat/muzzle.js';
import { lin, MAT, newFields, paintOf, PALETTE, setAlbedo, valueNoise, type Fields } from './fieldsCore.js';
import type { TurretGunSpec } from './turretForge.js';

/** Barrel half-width as a fraction of the full half-width, by run along the
 *  barrel (v: 0 at the gunhouse face .. 1 at the muzzle): blast-bag collar,
 *  a thick inner jacket, the chase, then the muzzle ring. Each step is also a
 *  coverage rect, so the silhouette tapers too. */
const BARREL_STEPS: ReadonlyArray<readonly [v0: number, v1: number, k: number]> = [
  [0, 0.08, 1], [0.08, 0.42, 0.84], [0.42, 0.93, 0.7], [0.93, 1, 0.8],
];
function barrelHalf(v: number, bw: number): number {
  for (const [v0, v1, k] of BARREL_STEPS) if (v >= v0 && v <= v1) return bw * k;
  return bw * 0.7;
}

/** Distance from a point to segment a-b. */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - dx * t, py - ay - dy * t);
}

/**
 * A naval turret seen from above: a faceted dark gunmetal gunhouse (angled
 * armoured face, flat sides, cut rear corners) with a bolted sloped glacis
 * band at the front, raised roof plates on dark seams, the owner's paint as
 * a band across the roof, side vent grilles, a commander's cupola and a rear
 * hatch; rangefinder hoods at the rear on big houses. N parallel gunmetal
 * barrels step down from a blast-bag collar through a worn jacket band to a
 * bright muzzle ring and a dark bore. Small houses (AA, 5 in) drop the fine
 * detail. Forward is −y, like `forgeTurretGun`.
 */
export function forgeNavalTurret(spec: TurretGunSpec): Fields {
  const nv = spec.naval!;
  const W = nv.houseW, L = nv.houseL, hw = W / 2, hl = L / 2, bw = spec.wid / 2, len = spec.len;
  const face = hl * 0.42; // depth of the angled front faces
  const housePoly: Poly = [
    [-hw * 0.62, -hl], [hw * 0.62, -hl], [hw, -hl + face], [hw, hl * 0.7],
    [hw * 0.82, hl], [-hw * 0.82, hl], [-hw, hl * 0.7], [-hw, -hl + face],
  ];
  const n = Math.max(1, nv.barrels);
  const pitch = n > 1 ? (W * NAVAL_BARREL_SPAN) / (n - 1) : 0;
  const xs: number[] = [];
  if (nv.part === 'barrel') xs.push(0);
  else if (nv.part !== 'house') for (let k = 0; k < n; k++) xs.push((k - (n - 1) / 2) * pitch);
  // Each barrel is a stack of rects (the stepped taper); the collar reaches
  // 0.5 into the house as before, the last step ends at the tip -hl-len.
  const barrelPolys: Poly[] = [];
  for (const x of xs) {
    for (const [v0, v1, k] of BARREL_STEPS) {
      const y0 = v0 === 0 ? -hl + 0.5 : -hl - len * v0, y1 = -hl - len * v1, b = bw * k;
      barrelPolys.push([[x - b, y1], [x + b, y1], [x + b, y0], [x - b, y0]]);
    }
  }
  const polys = nv.part === 'barrel' ? barrelPolys : [housePoly, ...barrelPolys];
  const g = gridFor(polys, spec.ppu, 1.5);
  const f = newFields(g, paintOf(spec.paint));
  for (const poly of polys) { const c = rasterPoly(g, poly); for (let i = 0; i < c.length; i++) if (c[i]! > f.cov[i]!) f.cov[i] = c[i]!; }
  const paint = lin(f.paint), gun = lin(0x3a4048), gunDark = lin(0x22262c), worn = lin(PALETTE.metalWorn);
  const trim = lin(PALETTE.trim), bore = lin(0x07080b), glass = lin(PALETTE.glass);
  const Hh = Math.max(1.2, W * 0.18);
  const seed = hashStr('naval:' + n + ':' + Math.round(W));
  const big = W > 12, small = W < 7;
  const line = Math.max(0.15, 0.6 / spec.ppu); // a seam: at least ~half a texel
  const rim = Math.max(small ? 0.18 : 0.25, 0.9 / spec.ppu); // worn bright edge
  const glacisY = -hl + face; // the glacis band ends where the side faces start
  const bandY0 = hl * 0.12, bandY1 = hl * (small ? 0.42 : 0.32); // paint band
  const boltPitch = Math.max(1.2, W * 0.09);
  const cupX = -hw * 0.42, cupY = hl * 0.42, cupR = Math.max(0.6, W * 0.075);
  const hatchX = small ? 0 : hw * 0.3, hatchY = hl * 0.66, hatchR = Math.max(0.45, W * 0.06);
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! <= 0) continue;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const nz = valueNoise(wx * 0.5, wy * 0.5, seed);
      const ax = Math.abs(wx);
      let h = -1, mat: number = MAT.NONE, col = gun, kk = 0.94 + 0.1 * nz, key = PALETTE.metal;
      const inHouse = nv.part !== 'barrel' && wy >= -hl && wy <= hl && ax <= hw;
      if (inHouse) {
        // Distance to the house outline (the faces are angled, so per edge).
        let edge = Infinity;
        for (let k = 0; k < housePoly.length; k++) {
          const a = housePoly[k]!, b = housePoly[(k + 1) % housePoly.length]!;
          edge = Math.min(edge, segDist(wx, wy, a[0], a[1], b[0], b[1]));
        }
        h = Hh * (0.84 + 0.16 * Math.min(1, edge / Math.max(0.5, W * 0.06)));
        mat = MAT.METAL;
        if (wy < glacisY) {
          // Glacis: the armoured front slopes up to the roof, a bolt row on it.
          const s = (wy + hl) / face;
          h = Math.min(h, Hh * (0.8 + 0.18 * s));
          col = gunDark; kk = 0.96 + 0.08 * nz;
          if (!small && Math.abs(wy - (-hl + face * 0.5)) < line * 1.1) {
            const bx = ((wx / boltPitch) % 1 + 1.5) % 1 - 0.5;
            if (Math.abs(bx) * boltPitch < line * 1.1) { col = worn; h += Hh * 0.03; kk = 0.9; }
          }
          if (Math.abs(wy - glacisY) < line) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h -= Hh * 0.04; }
        } else {
          // Roof: raised centre plate between two lengthwise seams, a cross seam.
          if (ax < hw * 0.4) h += Hh * 0.03;
          if (Math.abs(ax - hw * 0.4) < line || Math.abs(wy - hl * 0.02) < line || Math.abs(wy - hl * 0.74) < line) {
            mat = MAT.TRIM; col = gunDark; key = PALETTE.trim; h -= Hh * 0.05;
          } else if (wy > bandY0 && wy < bandY1 && ax < hw * 0.9) {
            // The owner's paint: one accent band across the roof.
            mat = MAT.PAINT; col = paint; key = f.paint; kk = 0.92 + 0.1 * nz;
            if (Math.abs(wy - bandY0) < line * 0.7 || Math.abs(wy - bandY1) < line * 0.7) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; }
          }
          // Plate-corner bolts on the centre plate.
          if (!small && Math.abs(ax - hw * 0.32) < line && (Math.abs(wy - hl * -0.12) < line || Math.abs(wy - hl * 0.6) < line)) { col = worn; key = PALETTE.metal; h += Hh * 0.03; }
          // Side vent grilles: dark slats in a recessed panel.
          if (!small && ax > hw * 0.6 && ax < hw * 0.86 && wy > -hl * 0.12 && wy < hl * 0.08 + (big ? 0 : hl * 0.04)) {
            const slat = ((wy / Math.max(0.35, line * 2)) % 1 + 1) % 1;
            mat = slat < 0.5 ? MAT.NOZZLE : MAT.METAL; col = slat < 0.5 ? bore : gunDark; key = slat < 0.5 ? PALETTE.nozzle : PALETTE.metal; h = Hh * 0.86;
          }
          // Rangefinder hoods at the rear corners (big houses), a lens outboard.
          if (big && wy > hl * 0.3 && wy < hl * 0.66 && ax > hw * 0.7) {
            mat = MAT.METAL; col = gun; key = PALETTE.metal; h = Hh * 1.12;
            if (ax > hw * 0.94 && wy > hl * 0.4 && wy < hl * 0.56) { mat = MAT.GLASS; col = glass; key = PALETTE.glass; h = Hh * 1.05; }
            else if (Math.abs(ax - hw * 0.7) < line * 1.5 || Math.abs(wy - hl * 0.3) < line * 1.5 || Math.abs(wy - hl * 0.66) < line * 1.5) col = worn;
          }
          // Commander's cupola with a periscope slit facing forward.
          const dc = Math.hypot(wx - cupX, wy - cupY);
          if (!small && dc < cupR) {
            mat = MAT.METAL; key = PALETTE.metal; h = Hh * 1.1; col = dc > cupR * 0.75 ? worn : gun;
            if (Math.abs(wx - cupX) < cupR * 0.45 && wy < cupY - cupR * 0.2 && wy > cupY - cupR * 0.55) { mat = MAT.GLASS; col = glass; key = PALETTE.glass; }
          }
          // Rear hatch: worn ring, dark lid.
          const dh = Math.hypot(wx - hatchX, wy - hatchY);
          if (dh < hatchR) { mat = MAT.METAL; key = PALETTE.metal; h = Hh * 0.98; col = dh > hatchR * 0.7 ? worn : gunDark; }
        }
        // Worn bright edge all round the house.
        if (edge < rim && mat !== MAT.GLASS) { mat = MAT.METAL; col = worn; key = PALETTE.metal; kk = 0.8 + 0.1 * nz; }
      }
      // Barrels, over the house where they enter it.
      for (const x of xs) {
        if (wy > -hl + 0.5 || wy < -hl - len) continue;
        const v = Math.max(0, (-hl - wy) / len); // 0 at the face .. 1 at the muzzle
        const half = barrelHalf(v, bw), u = (wx - x) / half;
        if (Math.abs(u) > 1) continue;
        const cyl = Math.sqrt(Math.max(0, 1 - u * u));
        // The barrel's top stays under the gunhouse roof (user, 2026-11-08:
        // the house shades the barrels, never the reverse).
        let bh = Math.max(0.05, Hh * 0.72 - half * (1 - cyl));
        let bc = gun, bm: number = MAT.METAL, bk: number = PALETTE.metal, bkk = 0.95 + 0.08 * nz;
        if (v < 0.08) {
          // Blast bag: dark folded canvas collar at the face.
          bh = Math.min(Hh * 0.76, bh + bw * 0.1);
          bc = Math.abs((((v * len) / Math.max(0.3, bw * 0.5)) % 1) - 0.5) > 0.3 ? gun : gunDark;
        } else if (v > 0.3 && v < 0.38) bc = worn; // worn jacket band
        else if (v > 0.93) { bc = worn; bkk = 0.85; } // muzzle ring
        if (Math.abs(v - 0.42) * len < line * 0.6 || Math.abs(v - 0.08) * len < line * 0.6) { bm = MAT.TRIM; bc = trim; bk = PALETTE.trim; bh -= half * 0.08; }
        if (v > 0.975 && Math.abs(u) < 0.55) { bm = MAT.NOZZLE; bc = bore; bk = PALETTE.nozzle; bh -= half * 0.6; }
        if (bh > h) { h = bh; mat = bm; col = bc; key = bk; kk = bkk; }
      }
      if (h < 0) continue;
      f.height[i] = h; f.mat[i] = mat; f.key[i] = key;
      setAlbedo(f, i, col, kk);
    }
  }
  return f;
}
