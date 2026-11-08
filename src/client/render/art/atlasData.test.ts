/**
 * Data pages (GPU-lit maps, plan prancy-squishing-donut R2): every channel of
 * a lit-map frame is data, so a page must keep it byte for byte. A canvas
 * page premultiplies alpha, which wipes the colour of any texel whose alpha
 * is 0 — on slice B that is a normal + height with cavity 0, on slice C an
 * emission with material 0.
 */
import { describe, expect, it } from 'vitest';
import type { Texture } from 'pixi.js';
import { Atlas, PageBudget } from './atlas.js';
import type { Frame } from './shade.js';

function frame(w: number, h: number, seed: number): Frame {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37 + seed * 11) & 255;
  // A run of texels with alpha 0 but colour set: what a canvas would wipe.
  for (let i = 0; i < w * h; i += 3) data[i * 4 + 3] = 0;
  return { w, h, data };
}

describe('Atlas data pages', () => {
  it('keeps every byte of a frame, alpha-0 texels included', () => {
    const atlas = new Atlas(false, { pageSize: 256, data: true });
    const f = frame(40, 30, 1), g = frame(17, 9, 2);
    const out: Texture[] = [];
    expect(atlas.add(f, out, 0)).toBe(true);
    expect(atlas.add(g, out, 1)).toBe(true);
    atlas.commit();
    const page = atlas.pageData(0)!;
    for (const [fr, tex] of [[f, out[0]!], [g, out[1]!]] as const) {
      const { x, y } = tex.frame;
      for (let r = 0; r < fr.h; r++) {
        for (let c = 0; c < fr.w * 4; c++) {
          expect(page[(y + r) * 256 * 4 + x * 4 + c]).toBe(fr.data[r * fr.w * 4 + c]);
        }
      }
    }
    expect(out[0]!.source.alphaMode).toBe('no-premultiply-alpha');
  });

  it('two atlases on one budget stop at the shared cap, and freeing returns pages', () => {
    const budget = new PageBudget(2);
    const art = new Atlas(false, { pageSize: 64, data: true, budget });
    const lit = new Atlas(false, { pageSize: 64, data: true, budget });
    const big = frame(40, 40, 3), out: Texture[] = [];
    expect(art.add(big, out, 0)).toBe(true);
    expect(lit.add(big, out, 1)).toBe(true);
    expect(budget.used).toBe(2);
    expect(lit.canFit([big])).toBe(false);
    expect(lit.add(big, out, 2)).toBe(false);
    art.freeGroup(0);
    expect(budget.used).toBe(1);
    expect(lit.canFit([big])).toBe(true);
  });
});
