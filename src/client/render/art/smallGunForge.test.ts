/**
 * Small turret guns (bolt / beam / charge / missile): the restyled look keeps
 * the footprint the muzzle maths relies on (tip at -len, housing inside the
 * cap, the launcher's box) and bakes deterministically.
 */
import { describe, it, expect } from 'vitest';
import { forgeTurretGun, MAT, type GunFamily } from './fields.js';
import { missileCells } from './smallGunForge.js';

const SPEC = { paint: 0x3b7bd4, len: 10, wid: 2.4, cap: 3.6, ppu: 6 };
const BARRELLED: GunFamily[] = ['bolt', 'beam', 'charge'];

function texels(f: ReturnType<typeof forgeTurretGun>, fn: (wx: number, wy: number, i: number) => void): void {
  for (let ty = 0; ty < f.g.h; ty++) for (let tx = 0; tx < f.g.w; tx++) fn((tx + 0.5 - f.g.ox) / f.g.ppu, (ty + 0.5 - f.g.oy) / f.g.ppu, ty * f.g.w + tx);
}

describe('small turret guns', () => {
  for (const family of BARRELLED) {
    it(`${family}: the barrel reaches exactly to -len and no further`, () => {
      const f = forgeTurretGun({ family, ...SPEC });
      const px = 1 / SPEC.ppu;
      let tipCov = 0, beyond = 0;
      texels(f, (wx, wy, i) => {
        if (f.cov[i]! <= 0) return;
        if (wy < -SPEC.len + px && wy > -SPEC.len && Math.abs(wx) < px) tipCov = Math.max(tipCov, f.cov[i]!);
        if (wy < -SPEC.len - px) beyond++;
      });
      expect(tipCov).toBeGreaterThan(0.5);
      expect(beyond).toBe(0);
    });

    it(`${family}: the housing stays inside the cap and shades the barrel`, () => {
      const f = forgeTurretGun({ family, ...SPEC });
      const px = 1 / SPEC.ppu, maxHalf = SPEC.wid / 2 * 1.45;
      let outside = 0, houseTop = 0, barrelTop = 0;
      texels(f, (wx, wy, i) => {
        if (f.cov[i]! <= 0) return;
        const r = Math.hypot(wx, wy);
        if ((wy >= 0 || Math.abs(wx) > maxHalf + px) && r > SPEC.cap + 1.5 * px) outside++;
        if (r < SPEC.cap * 0.8) houseTop = Math.max(houseTop, f.height[i]!);
        if (wy < -SPEC.cap - px) barrelTop = Math.max(barrelTop, f.height[i]!);
      });
      expect(outside).toBe(0);
      expect(barrelTop).toBeGreaterThan(0);
      expect(barrelTop).toBeLessThan(houseTop);
    });
  }

  it('the beam ends in a glass lens and the bolt in a dark bore', () => {
    const at = (f: ReturnType<typeof forgeTurretGun>, x: number, y: number): number => Math.round(y * f.g.ppu + f.g.oy) * f.g.w + Math.round(x * f.g.ppu + f.g.ox);
    const beam = forgeTurretGun({ family: 'beam', ...SPEC });
    expect(beam.mat[at(beam, 0, -SPEC.len + 0.4)]).toBe(MAT.GLASS);
    const bolt = forgeTurretGun({ family: 'bolt', ...SPEC });
    expect(bolt.mat[at(bolt, 0, -SPEC.len + 0.1)]).toBe(MAT.NOZZLE);
  });

  it('missile: an armoured box with six dark launch-cell mouths', () => {
    const f = forgeTurretGun({ family: 'missile', ...SPEC, len: 0.1 });
    const px = 1 / SPEC.ppu;
    let outside = 0;
    texels(f, (wx, wy, i) => {
      if (f.cov[i]! > 0 && (Math.abs(wx) > SPEC.cap + px || Math.abs(wy) > SPEC.cap * 0.75 + px)) outside++;
    });
    expect(outside).toBe(0);
    // Count the 4-connected regions of dark mouth texels.
    const seen = new Uint8Array(f.g.w * f.g.h);
    let regions = 0;
    for (let i = 0; i < seen.length; i++) {
      if (seen[i] || f.mat[i] !== MAT.NOZZLE) continue;
      regions++;
      const stack = [i]; seen[i] = 1;
      while (stack.length) {
        const j = stack.pop()!, x = j % f.g.w, y = (j - x) / f.g.w;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx, ny = y + dy, k = ny * f.g.w + nx;
          if (nx < 0 || ny < 0 || nx >= f.g.w || ny >= f.g.h || seen[k] || f.mat[k] !== MAT.NOZZLE) continue;
          seen[k] = 1; stack.push(k);
        }
      }
    }
    expect(regions).toBe(6);
    // Each cell centre is a mouth.
    for (const [cx, cy] of missileCells(SPEC.cap)) {
      const i = Math.floor(cy * f.g.ppu + f.g.oy) * f.g.w + Math.floor(cx * f.g.ppu + f.g.ox);
      expect(f.mat[i]).toBe(MAT.NOZZLE);
    }
  });

  it('every family bakes deterministically', () => {
    for (const family of [...BARRELLED, 'missile'] as GunFamily[]) {
      const a = forgeTurretGun({ family, ...SPEC }), b = forgeTurretGun({ family, ...SPEC });
      expect(a.height).toEqual(b.height);
      expect(a.albedo).toEqual(b.albedo);
      expect(a.mat).toEqual(b.mat);
    }
  });
});
