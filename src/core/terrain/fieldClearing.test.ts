import { describe, it, expect } from 'vitest';
import { slicedField, rocksInChunk, chunkOf, cutFieldPad, type FieldClearing } from './fieldLayout.js';

// Macro terrain F4: clearings (open pockets) cut out of the field like the core.
const B = 5752, F = 48, R = 20_000;
const WHOLE = { x0: -R * 1.2, y0: -R * 1.2, x1: R * 1.2, y1: R * 1.2 };
const cut = (clearings?: FieldClearing[]) =>
  slicedField({ seed: 'test', battleshipLength: B, fighterLength: F, view: WHOLE, radius: R, ...(clearings ? { clearings } : {}) });
// Centred on a real rock, so there is something to clear.
const AT = cut()[Math.floor(cut().length / 3)]!;
const CLEAR: FieldClearing = { x: AT.cx, y: AT.cy, r: 3000 };
/** Nearest point of a rock's final (warped) outline to the clearing's centre. */
const nearest = (r: { verts: Array<{ x: number; y: number }> }) => Math.min(...r.verts.map((v) => Math.hypot(v.x - CLEAR.x, v.y - CLEAR.y)));
/** How far a rock's outline reaches from its pre-warp centre. */
const reach = (r: { cx: number; cy: number; verts: Array<{ x: number; y: number }> }) => Math.max(...r.verts.map((v) => Math.hypot(v.x - r.cx, v.y - r.cy)));

describe('field clearings (F4)', () => {
  // Exact: a warp drop on a pocket's rim must never land in rock.
  it('leaves no rock inside a clearing (warped outlines included)', () => {
    const rocks = cut([CLEAR]);
    for (const r of rocks) expect(nearest(r), `piece ${r.path}`).toBeGreaterThanOrEqual(CLEAR.r);
    // The wall is AT the edge, not kilometres back: rocks reach close to it.
    expect(Math.min(...rocks.map(nearest))).toBeLessThan(CLEAR.r + 600);
    // And it is a real hole: the field had rocks there before.
    expect(cut().some((r) => Math.hypot(r.cx - CLEAR.x, r.cy - CLEAR.y) < CLEAR.r)).toBe(true);
  });

  // A piece reaching into the clearing is cut on down to small rocks, and the
  // ones reaching in go; rocks clear of it are untouched.
  it('changes only rocks that could reach the clearing (same rocks, same paths elsewhere)', () => {
    const before = cut();
    const after = new Map(cut([CLEAR]).map((r) => [r.path, r]));
    const pad = cutFieldPad();
    let kept = 0;
    for (const r of before) {
      if (Math.hypot(r.cx - CLEAR.x, r.cy - CLEAR.y) - reach(r) - 2 * pad < CLEAR.r) continue;
      expect(after.get(r.path), `piece ${r.path}`).toEqual(r);
      kept++;
    }
    expect(kept).toBeGreaterThan(before.length / 2);
  });

  it('chunks honour clearings the same way as a whole cut', () => {
    const o = { seed: 'test', battleshipLength: B, fighterLength: F, radius: R, clearings: [CLEAR] };
    const c = chunkOf(CLEAR.x, CLEAR.y);
    const whole = new Set(cut([CLEAR]).map((r) => r.path));
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      for (const r of rocksInChunk(o, c.cx + dx, c.cy + dy)) {
        expect(whole.has(r.path)).toBe(true);
        expect(nearest(r)).toBeGreaterThanOrEqual(CLEAR.r);
      }
    }
  });
});
