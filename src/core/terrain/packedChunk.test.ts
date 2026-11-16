import { describe, it, expect } from 'vitest';
import { cutFieldOpts, fieldRockBody } from './chunkStreamer.js';
import { rocksInChunk, SLICED } from './fieldLayout.js';
import { oreForOutlines, oreSeed } from './fieldOre.js';
import { collapsePackedRock, packChunk, packedBuffers, packedRockBody, packOutlines } from './packedChunk.js';

const field = cutFieldOpts('test-seed');
const CX = 15, CY = 0; // in the field ring

describe('packed cut-field chunks (the client worker cut, macro terrain v2)', () => {
  const rocks = rocksInChunk(field, CX, CY);
  const packed = packChunk(rocks, field.seed);

  it('unpacks every rock body exactly as fieldRockBody builds it (#15: same collider as the server)', () => {
    expect(rocks.length).toBeGreaterThan(10);
    expect(Array.from(packed.keys)).toEqual(rocks.map((r) => r.key));
    rocks.forEach((rock, i) => expect(packedRockBody(packed, i)).toEqual(fieldRockBody(rock)));
  });

  it('carries the draw outlines and the ore the main thread used to work out', () => {
    expect(packed.outlines).toEqual(packOutlines(rocks));
    expect(packed.ore).toEqual(oreForOutlines(oreSeed(field.seed), SLICED.radius, packOutlines(rocks)));
  });

  it('posts as eight transferable buffers, and an empty chunk packs empty', () => {
    expect(new Set(packedBuffers(packed)).size).toBe(8);
    const none = packChunk([], field.seed);
    expect(none.keys.length + none.outlines.length + none.ore.length).toBe(0);
  });
});

describe('collapsePackedRock', () => {
  it('flattens one rock onto its centre and leaves the others and the layout alone', () => {
    const rocks = rocksInChunk(field, CX, CY);
    expect(rocks.length).toBeGreaterThan(2);
    const c = packChunk(rocks, field.seed);
    const before = c.outlines.slice();
    collapsePackedRock(c, 1);
    expect(c.outlines.length).toBe(before.length);
    const s1 = c.starts[1]!, n = c.outlines[s1]!;
    expect(c.outlines[s1]).toBe(n);
    for (let k = 1; k < n; k++) {
      expect(c.outlines[s1 + 1 + k * 2]).toBe(c.outlines[s1 + 1]);
      expect(c.outlines[s1 + 2 + k * 2]).toBe(c.outlines[s1 + 2]);
    }
    for (let i = 0; i < s1; i++) expect(c.outlines[i]).toBe(before[i]);
    const s2 = c.starts[2]!;
    for (let i = s2; i < before.length; i++) expect(c.outlines[i]).toBe(before[i]);
  });
});

describe('field rock collider parts (macro terrain C1)', () => {
  it('gives most rocks a few convex parts that follow the outline', () => {
    const rocks = rocksInChunk(cutFieldOpts('look'), 14, 0);
    let withParts = 0;
    for (const rock of rocks) {
      const b = fieldRockBody(rock);
      if (b.parts === null) continue;
      withParts++;
      expect(b.parts.length).toBeLessThanOrEqual(10);
      let sum = 0, whole = 0;
      for (const p of b.parts) for (let k = 0; k < p.length; k++) { const a = p[k]!, c = p[(k + 1) % p.length]!; sum += a.x * c.y - c.x * a.y; }
      for (let k = 0; k < b.verts.length; k++) { const a = b.verts[k]!, c = b.verts[(k + 1) % b.verts.length]!; whole += a.x * c.y - c.x * a.y; }
      expect(Math.abs(Math.abs(sum) - Math.abs(whole)) / Math.abs(whole), 'parts cover the outline').toBeLessThan(0.06);
    }
    expect(withParts / rocks.length).toBeGreaterThan(0.8);
  });
});

describe('dent spot (cut-field-collision.spec, plan C1)', () => {
  it('(-30698, 25366) is outside every field rock collider part by more than a fighter shield bubble', () => {
    const o = cutFieldOpts('look'), p = { x: -30_698, y: 25_366 };
    let clear = Infinity;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const rock of rocksInChunk(o, -8 + i, 6 + j)) {
      const b = fieldRockBody(rock);
      for (const part of b.parts ?? []) {
        let inside = true, d = Infinity;
        for (let k = 0; k < part.length; k++) {
          const a = part[k]!, c = part[(k + 1) % part.length]!;
          const ax = a.x + b.x, ay = a.y + b.y, cx = c.x + b.x, cy = c.y + b.y;
          const ex = cx - ax, ey = cy - ay, t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.y - ay) * ey) / (ex * ex + ey * ey)));
          d = Math.min(d, Math.hypot(p.x - ax - t * ex, p.y - ay - t * ey));
          if (ex * (p.y - ay) - ey * (p.x - ax) < 0) inside = false;
        }
        clear = Math.min(clear, inside ? -d : d);
      }
    }
    expect(clear).toBeGreaterThan(36); // shield bubble 34 u + slack
  });
});
