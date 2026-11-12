/**
 * Capital destruction S3 — wreck art, the pure parts.
 *
 * Texture continuity: each wreck piece samples the dead ship's own baked hull
 * art at the piece's ORIGINAL hull-local coordinates, so the pieces fit
 * together like a jigsaw. A capital's art is tiled (one texture per tile along
 * the hull), so a piece is cut into one mesh per tile it covers; each mesh's
 * UVs are its tile texture's frame-relative coordinates.
 *
 * Glow: only the NEW cut edges glow, molten at death, an ember at ~4 s, dark
 * at the end.
 */
import { describe, it, expect } from 'vitest';
import {
  wreckPieceMeshes,
  wreckGlowAt,
  cutEdgeRuns,
  WRECK_GLOW_EMBER_S,
  WRECK_GLOW_END_S,
  wreckBlasts,
  type WreckBlast,
  type WreckTexLayout,
} from './wreckArt.js';
import { rebuildWreckPieces } from '../../net/wreckGeometryStore.js';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull.js';
import type { WreckDescriptor } from '../../../shared-types/messages/snapshotMessages.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieces.js';

const DESC: WreckDescriptor = {
  wreckId: 3, parentKind: 'battleship', seed: 11, killX: 0, killY: -400,
  killBlowDamage: 2, recentDamageRate: 1, snapChance: 0, algoVersion: FRACTURE_ALGO_VERSION,
};

/** A tiled layout that covers the whole hull (like a baked capital's). */
function layoutFor(pieces: WreckPieceGeometry[]): WreckTexLayout {
  let mx = 0, my = 0;
  for (const p of pieces) for (const v of p.outline) {
    mx = Math.max(mx, Math.abs(v.x + p.cx));
    my = Math.max(my, Math.abs(v.y + p.cy));
  }
  const w = 300, h = 1400;
  const density = Math.min(w / (2 * mx * 1.05), h / (2 * my * 1.05));
  return { w, h, tiles: 3, tileH: 512, density, frameW: w, frameHs: [512, 512, h - 1024] };
}

/** The expected UV of a hull-local (math-up, scaled) point on tile `t`. */
function expectedUv(hx: number, hy: number, L: WreckTexLayout, t: number): [number, number] {
  const tx = hx * L.density + L.w / 2;
  const ty = -hy * L.density + L.h / 2 - t * L.tileH;
  return [tx / L.frameW, ty / L.frameHs[t]!];
}

function triArea(px: Float32Array, idx: Uint32Array): number {
  let a = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const i0 = idx[i]! * 2, i1 = idx[i + 1]! * 2, i2 = idx[i + 2]! * 2;
    a += Math.abs((px[i1]! - px[i0]!) * (px[i2 + 1]! - px[i0 + 1]!) - (px[i2]! - px[i0]!) * (px[i1 + 1]! - px[i0 + 1]!)) / 2;
  }
  return a;
}

describe('wreckPieceMeshes — texture continuity (S3)', () => {
  const pieces = rebuildWreckPieces(DESC);
  const L = layoutFor(pieces);

  it('UVs are the hull-local positions mapped into the parent texture rect', () => {
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    for (const p of pieces) {
      const meshes = wreckPieceMeshes(p, L);
      expect(meshes.length, `piece ${p.index} has geometry`).toBeGreaterThan(0);
      for (const m of meshes) {
        expect(m.uvs.length).toBe(m.positions.length);
        for (let i = 0; i < m.positions.length; i += 2) {
          // Positions are body-local, Pixi-down (x, −y) about the centroid.
          const hx = m.positions[i]! + p.cx;
          const hy = -m.positions[i + 1]! + p.cy;
          const [u, v] = expectedUv(hx, hy, L, m.tile);
          expect(m.uvs[i]!).toBeCloseTo(u, 5);
          expect(m.uvs[i + 1]!).toBeCloseTo(v, 5);
          // Inside the tile's texture rect (the art covers the hull).
          expect(m.uvs[i]!).toBeGreaterThanOrEqual(-1e-6);
          expect(m.uvs[i]!).toBeLessThanOrEqual(1 + 1e-6);
          expect(m.uvs[i + 1]!).toBeGreaterThanOrEqual(-1e-6);
          expect(m.uvs[i + 1]!).toBeLessThanOrEqual(1 + 1e-6);
        }
      }
    }
  });

  it('the tile meshes tile the piece exactly (area), split across tile seams', () => {
    let crossed = 0;
    for (const p of pieces) {
      const meshes = wreckPieceMeshes(p, L);
      if (meshes.length > 1) crossed++;
      let a = 0;
      for (const m of meshes) a += triArea(m.positions, m.indices);
      expect(a).toBeCloseTo(p.area, -1);
      expect(Math.abs(a - p.area) / p.area).toBeLessThan(1e-3);
    }
    expect(crossed, 'some piece straddles a tile seam').toBeGreaterThan(0);
  });

  it('neighbouring pieces share edge UVs (the jigsaw fits)', () => {
    // Every vertex keyed by its hull-local point (1/8 u) and tile.
    const seen = new Map<string, { piece: number; u: number; v: number }>();
    let shared = 0;
    for (const p of pieces) {
      for (const m of wreckPieceMeshes(p, L)) {
        for (let i = 0; i < m.positions.length; i += 2) {
          const hx = m.positions[i]! + p.cx;
          const hy = -m.positions[i + 1]! + p.cy;
          const key = `${m.tile}:${Math.round(hx * 8)}:${Math.round(hy * 8)}`;
          const prev = seen.get(key);
          if (prev === undefined) { seen.set(key, { piece: p.index, u: m.uvs[i]!, v: m.uvs[i + 1]! }); continue; }
          if (prev.piece === p.index) continue;
          shared++;
          expect(m.uvs[i]!).toBeCloseTo(prev.u, 4);
          expect(m.uvs[i + 1]!).toBeCloseTo(prev.v, 4);
        }
      }
    }
    expect(shared, 'pieces share cut-edge vertices').toBeGreaterThan(10);
  });
});

describe('wreckGlowAt — molten cut edges cool to dark (S3)', () => {
  const g = { color: 0, alpha: 0 };
  const rgb = (c: number): [number, number, number] => [(c >> 16) & 255, (c >> 8) & 255, c & 255];

  it('hot at the moment of death: bright, opaque, orange-white', () => {
    wreckGlowAt(0, g);
    const [r, gg, b] = rgb(g.color);
    expect(g.alpha).toBeGreaterThan(0.95);
    expect(r).toBeGreaterThan(0xf0);
    expect(gg).toBeGreaterThan(0xa0);
    expect(r).toBeGreaterThan(b);
  });

  it('bright for about a second (money-shot review timing)', () => {
    wreckGlowAt(0.9, g);
    const [r, gg] = rgb(g.color);
    expect(g.alpha).toBeGreaterThan(0.85);
    expect(r).toBeGreaterThan(0xe0);
    expect(gg).toBeGreaterThan(0x60);
  });

  it('no longer bright orange at 4.5 s (review: "still bright orange at 4.5 s")', () => {
    wreckGlowAt(4.5, g);
    const [r, gg] = rgb(g.color);
    expect(g.alpha * r, 'faint, dark red').toBeLessThan(0.3 * 255);
    expect(gg).toBeLessThan(0x30);
  });

  it('a dull ember at ~3 s: red, dimmer, still showing', () => {
    expect(WRECK_GLOW_EMBER_S).toBeGreaterThanOrEqual(2.5);
    expect(WRECK_GLOW_EMBER_S).toBeLessThanOrEqual(3.5);
    expect(WRECK_GLOW_END_S, 'dark by ~6 s').toBeLessThanOrEqual(6.5);
    wreckGlowAt(WRECK_GLOW_EMBER_S, g);
    const [r, gg, b] = rgb(g.color);
    expect(g.alpha).toBeGreaterThan(0.2);
    expect(g.alpha).toBeLessThan(0.85);
    expect(r).toBeLessThan(0xd0);
    expect(r).toBeGreaterThan(gg * 2);
    expect(r).toBeGreaterThan(b * 2);
  });

  it('dark at the end, and stays dark for ever', () => {
    for (const t of [WRECK_GLOW_END_S, WRECK_GLOW_END_S + 1, 600, Infinity]) {
      wreckGlowAt(t, g);
      expect(g.alpha, `t=${t}`).toBe(0);
    }
  });

  it('cools monotonically (never re-brightens)', () => {
    let prev = Infinity;
    for (let t = 0; t <= WRECK_GLOW_END_S; t += 0.1) {
      wreckGlowAt(t, g);
      const [r, gg, b] = rgb(g.color);
      const lum = (r + gg + b) * g.alpha;
      expect(lum).toBeLessThanOrEqual(prev + 1e-9);
      prev = lum;
    }
  });

  it('cut edges only: the glow runs cover exactly the flagged edges', () => {
    const flags = [false, true, true, false, false, true, false, true];
    const runs = cutEdgeRuns(flags);
    const covered = new Array(flags.length).fill(false);
    for (const [start, len] of runs) for (let k = 0; k < len; k++) covered[(start + k) % flags.length] = true;
    expect(covered).toEqual(flags);
    expect(cutEdgeRuns([false, false, false])).toEqual([]);
    // A run that wraps round the end joins into one polyline.
    expect(cutEdgeRuns([true, false, true, true])).toEqual([[2, 3]]);
    // Every real piece has both cut and uncut edges (a battleship hull piece).
    for (const p of rebuildWreckPieces(DESC)) {
      const n = cutEdgeRuns(p.cutEdges).reduce((s, [, len]) => s + len, 0);
      expect(n).toBe(p.cutEdges.filter(Boolean).length);
    }
  });
});

describe('wreckBlasts: the break-up explosion at the kill point (money-shot review)', () => {
  it('fireballs at the kill point, sized by the hull, never covering the hull', () => {
    // Review: "a large flat white translucent disc plus a grey halo covers
    // the mid-hull". FxExplosions draws radius r as a 2r fireball under a
    // soft 3.4r glow: everything stays within 0.25 of the wreck radius.
    for (const R of [2200, 2900, 600]) {
      const out: WreckBlast[] = [];
      const n = wreckBlasts(1000, -500, R, 12345, out);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(out[0]!.x).toBe(1000);
      expect(out[0]!.y).toBe(-500);
      for (let i = 0; i < n; i++) {
        const b = out[i]!;
        const reach = Math.hypot(b.x - 1000, b.y + 500) + 1.7 * b.r;
        expect(reach, `blast ${i} at R=${R}`).toBeLessThan(0.25 * R);
        expect(b.r, 'scales with the hull (#18)').toBeGreaterThan(0.05 * R);
      }
    }
  });

  it('deterministic per seed; directions differ between seeds', () => {
    const a: WreckBlast[] = [];
    const b: WreckBlast[] = [];
    const c: WreckBlast[] = [];
    wreckBlasts(0, 0, 2000, 7, a);
    wreckBlasts(0, 0, 2000, 7, b);
    wreckBlasts(0, 0, 2000, 99999, c);
    expect(a).toEqual(b);
    expect(a[1]!.x).not.toBeCloseTo(c[1]!.x);
  });
});
