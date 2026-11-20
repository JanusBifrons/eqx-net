/**
 * Machined art — the turning part of a turret (the gun on its cap): small
 * bolt / beam / missile / charge guns, WW2-style naval gunhouses and the
 * rail turret, forged through the same fields as a hull (`fields.ts`
 * re-exports these so callers keep one import).
 *
 * Local space is Pixi-up (forward at -y). Heights are in WORLD units.
 */
import { gridFor, hashStr, rasterPoly, type Poly } from './raster.js';
import { forgeNavalTurret } from './turretForgeNaval.js';
import { railGeom, RAIL_VENTS } from './fx/turretFx.js';
import { forgeSmallGun } from './smallGunForge.js';
import { lin, MAT, newFields, paintOf, PALETTE, setAlbedo, valueNoise, type Fields } from './fieldsCore.js';

export type GunFamily = 'bolt' | 'beam' | 'missile' | 'charge' | 'rail' | 'tractor';

export interface TurretGunSpec {
  family: GunFamily;
  /** Hull paint (the cap is painted to match its ship or structure). */
  paint: number;
  /** Barrel length from the pivot to the tip, width, cap radius (world units). */
  len: number;
  wid: number;
  cap: number;
  ppu: number;
  /** Capital naval turret (capital-ship R&D): a faceted gunhouse centred on
   *  the pivot, `barrels` parallel barrels of `len` from its front face. */
  naval?: NavalTurretSpec;
}

/** Naval turret geometry. `part` bakes the gunhouse alone or ONE barrel
 *  alone (at x 0, same face position), so a quad AA can recoil its barrels
 *  one at a time; absent = the whole turret in one image. */
export interface NavalTurretSpec { barrels: number; houseW: number; houseL: number; part?: 'house' | 'barrel' }

/** Distance from (x, y) to the nearest edge of a pointy-top hex grid of
 *  circumradius `s` (0 on an edge, up to √3/2·s at a cell's centre). */
function hexEdge(x: number, y: number, s: number): number {
  const px = s * 1.7320508, py = s * 3;
  let best = Infinity, bdx = 0, bdy = 0;
  for (let l = 0; l < 2; l++) {
    const ox = l * px * 0.5, oy = l * py * 0.5;
    const cx = Math.round((x - ox) / px) * px + ox, cy = Math.round((y - oy) / py) * py + oy;
    const dx = x - cx, dy = y - cy, d = dx * dx + dy * dy;
    if (d < best) { best = d; bdx = Math.abs(dx); bdy = Math.abs(dy); }
  }
  return s * 0.8660254 - Math.max(bdx, bdx * 0.5 + bdy * 0.8660254);
}

/**
 * The railgun turret seen from above (`railGeom`): a heavy breech of
 * concentric segmented rings, and ONE barrel of two parallel rails with an
 * open slot between them, ending at the shared muzzle (#15). Flared plated
 * shoulders brace the rails where they leave the breech; hex panels plate
 * the shoulders and the rails' outer halves; side vents are cut along each
 * rail's outer face. Dark gunmetal, the outer collar in the hull's paint.
 * The slot is a dark channel: the charge light fills it (chargeTelegraph).
 * Forward is −y, like `forgeTurretGun`.
 */
function forgeRailTurret(spec: TurretGunSpec): Fields {
  const nv = spec.naval!;
  const G = railGeom(nv.houseW, nv.houseL, spec.len, spec.wid);
  const Rb = G.breechR, hs = G.slotW / 2, ro = G.railOuter, rw = G.railW, y0 = G.railY0, my = G.muzzleY;
  const ring: [number, number][] = [];
  for (let k = 0; k < 48; k++) { const a = (k / 48) * Math.PI * 2; ring.push([Math.cos(a) * Rb, Math.sin(a) * Rb]); }
  const tip = rw * 1.2;
  const rails: Poly[] = [1, -1].map((s): Poly => [[s * hs, y0], [s * ro, y0], [s * ro, my + tip], [s * (ro - rw * 0.45), my], [s * hs, my]]);
  const shoulders: Poly[] = [1, -1].map((s): Poly => [[s * ro, -Rb * 0.15], [s * G.shoulderW, -Rb * 0.15], [s * G.shoulderW, -Rb * 0.9], [s * ro, G.shoulderY1]]);
  const slot: Poly = [[-hs, y0], [hs, y0], [hs, my], [-hs, my]];
  const polys: Poly[] = [ring, slot, ...rails, ...shoulders];
  const g = gridFor(polys, spec.ppu, 1.5);
  const f = newFields(g, paintOf(spec.paint));
  for (const poly of polys) { const c = rasterPoly(g, poly); for (let i = 0; i < c.length; i++) if (c[i]! > f.cov[i]!) f.cov[i] = c[i]!; }
  const paint = lin(f.paint), gun = lin(0x3a4048), gunDark = lin(0x22262c), worn = lin(PALETTE.metalWorn), trim = lin(PALETTE.trim), bore = lin(0x07080b);
  const Hh = Math.max(1.2, nv.houseW * 0.18);
  const seed = hashStr('rail:' + Math.round(nv.houseW));
  const groove = Math.max(0.12, 0.6 / spec.ppu);
  const hexS = Math.max(rw * 0.42, 1.2 / spec.ppu);
  const railLen = y0 - my;
  for (let ty = 0; ty < g.h; ty++) {
    for (let tx = 0; tx < g.w; tx++) {
      const i = ty * g.w + tx;
      if (f.cov[i]! <= 0) continue;
      const wx = (tx + 0.5 - g.ox) / g.ppu, wy = (ty + 0.5 - g.oy) / g.ppu;
      const nz = valueNoise(wx * 0.5, wy * 0.5, seed);
      const ax = Math.abs(wx);
      let h = -1, mat: number = MAT.NONE, col = gun, kk = 0.94 + 0.1 * nz, key = PALETTE.metal;
      // Breech: concentric segmented rings stepping up to the hub.
      const r = Math.hypot(wx, wy), k = r / Rb;
      if (k <= 1) {
        const a = Math.atan2(wy, wx);
        if (k > 0.86) {
          h = Hh * 0.55; mat = MAT.PAINT; col = paint; key = f.paint;
          if (Math.abs(((a / (Math.PI * 2)) * 36 + 36) % 1 - 0.5) > 0.42) { mat = MAT.TRIM; col = trim; key = PALETTE.trim; h -= Hh * 0.08; }
        } else if (k > 0.8) { h = Hh * 0.45; mat = MAT.TRIM; col = trim; key = PALETTE.trim; }
        else if (k > 0.58) {
          h = Hh * 0.78; mat = MAT.METAL; col = gun;
          if (Math.abs(((a / (Math.PI * 2)) * 24 + 24.5) % 1 - 0.5) > 0.4) { col = gunDark; h -= Hh * 0.06; }
        } else if (k > 0.53) { h = Hh * 0.6; mat = MAT.TRIM; col = trim; key = PALETTE.trim; }
        else {
          h = Hh * (0.95 + 0.05 * (1 - k)); mat = MAT.METAL; col = gun; kk = 0.9 + 0.08 * nz;
          if (k > 0.47) col = worn; // the hub's bright rim
          // The breech bore the slot runs out of.
          if (ax < hs * 1.1 && wy < Rb * 0.18) { mat = MAT.NOZZLE; col = bore; key = PALETTE.nozzle; h = Hh * 0.3; }
          // Eight bolts round the hub.
          const ba = ((a / (Math.PI * 2)) * 8 + 8) % 1;
          if (Math.abs(k - 0.44) < 0.05 && Math.abs(ba - 0.5) < 0.12) { col = trim; key = PALETTE.trim; h += Hh * 0.04; }
        }
      }
      // Shoulders: flared, hex-plated, a step below the rails. Full width
      // beside the breech, then tapering into the rails' outer faces.
      if (ax > ro && wy < -Rb * 0.15 && wy > G.shoulderY1) {
        const t = wy >= -Rb * 0.9 ? 0 : (wy + Rb * 0.9) / (G.shoulderY1 + Rb * 0.9);
        const edge = G.shoulderW + (ro - G.shoulderW) * t;
        if (ax <= edge) {
          const sh = Hh * 0.72 - ((ax - ro) / Math.max(1e-3, G.shoulderW - ro)) * Hh * 0.18;
          if (sh > h) {
            h = sh; mat = MAT.METAL; col = gun; key = PALETTE.metal;
            if (hexEdge(wx, wy, hexS) < groove) { col = gunDark; h -= Hh * 0.04; }
            if (edge - ax < groove * 1.5) { col = trim; key = PALETTE.trim; }
          }
        }
      }
      // The slot between the rails: a dark open channel.
      if (ax < hs && wy <= y0 && wy >= my) { h = Hh * 0.12; mat = MAT.NOZZLE; col = bore; key = PALETTE.nozzle; kk = 1; }
      // The two rails, crowned, plated outside, a bright conductor lip inside.
      else if (ax >= hs && ax <= ro && wy <= y0 && wy >= my) {
        const u = (ax - hs) / rw; // 0 slot face .. 1 outer face
        const v = (y0 - wy) / railLen; // 0 breech .. 1 muzzle
        const crown = Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2));
        h = Hh * (0.82 + 0.18 * crown); mat = MAT.METAL; col = gun; key = PALETTE.metal; kk = 0.95 + 0.08 * nz;
        if (u < 0.16) { col = worn; kk = 0.85; }
        else if (v > 0.95) { col = worn; kk = 0.75; } // muzzle caps
        else if (u > 0.5 && hexEdge(wx, wy, hexS) < groove) { col = gunDark; h -= Hh * 0.03; }
        // Cross seams between rail sections.
        if (Math.abs(((v * 7) % 1) - 0.5) > 0.47 && u > 0.16) { col = trim; key = PALETTE.trim; h -= Hh * 0.05; }
        // Side vents along the outer face.
        if (u > 0.68) for (const vv of RAIL_VENTS) if (Math.abs(v - vv) * railLen < rw * 0.45) { mat = MAT.NOZZLE; col = bore; key = PALETTE.nozzle; h = Hh * 0.55; }
      }
      if (h < 0) continue;
      f.height[i] = h; f.mat[i] = mat; f.key[i] = key;
      setAlbedo(f, i, col, kk);
    }
  }
  return f;
}

/**
 * The turning part of a turret, through the same fields as a hull. Naval
 * gunhouses and the rail turret are drawn above; the small guns (bolt, beam,
 * charge, missile) are a faceted gunmetal housing with a mantlet and a
 * per-family barrel, or an armoured cell launcher (`smallGunForge.ts`).
 * Light it with litFrame at every sun step, like a ship, and pick the frame
 * by the gun's own world rotation.
 */
export function forgeTurretGun(spec: TurretGunSpec): Fields {
  if (spec.naval && spec.family === 'rail') return forgeRailTurret(spec);
  if (spec.naval) return forgeNavalTurret(spec);
  return forgeSmallGun(spec);
}
