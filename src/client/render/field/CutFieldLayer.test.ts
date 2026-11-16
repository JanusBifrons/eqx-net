import { describe, it, expect, vi } from 'vitest';
import type { Mesh } from 'pixi.js';

// A GL program needs a canvas; node has none (the look is checked in stills).
vi.mock('./fieldRockShader', () => ({
  fieldRockProgram: () => ({}),
  fieldRockShaderResources: () => ({}),
  setFieldRockView: () => {},
  setFieldOreStyle: () => {},
}));
import { coarseFieldThin, rockKey, SLICED, type ChunkRock } from '../../../core/terrain/fieldLayout';
import { FAR_FIELD_SWITCH_SCALE, FAR_ICON } from '../pixi/FarZoomIcons';
import { packChunk } from '../../../core/terrain/packedChunk';
import { fieldRockBody } from '../../../core/terrain/chunkStreamer';
import { buildFieldChunkMesh, CutFieldLayer, WOKEN_ROCK_FORGET_FRAMES } from './CutFieldLayer';
import type { RenderMirror } from '@core/contracts/IRenderer';

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

  it('carries the ore per vertex (F1c), zeros when none is given', () => {
    expect(Array.from(d.ore)).toEqual(new Array(18).fill(0));
    const ore = new Float32Array(18).map((_, i) => i / 18);
    expect(buildFieldChunkMesh(outlines, ore).ore).toBe(ore);
  });
});

describe('CutFieldLayer — woken rocks (macro terrain C2)', () => {
  const outlines = new Float32Array([4, 0, 0, 10, 0, 10, 10, 0, 10, 3, 100, 100, 130, 100, 100, 130]);
  const key = rockKey(2, -1, 1); // the triangle

  it('collapses a woken rock in its chunk, builds it centred, and restores it once unseen', () => {
    const layer = new CutFieldLayer();
    layer.setChunk(2, -1, outlines);
    const pos = (): number[] => Array.from((layer.chunkLayer.children[0] as Mesh).geometry.positions);
    const before = pos();
    layer.noteAwake(key);
    const hidden = pos();
    expect(hidden.slice(0, 10), 'the square is untouched').toEqual(before.slice(0, 10));
    // The triangle's outline sits on its centre (vertex 5).
    for (let v = 6; v < 9; v++) expect([hidden[v * 2], hidden[v * 2 + 1]]).toEqual([hidden[10], hidden[11]]);

    const sprite = layer.buildRockSprite(key)!;
    expect(sprite).not.toBeNull();
    const ore = new Float32Array(18).map((_, i) => i);
    const lit = new CutFieldLayer();
    lit.setChunk(2, -1, outlines, ore);
    // The woken triangle keeps its own vertices' ore (verts 5..8).
    expect(Array.from(lit.buildRockSprite(key)!.geometry.getBuffer('aOre').data as Float32Array)).toEqual([10, 11, 12, 13, 14, 15, 16, 17]);
    lit.clear();
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
    const p = Array.from((layer.chunkLayer.children[0] as Mesh).geometry.positions);
    expect([p[12], p[13]]).toEqual([p[10], p[11]]);
    layer.clear();
  });
});

describe('CutFieldLayer — rock bodies for the link preview (C5c)', () => {
  it('gives a rock the body fieldRockBody gives it (the server\'s), from its packed chunk', () => {
    const verts = [{ x: 0, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 500 }, { x: 300, y: 150 }, { x: 0, y: 500 }];
    const rocks: ChunkRock[] = [
      { verts: [{ x: 5, y: 5 }, { x: 9, y: 5 }, { x: 9, y: 9 }], cx: 0, cy: 0, size: 1, path: 1, index: 0, key: rockKey(2, -1, 0) },
      { verts, cx: 0, cy: 0, size: 1, path: 2, index: 1, key: rockKey(2, -1, 1) },
    ];
    const packed = packChunk(rocks, 'c5c');
    const layer = new CutFieldLayer();
    expect(layer.rockBody(rocks[1]!.key)).toBeNull(); // no chunk yet
    layer.setChunk(2, -1, packed.outlines, packed.ore); // a sink that sent no bodies
    expect(layer.rockBody(rocks[1]!.key)).toBeNull();
    layer.setChunk(2, -1, packed.outlines, packed.ore, packed);
    expect(layer.rockBody(rocks[1]!.key)).toEqual(fieldRockBody({ verts }));
    layer.clear();
  });
});

describe('CutFieldLayer — moved rocks (C2 deep sleep)', () => {
  // The square (centre 5,5) and the triangle; the triangle was moved.
  const outlines = new Float32Array([4, 0, 0, 10, 0, 10, 10, 0, 10, 3, 100, 100, 130, 100, 100, 130]);
  const key = rockKey(2, -1, 1);
  const pos = (layer: CutFieldLayer): number[] => Array.from((layer.chunkLayer.children[0] as Mesh).geometry.positions);

  it('draws a moved rock at its pose (not where it was cut), hides it while the wire draws it, and brings it back there', () => {
    const plain = new CutFieldLayer();
    plain.setChunk(2, -1, outlines);
    const cut = pos(plain);
    plain.clear();
    const layer = new CutFieldLayer();
    // Moved by (+1000, -500), a quarter turn, about the fan centre (no bodies sent).
    layer.setChunk(2, -1, outlines, null, null, new Float64Array([1, 1110, -390, Math.PI / 2]));
    const at = pos(layer);
    expect(at.slice(0, 10), 'the square is untouched').toEqual(cut.slice(0, 10));
    // Centre (vertex 5) at the pose, Pixi y flipped.
    expect(at[10]).toBeCloseTo(1110, 3);
    expect(at[11]).toBeCloseTo(390, 3);
    // Vertex 6 (100,100) is (-10,-10) off centre (110,110): turned 90° ⇒ (10,-10).
    expect(at[12]).toBeCloseTo(1120, 3);
    expect(at[13]).toBeCloseTo(400, 3);
    // Nothing is left at the layout pose.
    for (let v = 5; v < 9; v++) expect(Math.hypot(at[v * 2]! - cut[v * 2]!, at[v * 2 + 1]! - cut[v * 2 + 1]!)).toBeGreaterThan(500);

    // On the wire: its swarm sprite draws it, the chunk copy collapses (no double draw).
    layer.noteAwake(key);
    const hidden = pos(layer);
    for (let v = 6; v < 9; v++) expect([hidden[v * 2], hidden[v * 2 + 1]]).toEqual([hidden[10], hidden[11]]);
    // Off the wire: back at the moved pose, not the layout one.
    for (let f = 0; f <= WOKEN_ROCK_FORGET_FRAMES + 1; f++) layer.setView(0, 1);
    expect(pos(layer)).toEqual(at);
    layer.clear();
  });
});

describe('CutFieldLayer — far-zoom coarse tiles (B4)', () => {
  const outlines = new Float32Array([4, 0, 0, 10, 0, 10, 10, 0, 10, 3, 100, 100, 130, 100, 100, 130]);
  // A coarse tile: one big piece, 30 km out (game space).
  const tile = new Float32Array([4, 30_000, 0, 32_000, 0, 32_000, 2_000, 30_000, 2_000]);
  const mesh = (c: { children: unknown[] }): Mesh => c.children[0] as Mesh;

  it('builds tiles with the chunk mesh path and the same shader instance (one program)', () => {
    const layer = new CutFieldLayer();
    layer.setChunk(0, 0, outlines);
    layer.setCoarseTile(0, 0, tile);
    expect(layer.coarseCount).toBe(1);
    expect(mesh(layer.coarseLayer).shader).toBe(mesh(layer.chunkLayer).shader);
    expect(Array.from(mesh(layer.coarseLayer).geometry.positions)).toEqual(Array.from(buildFieldChunkMesh(tile).positions));
    layer.clear();
  });

  it('below the switch shows only the tiles, above it only the chunks; the hidden level is not visible', () => {
    const layer = new CutFieldLayer();
    layer.setChunk(0, 0, outlines);
    layer.setCoarseTile(0, 0, tile);
    layer.setView(0, 0.005);
    expect([layer.chunkLayer.visible, layer.coarseLayer.visible]).toEqual([false, true]);
    expect(layer.coarseLayer.alpha).toBe(1);
    layer.setView(0, 0.15);
    expect([layer.chunkLayer.visible, layer.coarseLayer.visible]).toEqual([true, false]);
    expect(layer.chunkLayer.alpha).toBe(1);
    layer.setView(0, 0.0216 * 1.12); // inside the band: crossfade
    expect([layer.chunkLayer.visible, layer.coarseLayer.visible]).toEqual([true, true]);
    layer.clear();
  });

  it('never washes out across the band: one level is always fully opaque, and both ends are continuous', () => {
    // Owner stills: at mid-fade (0.024) both levels at half alpha read as a
    // double exposure. The coarse level comes up opaque under the chunks
    // first; then the chunks fade out over it.
    const layer = new CutFieldLayer();
    layer.setChunk(0, 0, outlines);
    layer.setCoarseTile(0, 0, tile);
    const lo = FAR_FIELD_SWITCH_SCALE, hi = FAR_FIELD_SWITCH_SCALE * FAR_ICON.hysteresis;
    for (let k = 0; k <= 40; k++) {
      const s = lo * 0.99 + ((hi * 1.01 - lo * 0.99) * k) / 40;
      layer.setView(0, s);
      const c = layer.chunkLayer.visible ? layer.chunkLayer.alpha : 0, f = layer.coarseLayer.visible ? layer.coarseLayer.alpha : 0;
      expect(Math.max(c, f), `scale ${s}`).toBe(1);
    }
    layer.setView(0, 0.024); // the owner's mid-fade still: tiles opaque, detail fading over them
    expect(layer.coarseLayer.alpha).toBe(1);
    expect(layer.chunkLayer.alpha).toBeGreaterThan(0.5);
    layer.setView(0, hi * 0.999); // just inside the detail end: tiles barely in
    expect(layer.coarseLayer.alpha).toBeLessThan(0.02);
    layer.setView(0, lo * 1.001); // just inside the far end: chunks barely left
    expect(layer.chunkLayer.alpha).toBeLessThan(0.02);
    layer.clear();
  });

  it('marks tile vertices far-zoom (aUV.y = 1 + coarseFieldThin, thinning toward the rim); chunks stay 0', () => {
    const layer = new CutFieldLayer();
    layer.setChunk(0, 0, outlines);
    const R = SLICED.radius;
    layer.setCoarseTile(0, 0, tile); // 30 km out: d 0.2
    layer.setCoarseTile(4, 0, new Float32Array([4, R * 0.95, 0, R * 0.95 + 2000, 0, R * 0.95 + 2000, 2000, R * 0.95, 2000]));
    layer.setCoarseTile(0, 1, new Float32Array([3, 0, 0, 1000, 0, 0, 1000])); // at the centre: thin 0, still marked
    const thin = (m: Mesh): number[] => Array.from(m.geometry.uvs).filter((_, i) => i % 2 === 1);
    const [near, rim, core] = layer.coarseLayer.children as Mesh[];
    for (const t of thin(near!)) expect(t - 1).toBeCloseTo(coarseFieldThin(0.2), 1);
    for (const t of thin(rim!)) expect(t - 1).toBeGreaterThan(0.9);
    for (const t of thin(core!)) expect(t).toBeGreaterThanOrEqual(1);
    expect(Math.max(...thin(mesh(layer.chunkLayer)))).toBe(0);
    layer.clear();
  });

  it('gives tile vertices their piece centre (Pixi world) as the noise offset, so the shader\'s rock-sized cells run on across pieces', () => {
    // Owner film: at the switch the coarse slabs (~1.6 km, no streets) swap
    // in for ~500 u rocks with streets. The shader draws rock-sized cells
    // with streets on the tiles in world space (aLocal + aRock.yz).
    const layer = new CutFieldLayer();
    layer.setCoarseTile(0, 0, tile);
    const g = mesh(layer.coarseLayer).geometry;
    const pos = g.positions, local = g.getBuffer('aLocal').data as Float32Array, rock = g.getBuffer('aRock').data as Float32Array;
    for (let v = 0; v < pos.length / 2; v++) {
      expect(local[v * 2]! + rock[v * 4 + 1]!).toBeCloseTo(pos[v * 2]!, 3);
      expect(local[v * 2 + 1]! + rock[v * 4 + 2]!).toBeCloseTo(pos[v * 2 + 1]!, 3);
    }
    layer.clear();
  });

  it('a far view with no tiles yet keeps drawing the chunks', () => {
    const layer = new CutFieldLayer();
    layer.setChunk(0, 0, outlines);
    layer.setView(0, 0.005);
    expect(layer.chunkLayer.visible).toBe(true);
    expect(layer.chunkLayer.alpha).toBe(1);
    layer.clear();
  });

  it('hides a tile outside the view bounds (Pixi space x0, y0, x1, y1)', () => {
    const layer = new CutFieldLayer();
    layer.setCoarseTile(0, 0, tile);
    layer.setView(0, 0.005, [-10_000, -10_000, 10_000, 10_000]);
    expect(mesh(layer.coarseLayer).visible).toBe(false);
    layer.setView(0, 0.005, [25_000, -5_000, 40_000, 5_000]);
    expect(mesh(layer.coarseLayer).visible).toBe(true);
    layer.clear();
  });

  it('drains level-tagged tiles from the mirror queue; null drops one; clear drops them all', () => {
    const layer = new CutFieldLayer();
    const mirror = { pendingFieldChunks: [
      { cx: 0, cy: 0, outlines: tile, level: 'coarse' as const },
      { cx: 1, cy: 0, outlines: tile, level: 'coarse' as const },
      { cx: 0, cy: 0, outlines },
    ] } as unknown as RenderMirror;
    layer.update(mirror, 0, 0.005);
    expect([layer.coarseCount, layer.chunkCount]).toEqual([2, 1]);
    mirror.pendingFieldChunks!.push({ cx: 1, cy: 0, outlines: null, level: 'coarse' });
    layer.update(mirror, 0, 0.005);
    expect(layer.coarseCount).toBe(1);
    layer.clear();
    expect(layer.coarseCount).toBe(0);
    expect(layer.coarseLayer.children.length).toBe(0);
  });
});
