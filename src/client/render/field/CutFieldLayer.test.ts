import { describe, it, expect, vi } from 'vitest';
import type { Mesh } from 'pixi.js';

// A GL program needs a canvas; node has none (the look is checked in stills).
vi.mock('./fieldRockShader', () => ({
  fieldRockProgram: () => ({}),
  fieldRockShaderResources: () => ({}),
  setFieldRockView: () => {},
}));
import { rockKey } from '../../../core/terrain/fieldLayout';
import { buildFieldChunkMesh, CutFieldLayer, WOKEN_ROCK_FORGET_FRAMES } from './CutFieldLayer';

describe('cut-field chunk mesh (procedural rock look)', () => {
  // Two rocks: a square and a triangle, packed as [n, x0, y0, ...].
  const outlines = new Float32Array([4, 0, 0, 10, 0, 10, 10, 0, 10, 3, 100, 100, 130, 100, 100, 130]);
  const d = buildFieldChunkMesh(outlines);

  it('fans each rock from its centre: n+1 vertices, n triangles', () => {
    expect(d.positions.length / 2).toBe(5 + 4);
    expect(d.indices.length).toBe((4 + 3) * 3);
    expect(Math.max(...d.indices)).toBe(8);
    // Centre vertex first, vT 1; outline vT 0.
    expect([d.uvs[0], d.uvs[2]]).toEqual([1, 0]);
  });

  it('flips y into Pixi space and keeps offsets from the centre', () => {
    expect([d.positions[0], d.positions[1]]).toEqual([5, -5]);
    expect([d.local[2], d.local[3]]).toEqual([-5, 5]);
  });

  it('gives every vertex of a rock the same radius and seed, and rocks differ', () => {
    const r0 = Array.from(d.rock.slice(0, 4));
    for (let v = 1; v < 5; v++) expect(Array.from(d.rock.slice(v * 4, v * 4 + 4))).toEqual(r0);
    expect(r0[0]).toBeCloseTo(Math.hypot(5, 5), 4);
    expect(d.rock[5 * 4 + 3]).not.toBe(r0[3]);
  });
});

describe('CutFieldLayer — woken rocks (macro terrain C2)', () => {
  const outlines = new Float32Array([4, 0, 0, 10, 0, 10, 10, 0, 10, 3, 100, 100, 130, 100, 100, 130]);
  const key = rockKey(2, -1, 1); // the triangle

  it('collapses a woken rock in its chunk, builds it centred, and restores it once unseen', () => {
    const layer = new CutFieldLayer();
    layer.setChunk(2, -1, outlines);
    const pos = (): number[] => Array.from((layer.container.children[0] as Mesh).geometry.positions);
    const before = pos();
    layer.noteAwake(key);
    const hidden = pos();
    expect(hidden.slice(0, 10), 'the square is untouched').toEqual(before.slice(0, 10));
    // The triangle's outline sits on its centre (vertex 5).
    for (let v = 6; v < 9; v++) expect([hidden[v * 2], hidden[v * 2 + 1]]).toEqual([hidden[10], hidden[11]]);

    const sprite = layer.buildRockSprite(key)!;
    expect(sprite).not.toBeNull();
    const sp = Array.from(sprite.geometry.positions);
    expect([sp[0]! + 0, sp[1]! + 0]).toEqual([0, 0]); // centred
    expect(sp.length).toBe(4 * 2);

    for (let f = 0; f <= WOKEN_ROCK_FORGET_FRAMES; f++) { layer.noteAwake(key); layer.setView(0, 1); }
    expect(pos()).toEqual(hidden); // still awake
    for (let f = 0; f <= WOKEN_ROCK_FORGET_FRAMES + 1; f++) layer.setView(0, 1);
    expect(pos()).toEqual(before);
    layer.clear();
  });

  it('a chunk that arrives after its rock woke draws without it; no chunk, no sprite', () => {
    const layer = new CutFieldLayer();
    expect(layer.buildRockSprite(key)).toBeNull();
    layer.noteAwake(key);
    layer.setChunk(2, -1, outlines);
    const p = Array.from((layer.container.children[0] as Mesh).geometry.positions);
    expect([p[12], p[13]]).toEqual([p[10], p[11]]);
    layer.clear();
  });
});
