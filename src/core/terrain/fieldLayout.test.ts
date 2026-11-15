import { describe, it, expect } from 'vitest';
import { slicedField, FIELD_LAYOUT_VERSION } from './fieldLayout.js';

// A small field (20 km radius) keeps the tests fast; the rules are the same.
const B = 5752, F = 48, R = 20_000;
const WHOLE = { x0: -R * 1.2, y0: -R * 1.2, x1: R * 1.2, y1: R * 1.2 };
const cut = (view = WHOLE, seed = 'test') => slicedField({ seed, battleshipLength: B, fighterLength: F, view, radius: R });

describe('cut field (macro terrain v2, A1)', () => {
  it('has a layout version', () => {
    expect(FIELD_LAYOUT_VERSION).toBeGreaterThanOrEqual(1);
  });

  it('is deterministic: the same seed cuts the same rocks', () => {
    const a = cut(), b = cut();
    expect(a.length).toBeGreaterThan(100);
    expect(b).toEqual(a);
    expect(cut(WHOLE, 'other')).not.toEqual(a);
  });

  it('gives every piece its own cut path (no shared random streams)', () => {
    const rocks = cut();
    const paths = new Set(rocks.map((r) => r.path));
    expect(paths.size).toBe(rocks.length);
  });

  it('cutting a sub-area gives the very same rocks as cutting the whole field', () => {
    const all = cut();
    const whole = new Map(all.map((r) => [r.path, r]));
    // A 4 km window centred on a real rock (lanes and the core hole are wide
    // in a field this small).
    const at = all[Math.floor(all.length / 2)]!;
    const view = { x0: at.cx - 2000, y0: at.cy - 2000, x1: at.cx + 2000, y1: at.cy + 2000 };
    const part = cut(view);
    expect(part.length).toBeGreaterThan(5);
    for (const r of part) expect(whole.get(r.path), `piece ${r.path}`).toEqual(r);
    // And no rock of the whole field that reaches into the view is missing.
    const inView = (r: { verts: Array<{ x: number; y: number }> }) =>
      r.verts.some((p) => p.x >= view.x0 && p.x <= view.x1 && p.y >= view.y0 && p.y <= view.y1);
    const partPaths = new Set(part.map((r) => r.path));
    for (const r of whole.values()) if (inView(r)) expect(partPaths.has(r.path), `missing ${r.path}`).toBe(true);
  });
});
