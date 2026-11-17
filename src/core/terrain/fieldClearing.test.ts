import { describe, it, expect } from 'vitest';
import { slicedField, rocksInChunk, chunkOf, type FieldClearing } from './fieldLayout.js';

// Macro terrain F4: clearings (open pockets) cut out of the field like the core.
const B = 5752, F = 48, R = 20_000;
const WHOLE = { x0: -R * 1.2, y0: -R * 1.2, x1: R * 1.2, y1: R * 1.2 };
const cut = (clearings?: FieldClearing[]) =>
  slicedField({ seed: 'test', battleshipLength: B, fighterLength: F, view: WHOLE, radius: R, ...(clearings ? { clearings } : {}) });
// Centred on a real rock, so there is something to clear.
const AT = cut()[Math.floor(cut().length / 3)]!;
const CLEAR: FieldClearing = { x: AT.cx, y: AT.cy, r: 3000 };
const mean = (r: { verts: Array<{ x: number; y: number }> }) => {
  let x = 0, y = 0;
  for (const v of r.verts) { x += v.x; y += v.y; }
  return { x: x / r.verts.length, y: y / r.verts.length };
};

describe('field clearings (F4)', () => {
  it('leaves no rock inside a clearing (warped outlines included)', () => {
    const rocks = cut([CLEAR]);
    // Before the warp no centre is inside; after it, outlines stay out of
    // the clearing's middle.
    for (const r of rocks) expect(Math.hypot(r.cx - CLEAR.x, r.cy - CLEAR.y)).toBeGreaterThanOrEqual(CLEAR.r);
    const inner = CLEAR.r - 1500;
    for (const r of rocks) for (const v of r.verts) expect(Math.hypot(v.x - CLEAR.x, v.y - CLEAR.y)).toBeGreaterThan(inner);
    // And it is a real hole: the field had rocks there before.
    expect(cut().some((r) => Math.hypot(r.cx - CLEAR.x, r.cy - CLEAR.y) < CLEAR.r)).toBe(true);
  });

  // A piece smaller than the clearing whose centre is inside goes whole, so
  // the edge is ragged out to twice the radius (the open core's rule too).
  it('changes nothing beyond twice the radius (same rocks, same paths)', () => {
    const before = new Map(cut().map((r) => [r.path, r]));
    const after = cut([CLEAR]);
    expect(after.length).toBeLessThan(before.size);
    for (const r of after) expect(before.get(r.path), `piece ${r.path}`).toEqual(r);
    for (const r of before.values()) {
      if (Math.hypot(r.cx - CLEAR.x, r.cy - CLEAR.y) >= 2 * CLEAR.r) expect(after.some((a) => a.path === r.path), `piece ${r.path}`).toBe(true);
    }
  });

  it('chunks honour clearings the same way as a whole cut', () => {
    const o = { seed: 'test', battleshipLength: B, fighterLength: F, radius: R, clearings: [CLEAR] };
    const c = chunkOf(CLEAR.x, CLEAR.y);
    const whole = new Set(cut([CLEAR]).map((r) => r.path));
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const r of rocksInChunk(o, c.cx + dx, c.cy + dy)) {
        expect(whole.has(r.path)).toBe(true);
        expect(Math.hypot(mean(r).x - CLEAR.x, mean(r).y - CLEAR.y)).toBeGreaterThan(CLEAR.r - 1500);
      }
    }
  });
});
