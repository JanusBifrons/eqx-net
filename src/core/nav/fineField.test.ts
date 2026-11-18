import { describe, it, expect } from 'vitest';
import { FineFieldLayer, FINE_NAV_PAD, FINE_NAV_REACH, FINE_NAV_SIDE } from './fineField.js';
import { ClearanceGrid } from './clearance.js';
import { CHUNK_SIZE, rocksInChunk, type ChunkOpts } from '../terrain/fieldLayout.js';
import { fieldRockBody } from '../terrain/chunkStreamer.js';
import { rockObstacleParts, type GridObstacle } from '../structures/Grid.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

const opts: ChunkOpts = {
  seed: 'look', battleshipLength: getShipKind('battleship').radius * 2, fighterLength: getShipKind('fighter').radius * 2,
};

/** Every rock of a block of chunks as obstacles (the reference). */
function rocksAround(cx0: number, cy0: number, cx1: number, cy1: number, skip = new Set<number>()): Array<GridObstacle & { key: number }> {
  const out: Array<GridObstacle & { key: number }> = [];
  for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) {
    for (const r of rocksInChunk(opts, cx, cy)) {
      if (skip.has(r.key)) continue;
      const b = fieldRockBody(r);
      out.push({ key: r.key, x: b.x, y: b.y, radius: b.radius, angle: 0, parts: rockObstacleParts(b.verts, b.parts, true) });
    }
  }
  return out;
}

/** A busy chunk inside the field, off the lanes. */
function busyChunk(): { cx: number; cy: number } {
  for (let cx = 6; cx < 30; cx++) {
    const n = rocksInChunk(opts, cx, 3).length;
    if (n > 80) return { cx, cy: 3 };
  }
  throw new Error('no busy chunk');
}

describe('FineFieldLayer (per-chunk clearance from the cut rocks)', () => {
  it('matches one big grid over the chunk and its neighbours, rocks over the border included', () => {
    const { cx, cy } = busyChunk();
    const f = new FineFieldLayer(opts);
    f.chunkLoaded(cx, cy);
    // Reference: one grid over 3×3 chunks, every rock in them.
    const ref = new ClearanceGrid(), cell = 64;
    ref.build((cx - 1) * CHUNK_SIZE, (cy - 1) * CHUNK_SIZE, 3 * CHUNK_SIZE / cell, 3 * CHUNK_SIZE / cell, cell, rocksAround(cx - 1, cy - 1, cx + 1, cy + 1), FINE_NAV_PAD);
    let blocked = 0, checked = 0;
    for (let y = 0; y < CHUNK_SIZE; y += cell) for (let x = 0; x < CHUNK_SIZE; x += cell) {
      const wx = cx * CHUNK_SIZE + x + cell / 2, wy = cy * CHUNK_SIZE + y + cell / 2;
      const want = Math.min(ref.at(wx, wy), FINE_NAV_REACH), got = f.clearanceAt(wx, wy);
      // Exact wherever the true clearance is inside the reach (a nearer rock is always in the grid).
      if (want < FINE_NAV_REACH) expect(got).toBeCloseTo(want, 2);
      else expect(got).toBe(FINE_NAV_REACH);
      if (got === 0) blocked++;
      checked++;
    }
    expect(checked).toBe(64 * 64);
    expect(blocked).toBeGreaterThan(100);
    expect(f.clearanceAt(cx * CHUNK_SIZE - 10, cy * CHUNK_SIZE + 10)).toBe(-1); // the neighbour is not loaded
  });

  it('a broken-up rock rebuilds only the loaded chunks it reaches (count gate) and opens its spot', () => {
    const { cx, cy } = busyChunk();
    const f = new FineFieldLayer(opts);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) f.chunkLoaded(cx + dx, cy + dy);
    const rocks = rocksAround(cx, cy, cx, cy);
    // The biggest rock away from the chunk's edges reaches only its own chunk's grid.
    const inner = rocks.filter((r) => {
      const lx = r.x - cx * CHUNK_SIZE, ly = r.y - cy * CHUNK_SIZE;
      return Math.min(lx, ly, CHUNK_SIZE - lx, CHUNK_SIZE - ly) > r.radius + FINE_NAV_REACH;
    }).sort((a, b) => b.radius - a.radius)[0]!;
    expect(f.clearanceAt(inner.x, inner.y)).toBe(0);
    const before = f.cellsRebuilt;
    f.rockGone(inner.key);
    expect(f.cellsRebuilt - before).toBe(FINE_NAV_SIDE * FINE_NAV_SIDE); // one chunk, not nine
    // Same as a grid built without it.
    const ref = new ClearanceGrid();
    ref.build((cx - 1) * CHUNK_SIZE, (cy - 1) * CHUNK_SIZE, 192, 192, 64, rocksAround(cx - 1, cy - 1, cx + 1, cy + 1, new Set([inner.key])), FINE_NAV_PAD);
    expect(f.clearanceAt(inner.x, inner.y)).toBeCloseTo(Math.min(ref.at(inner.x, inner.y), FINE_NAV_REACH), 2);
    f.rockGone(inner.key); // twice: no work
    expect(f.cellsRebuilt - before).toBe(FINE_NAV_SIDE * FINE_NAV_SIDE);
  });

  it('a moved rock blocks where it rests, not where it was cut; a gone rock stays gone after a re-load', () => {
    const { cx, cy } = busyChunk();
    const rock = rocksAround(cx, cy, cx, cy).sort((a, b) => b.radius - a.radius)[0]!;
    const f = new FineFieldLayer(opts);
    f.chunkLoaded(cx, cy);
    const to = { key: rock.key, x: rock.x + 1500, y: rock.y + 700, angle: 1 };
    f.rockMoved(to.key, to);
    expect(f.clearanceAt(to.x, to.y)).toBe(0);
    f.rockMoved(to.key, null); // back home
    expect(f.clearanceAt(rock.x, rock.y)).toBe(0);
    const fresh = new FineFieldLayer(opts);
    fresh.chunkLoaded(cx, cy);
    expect(f.clearanceAt(to.x, to.y)).toBe(fresh.clearanceAt(to.x, to.y)); // the spot it left is as cut
    f.rockMoved(to.key, to);
    // Known before load: starts where it was left.
    const g = new FineFieldLayer(opts, [], [to]);
    g.chunkLoaded(cx, cy);
    expect(g.clearanceAt(to.x, to.y)).toBe(0);
    // Gone before load: never blocks.
    const h = new FineFieldLayer(opts, [rock.key]);
    h.chunkLoaded(cx, cy);
    f.rockGone(rock.key);
    expect(h.clearanceAt(rock.x, rock.y)).toBe(f.clearanceAt(rock.x, rock.y));
    f.chunkUnloaded(cx, cy);
    f.chunkLoaded(cx, cy);
    expect(f.clearanceAt(rock.x, rock.y)).toBe(h.clearanceAt(rock.x, rock.y));
  });

  it('unloading frees the grid and the cut rocks nothing needs; reuses grids (prints ms per chunk)', () => {
    const { cx, cy } = busyChunk();
    const f = new FineFieldLayer(opts);
    f.chunkLoaded(cx, cy);
    f.chunkLoaded(cx + 1, cy);
    expect(f.liveCount).toBe(2);
    expect(f.cutCount).toBe(12); // 3×4 block of chunks around the two
    f.chunkUnloaded(cx, cy);
    expect(f.clearanceAt(cx * CHUNK_SIZE + 5, cy * CHUNK_SIZE + 5)).toBe(-1);
    expect(f.cutCount).toBe(9);
    f.chunkUnloaded(cx + 1, cy);
    expect(f.cutCount).toBe(0);
    // Build time: a chunk whose rocks are already cut (re-cut is the field's own cost).
    const g = new FineFieldLayer(opts);
    g.chunkLoaded(cx, cy);
    const runs = 20, t0 = performance.now();
    for (let k = 0; k < runs; k++) { g.chunkUnloaded(cx, cy); g.chunkLoaded(cx, cy); }
    const ms = (performance.now() - t0) / runs;
    console.log(`[nav fine] chunk ${cx},${cy}: ${FINE_NAV_SIDE}x${FINE_NAV_SIDE} cells, ${(FINE_NAV_SIDE ** 2 * 4 / 1024).toFixed(0)} KB, ` +
      `cut+build ${ms.toFixed(1)} ms (9 chunks cut each time)`);
  });
});
