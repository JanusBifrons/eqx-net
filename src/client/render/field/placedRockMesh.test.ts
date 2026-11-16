/**
 * Placed rocks and their cut pieces draw with the field rock shader: the
 * same per-vertex data as a cut-field rock (`buildFieldChunkMesh`), aUV.y
 * (far-zoom thinning) 0, and every piece vertex in its root rock's rest frame
 * (aLocal, aRock and the dome parameter aUV.x exactly as the uncut fan had
 * them there), so the surface does not swim when the rock splits.
 */
import { describe, expect, it, vi } from 'vitest';

// A GL program needs a canvas; node has none (the look is checked in stills).
vi.mock('./fieldRockShader', () => ({
  fieldRockProgram: () => ({}),
  fieldRockShaderResources: () => ({}),
  setFieldRockView: () => {},
  setFieldOreStyle: () => {},
}));
import { generateAsteroidVertices } from '../../../core/swarm/asteroidShape';
import { rebuildWreckPieces } from '../../net/wreckGeometryStore';
import { FRACTURE_ALGO_VERSION } from '../../../core/destruction/fractureHull';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor, type WreckRockRef } from '../../../shared-types/messages/wreckDescriptor';
import { CutFieldLayer, isFieldRockMesh } from './CutFieldLayer';
import { PLACED_ROCK_ORE, placedRockMeshData, rockPieceMeshData } from './placedRockMesh';

const ROCK: WreckRockRef = { id: 'rock-17', shape: 4242, r: 160, res: 'crystal' };
const LOOK = { shape: ROCK.shape, r: ROCK.r, res: ROCK.res };

function desc(cutKind?: 'slice'): WreckDescriptor {
  return {
    wreckId: 9, parentKind: WRECK_ROCK_PARENT_KIND, seed: 1234, killX: 5, killY: -8,
    killBlowDamage: 2, recentDamageRate: 1, snapChance: 0.2, algoVersion: FRACTURE_ALGO_VERSION,
    deathTick: 1, rock: ROCK, ...(cutKind ? { cutKind, cutAng: 0.3, cutW: 4 } : {}),
  };
}

/** The uncut fan's dome parameter at rest-frame point (x, y) (math-up),
 *  worked out independently: 1 - |p - m| / |hit - m| along the ray from the
 *  vertex mean m through p to the outline. */
function fanT(x: number, y: number): number {
  const o = generateAsteroidVertices(ROCK.shape, ROCK.r);
  let mx = 0, my = 0;
  for (const v of o) { mx += v.x; my += v.y; }
  mx /= o.length; my /= o.length;
  const dx = x - mx, dy = y - my, d = Math.hypot(dx, dy);
  if (d < 1e-9) return 1;
  const ux = dx / d, uy = dy / d;
  let best = Infinity;
  for (let i = 0; i < o.length; i++) {
    const a = o[i]!, b = o[(i + 1) % o.length]!;
    const ex = b.x - a.x, ey = b.y - a.y;
    const den = ux * ey - uy * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((a.x - mx) * ey - (a.y - my) * ex) / den;
    const s = ((a.x - mx) * uy - (a.y - my) * ux) / den;
    if (t > 0 && s >= -1e-9 && s <= 1 + 1e-9) best = Math.min(best, t);
  }
  return 1 - d / best;
}

function triArea(pos: Float32Array, idx: Uint32Array): number {
  let a = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const i = idx[t]! * 2, j = idx[t + 1]! * 2, k = idx[t + 2]! * 2;
    a += Math.abs((pos[j]! - pos[i]!) * (pos[k + 1]! - pos[i + 1]!) - (pos[k]! - pos[i]!) * (pos[j + 1]! - pos[i + 1]!)) / 2;
  }
  return a;
}

describe('placed rocks draw with the field rock shader', () => {
  it('a placed rock is a field fan of its own outline, body frame, aUV.y 0, ore from its resource', () => {
    const d = placedRockMeshData(LOOK);
    const o = generateAsteroidVertices(ROCK.shape, ROCK.r);
    expect(d.positions.length / 2).toBe(o.length + 1);
    // Outline vertices sit where the collider's are (Pixi y flips).
    for (let k = 0; k < o.length; k++) {
      expect(d.positions[(k + 1) * 2]).toBeCloseTo(o[k]!.x, 4);
      expect(d.positions[(k + 1) * 2 + 1]).toBeCloseTo(-o[k]!.y, 4);
    }
    for (let v = 0; v < d.uvs.length / 2; v++) {
      expect(d.uvs[v * 2 + 1]).toBe(0);
      expect(d.local[v * 2]).toBeCloseTo(d.positions[v * 2]! - d.positions[0]!, 4);
      expect(d.local[v * 2 + 1]).toBeCloseTo(d.positions[v * 2 + 1]! - d.positions[1]!, 4);
      expect([d.ore[v * 2], d.ore[v * 2 + 1]]).toEqual([0, Math.fround(PLACED_ROCK_ORE)]);
    }
    // The same rock always has the same surface; another shape another.
    expect(Array.from(placedRockMeshData(LOOK).rock)).toEqual(Array.from(d.rock));
    expect(placedRockMeshData({ ...LOOK, shape: 4243 }).rock[3]).not.toBe(d.rock[3]);
    expect(Array.from(placedRockMeshData({ ...LOOK, res: undefined }).ore).every((x) => x === 0)).toBe(true);
  });

  for (const cut of [undefined, 'slice'] as const) {
    it(`every ${cut ?? 'natural'}-break piece keeps the rock's rest frame (no swim), aUV.y 0, and covers exactly its own parts`, () => {
      const rock = placedRockMeshData(LOOK);
      const pieces = rebuildWreckPieces(desc(cut));
      expect(pieces.length).toBeGreaterThan(1);
      for (const g of pieces) {
        const d = rockPieceMeshData(g, LOOK);
        expect(d.indices.length).toBeGreaterThan(0);
        for (let v = 0; v < d.positions.length / 2; v++) {
          // Rest-frame point (math-up) of this piece-local vertex.
          const x = d.positions[v * 2]! + g.cx, y = -d.positions[v * 2 + 1]! + g.cy;
          expect(d.local[v * 2]).toBeCloseTo(x - rock.positions[0]!, 3);
          expect(d.local[v * 2 + 1]).toBeCloseTo(-y - rock.positions[1]!, 3);
          expect(d.uvs[v * 2]).toBeCloseTo(fanT(x, y), 3);
          expect(d.uvs[v * 2 + 1]).toBe(0);
          for (let c = 0; c < 4; c++) expect(d.rock[v * 4 + c]).toBe(rock.rock[c]);
          expect(d.ore[v * 2 + 1]).toBe(rock.ore[1]);
        }
        // Clipped to the fan's wedges, nothing of the piece is lost or added.
        let parts = 0;
        for (const p of g.parts) for (let i = 0; i < p.length; i++) {
          const a = p[i]!, b = p[(i + 1) % p.length]!;
          parts += (a.x * b.y - b.x * a.y) / 2;
        }
        expect(Math.abs(triArea(d.positions, d.indices) - Math.abs(parts)) / Math.abs(parts)).toBeLessThan(1e-3); // float32 positions, hull rounding
      }
    });
  }

  it('the layer builds them on its one shader, marked as field rock meshes', () => {
    const layer = new CutFieldLayer();
    const a = layer.buildRockMesh(placedRockMeshData(LOOK));
    const b = layer.buildRockMesh(rockPieceMeshData(rebuildWreckPieces(desc())[0]!, LOOK));
    expect(a.shader).toBe(b.shader);
    expect(isFieldRockMesh(a) && isFieldRockMesh(b)).toBe(true);
    expect(a.geometry.getBuffer('aLocal')).toBeDefined();
    a.destroy();
    b.destroy();
  });
});
