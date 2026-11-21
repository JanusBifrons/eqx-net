import { describe, expect, it } from 'vitest';
import { forgeTurretGun, type TurretGunSpec } from './turretForge.js';
import { NAVAL_BARREL_SPAN } from '../../../core/combat/muzzle.js';
import type { Fields } from './fieldsCore.js';

const SPECS: Array<{ name: string; spec: TurretGunSpec }> = [
  { name: 'big triple', spec: { family: 'bolt', paint: 0x8a3030, len: 20, wid: 1.6, cap: 0, ppu: 5, naval: { barrels: 3, houseW: 16, houseL: 14 } } },
  { name: 'twin secondary', spec: { family: 'bolt', paint: 0x305a8a, len: 9, wid: 0.9, cap: 0, ppu: 6, naval: { barrels: 2, houseW: 8, houseL: 7 } } },
  { name: 'quad AA', spec: { family: 'bolt', paint: 0x5a8a30, len: 5, wid: 0.5, cap: 0, ppu: 6, naval: { barrels: 4, houseW: 4, houseL: 4 } } },
  { name: 'single siege', spec: { family: 'bolt', paint: 0x777777, len: 30, wid: 3, cap: 0, ppu: 3, naval: { barrels: 1, houseW: 14, houseL: 16 } } },
];

function at(f: Fields, wx: number, wy: number): number {
  const tx = Math.floor(wx * f.g.ppu + f.g.ox), ty = Math.floor(wy * f.g.ppu + f.g.oy);
  return ty * f.g.w + tx;
}
function barrelXs(spec: TurretGunSpec): number[] {
  const nv = spec.naval!, n = nv.barrels;
  const pitch = n > 1 ? (nv.houseW * NAVAL_BARREL_SPAN) / (n - 1) : 0;
  return Array.from({ length: n }, (_, k) => (k - (n - 1) / 2) * pitch);
}
/** Texel centres with coverage, in world units. */
function* covered(f: Fields): Generator<{ i: number; wx: number; wy: number }> {
  for (let ty = 0; ty < f.g.h; ty++) for (let tx = 0; tx < f.g.w; tx++) {
    const i = ty * f.g.w + tx;
    if (f.cov[i]! > 0) yield { i, wx: (tx + 0.5 - f.g.ox) / f.g.ppu, wy: (ty + 0.5 - f.g.oy) / f.g.ppu };
  }
}

describe('forgeNavalTurret', () => {
  for (const { name, spec } of SPECS) {
    const nv = spec.naval!, hl = nv.houseL / 2, tipY = -hl - spec.len, texel = 1 / spec.ppu;
    describe(name, () => {
      const f = forgeTurretGun(spec);

      it('draws a barrel at each NAVAL_BARREL_SPAN x, reaching the tip', () => {
        for (const x of barrelXs(spec)) {
          for (const v of [0.05, 0.5, 0.97]) {
            const i = at(f, x, -hl - spec.len * v);
            expect(f.cov[i]!).toBeGreaterThan(0.9);
            expect(f.height[i]!).toBeGreaterThan(0);
          }
          expect(f.cov[at(f, x, tipY + texel * 0.6)]!).toBeGreaterThan(0);
        }
      });

      it('draws nothing beyond the tip', () => {
        for (const p of covered(f)) expect(p.wy).toBeGreaterThan(tipY - texel);
      });

      it('keeps every barrel top under the gunhouse roof', () => {
        let barrelMax = 0, roofMin = Infinity;
        for (const p of covered(f)) {
          if (f.cov[p.i]! < 1) continue;
          if (p.wy < -hl - texel) barrelMax = Math.max(barrelMax, f.height[p.i]!);
          else if (p.wy > -hl + 1) roofMin = Math.min(roofMin, f.height[p.i]!);
        }
        expect(barrelMax).toBeGreaterThan(0);
        expect(roofMin).toBeGreaterThan(barrelMax);
      });

      it('is deterministic', () => {
        const g = forgeTurretGun(spec);
        expect(Array.from(g.height)).toEqual(Array.from(f.height));
        expect(Array.from(g.albedo)).toEqual(Array.from(f.albedo));
        expect(Array.from(g.mat)).toEqual(Array.from(f.mat));
      });

      it("part 'house' bakes no barrels", () => {
        const h = forgeTurretGun({ ...spec, naval: { ...nv, part: 'house' } });
        for (const p of covered(h)) expect(p.wy).toBeGreaterThanOrEqual(-hl - texel);
      });

      it("part 'barrel' bakes one barrel at x 0, face to tip", () => {
        const b = forgeTurretGun({ ...spec, naval: { ...nv, part: 'barrel' } });
        const bw = spec.wid / 2;
        for (const p of covered(b)) {
          expect(Math.abs(p.wx)).toBeLessThan(bw + texel);
          expect(p.wy).toBeLessThan(-hl + 0.5 + texel);
          expect(p.wy).toBeGreaterThan(tipY - texel);
        }
        expect(b.cov[at(b, 0, tipY + texel * 0.6)]!).toBeGreaterThan(0);
        expect(b.height[at(b, 0, -hl - spec.len * 0.5)]!).toBeGreaterThan(0);
      });
    });
  }
});
