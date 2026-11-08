/**
 * Atlas page packing. Phone run 2026-11-07: 14 atlas pages were full while
 * the art placed in them added up to ~33 M texels of the pages' 59 M: the old
 * shelf packer (rows as tall as their tallest frame) wasted almost half of
 * every page, and Vega Reach's asteroids failed "over the budget". A skyline
 * packer must fit a realistic mix of frames far more tightly.
 */
import { describe, it, expect } from 'vitest';
import { Skyline } from './skyline.js';

/** Deterministic mix like a base-heavy sector's art. */
function frameMix(): Array<[number, number]> {
  let s = 12345;
  const r = (a: number, b: number): number => { s = (s * 1664525 + 1013904223) >>> 0; return a + Math.floor((s / 0x100000000) * (b - a)); };
  const out: Array<[number, number]> = [];
  for (let k = 0; k < 10; k++) { const w = r(150, 400), h = r(150, 400); for (let i = 0; i < 16; i++) out.push([w, h]); }
  for (let i = 0; i < 90; i++) out.push([r(40, 160), r(40, 160)]);
  for (let i = 0; i < 15; i++) { const w = r(200, 700), h = r(200, 700); out.push([w, h], [w >> 1, h >> 1]); }
  return out;
}

/** Pages a packer needs, placing frames in arrival order (as bakes land). */
function pagesFor(make: () => { place(w: number, h: number): boolean }, frames: Array<[number, number]>): number {
  let page = make(), pages = 1;
  for (const [w, h] of frames) if (!page.place(w, h)) { page = make(); pages++; if (!page.place(w, h)) throw new Error('frame too big'); }
  return pages;
}

/** Pages when every page stays open: each frame goes in the first page it fits. */
function pagesFirstFit(size: number, pad: number, frames: Array<[number, number]>): number {
  const pages: Skyline[] = [];
  for (const [w, h] of frames) {
    let ok = false;
    for (const pg of pages) if (pg.place(w, h)) { ok = true; break; }
    if (!ok) { const pg = new Skyline(size, pad); pages.push(pg); if (!pg.place(w, h)) throw new Error('frame too big'); }
  }
  return pages.length;
}

/** The old shelf layout (rows), for comparison. */
function shelf(size: number, pad: number): { place(w: number, h: number): boolean } {
  let x = pad, y = pad, rowH = 0;
  return {
    place(w, h) {
      if (x + w + pad > size) { x = pad; y += rowH + pad; rowH = 0; }
      if (y + h + pad > size) return false;
      x += w + pad; rowH = Math.max(rowH, h);
      return true;
    },
  };
}

describe('skyline atlas packing', () => {
  const SIZE = 2048, PAD = 8;

  it('fits a realistic sector mix in clearly fewer pages than rows', () => {
    const frames = frameMix();
    const rows = pagesFor(() => shelf(SIZE, PAD), frames);
    // Every page of the sector stays open (first fit), skyline within each.
    const sky = pagesFirstFit(SIZE, PAD, frames);
    let area = 0;
    for (const [w, h] of frames) area += w * h;
    const fill = area / (sky * SIZE * SIZE);
    // Measured: rows 7 pages, skyline 6, for 4.2 pages of art (60% -> 70%).
    expect(sky).toBeLessThan(rows);
    expect(fill).toBeGreaterThan(0.68);
  });

  it('never overlaps two frames and keeps the gutter', () => {
    const k = new Skyline(512, 4);
    const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
    let s = 7;
    const r = (a: number, b: number): number => { s = (s * 1103515245 + 12345) >>> 0; return a + (s % (b - a)); };
    for (let i = 0; i < 400; i++) {
      const w = r(8, 90), h = r(8, 90);
      const p = k.place(w, h);
      if (!p) continue;
      expect(p.x).toBeGreaterThanOrEqual(4);
      expect(p.y).toBeGreaterThanOrEqual(4);
      expect(p.x + w + 4).toBeLessThanOrEqual(512);
      expect(p.y + h + 4).toBeLessThanOrEqual(512);
      for (const q of placed) {
        const apart = p.x >= q.x + q.w + 4 || q.x >= p.x + w + 4 || p.y >= q.y + q.h + 4 || q.y >= p.y + h + 4;
        expect(apart).toBe(true);
      }
      placed.push({ x: p.x, y: p.y, w, h });
    }
    expect(placed.length).toBeGreaterThan(40);
  });

  it('can test a fit without placing (clone)', () => {
    const k = new Skyline(256, 2);
    k.place(100, 100);
    const c = k.clone();
    expect(c.place(150, 150)).not.toBeNull();
    // The original is untouched: the same frame still fits there.
    expect(k.place(150, 150)).not.toBeNull();
  });
});
