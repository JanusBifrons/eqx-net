/**
 * Base visual plan + culling locks (plan: soft-leaping-truffle, PR-V2).
 */
import { describe, expect, it } from 'vitest';
import { generateBase } from '../../../core/procgen/generateBase.js';
import { BASE_GENERATOR_VERSION } from '../../../core/procgen/baseLayout.js';
import { chunkCount } from '../../../core/procgen/baseChunkMesh.js';
import { BASE_LOD_ZOOM, MAX_VISIBLE_CHUNKS } from '../../../shared-types/baseBudgets.js';
import { buildChunkVisual, cullChunks, useSilhouette, spawnDebris, DEBRIS_STRIDE } from './baseVisuals.js';

const l = generateBase({ ver: BASE_GENERATOR_VERSION, archetype: 'warehouse', seed: 42, x: 300, y: -200, size: 8000 });

describe('baseVisuals', () => {
  it('the plan is deterministic (same layout → same draw ops)', () => {
    expect(buildChunkVisual(l, 5)).toEqual(buildChunkVisual(l, 5));
  });

  it('draw ops follow the pixi Y-flip rule (pixiY = -gameY)', () => {
    // Every drawn rect must lie inside the base footprint once flipped back.
    for (let c = 0; c < chunkCount(l); c++) {
      for (const r of buildChunkVisual(l, c).rects) {
        const gy0 = -(r.y + r.h);
        expect(r.x).toBeGreaterThanOrEqual(l.descriptor.x - l.half - 1);
        expect(r.x + r.w).toBeLessThanOrEqual(l.descriptor.x + l.half + 1);
        expect(gy0).toBeGreaterThanOrEqual(l.descriptor.y - l.half - 1);
        expect(-r.y).toBeLessThanOrEqual(l.descriptor.y + l.half + 1);
      }
    }
  });

  it('destroyed pieces are not drawn', () => {
    const c = l.chunk[0]!;
    const full = buildChunkVisual(l, c).rects.length;
    const dead = new Uint32Array(Math.ceil(l.count / 32));
    dead[0] = 1; // piece 0
    expect(buildChunkVisual(l, c, dead).rects.length).toBeLessThan(full);
  });

  it('culling: a 1920×1080 view just above the LOD zoom draws ≤ MAX_VISIBLE_CHUNKS', () => {
    const zoom = BASE_LOD_ZOOM + 0.01;
    const w = 1920 / zoom, h = 1080 / zoom;
    const out = new Uint8Array(chunkCount(l));
    let worst = 0;
    for (let cy = -l.half; cy <= l.half; cy += 500) {
      for (let cx = -l.half; cx <= l.half; cx += 500) {
        const x = l.descriptor.x + cx, py = -(l.descriptor.y + cy);
        const view = new Float64Array([x - w / 2, py - h / 2, x + w / 2, py + h / 2]);
        worst = Math.max(worst, cullChunks(l, view, out));
      }
    }
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(MAX_VISIBLE_CHUNKS);
  });

  it('a view far from the base culls every chunk', () => {
    const out = new Uint8Array(chunkCount(l));
    expect(cullChunks(l, new Float64Array([20000, 20000, 21000, 21000]), out)).toBe(0);
  });

  it('switches to the silhouette below the LOD zoom', () => {
    expect(useSilhouette(BASE_LOD_ZOOM - 0.01, BASE_LOD_ZOOM)).toBe(true);
    expect(useSilhouette(BASE_LOD_ZOOM + 0.01, BASE_LOD_ZOOM)).toBe(false);
  });

  it('debris: deterministic, bounded by the pool, scaled by piece area', () => {
    const pool = new Float32Array(64 * DEBRIS_STRIDE);
    const a = spawnDebris(l, [0, 1, 2], pool, 0);
    const copy = pool.slice();
    const b = spawnDebris(l, [0, 1, 2], new Float32Array(64 * DEBRIS_STRIDE), 0);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(18); // ≥ 6 per piece
    expect(Array.from(spawnDebris(l, [0, 1, 2], new Float32Array(64 * DEBRIS_STRIDE), 0) && copy)).toEqual(Array.from(copy));
    // A tiny pool never overflows.
    const small = new Float32Array(5 * DEBRIS_STRIDE);
    expect(spawnDebris(l, [0, 1, 2, 3, 4, 5], small, 0)).toBe(5);
  });
});
