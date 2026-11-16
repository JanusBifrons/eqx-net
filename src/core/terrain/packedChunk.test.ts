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

  it('posts as six transferable buffers, and an empty chunk packs empty', () => {
    expect(new Set(packedBuffers(packed)).size).toBe(6);
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
