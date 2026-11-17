/**
 * Placed rocks (a room's single rocks, kind 0 without a field key) and their
 * cut pieces, drawn with the field rock shader (`fieldRockShader.ts`): the
 * same fan data `buildFieldChunkMesh` makes for a cut-field rock, built once
 * per sprite (#14), never per frame. `CutFieldLayer` wraps them in meshes on
 * its one shader instance.
 *
 * A placed rock is its `generateAsteroidVertices` outline (body frame, centred
 * at the origin), surface-seeded from its shape seed, so the same rock always
 * shows the same surface. Its resource (`ice` / `crystal`) is a uniform ore
 * concentration over the rock, read by the same `?ore=` look (veins default).
 *
 * A cut piece keeps every vertex in its ROOT rock's rest frame: `aLocal` is
 * the offset from the rock's fan centre, `aRock` the rock's radius and seed,
 * and the dome parameter (`aUV.x`) the value the uncut fan had there. The
 * piece's convex parts are clipped against each fan wedge of the rock, so
 * `aUV.x` stays exact (it is affine only inside one wedge), and the surface
 * does not swim when the rock splits. `aUV.y` (far-zoom thinning) stays 0.
 */
import { generateAsteroidVertices, type Vec2 } from '../../../core/swarm/asteroidShape';
import { buildFieldChunkMesh, type FieldChunkMeshData } from './CutFieldLayer';

/** A placed rock's ore concentration for its resource (a rich pocket's peak). */
export const PLACED_ROCK_ORE = 0.7;

/** The rock a placed rock or a cut piece shows: its shape, radius, resource. */
export interface PlacedRockLook { shape: number; r: number; res?: string | undefined }

/** A piece of a cut rock: centre in the root rock's rest frame (math-up) and
 *  its convex parts, piece-local math-up (`WreckPieceGeometry`). */
export interface RockPieceShape { cx: number; cy: number; parts: readonly (readonly Vec2[])[] }

/** A rock's surface seed from its shape seed (mixed so near seeds differ). */
export function placedRockSeed(shape: number): number {
  let h = Math.imul((shape | 0) + 0x632be5ab, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  return (h ^ (h >>> 13)) >>> 0;
}

function oreOf(res: string | undefined): [number, number] {
  return res === 'ice' ? [PLACED_ROCK_ORE, 0] : res === 'crystal' ? [0, PLACED_ROCK_ORE] : [0, 0];
}

/** The rock's outline packed as one field outline: [n, x0, y0, ...] (math-up). */
function packedOutline(look: PlacedRockLook): Float32Array {
  const verts = generateAsteroidVertices(look.shape, look.r);
  const o = new Float32Array(1 + verts.length * 2);
  o[0] = verts.length;
  for (let k = 0; k < verts.length; k++) { o[1 + k * 2] = verts[k]!.x; o[2 + k * 2] = verts[k]!.y; }
  return o;
}

/** A placed rock's fan, body frame (Pixi-down positions, centred on the body
 *  origin). */
export function placedRockMeshData(look: PlacedRockLook): FieldChunkMeshData {
  const outline = packedOutline(look);
  const n = outline[0]!;
  const [ice, cry] = oreOf(look.res);
  const ore = new Float32Array((n + 1) * 2);
  for (let v = 0; v <= n; v++) { ore[v * 2] = ice; ore[v * 2 + 1] = cry; }
  return buildFieldChunkMesh(outline, ore, placedRockSeed(look.shape));
}

/** Clip convex polygon `poly` (flat x,y) to the left of a→b (CCW wedge edge). */
function clipLeft(poly: number[], ax: number, ay: number, bx: number, by: number): number[] {
  const out: number[] = [];
  const n = poly.length / 2;
  const ex = bx - ax, ey = by - ay;
  for (let i = 0; i < n; i++) {
    const px = poly[i * 2]!, py = poly[i * 2 + 1]!;
    const j = (i + 1) % n;
    const qx = poly[j * 2]!, qy = poly[j * 2 + 1]!;
    const dp = ex * (py - ay) - ey * (px - ax), dq = ex * (qy - ay) - ey * (qx - ax);
    if (dp >= 0) out.push(px, py);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push(px + (qx - px) * t, py + (qy - py) * t);
    }
  }
  return out;
}

/**
 * A cut piece of `look`'s rock: the piece's parts clipped to the rock's fan
 * wedges, positions piece-local (Pixi-down, piece centre at the origin), every
 * other attribute in the rock's rest frame, exactly as the uncut rock's fan
 * had it. Built once per piece.
 */
export function rockPieceMeshData(piece: RockPieceShape, look: PlacedRockLook): FieldChunkMeshData {
  const rock = placedRockMeshData(look);
  // The rock's fan: centre (vertex 0) then the outline, in Pixi-down rest frame.
  const rp = rock.positions, n = rp.length / 2 - 1;
  const mx = rp[0]!, my = rp[1]!;
  const ra = [rock.rock[0]!, rock.rock[1]!, rock.rock[2]!, rock.rock[3]!];
  const oi = rock.ore[0]!, oc = rock.ore[1]!;
  const pos: number[] = [], loc: number[] = [], vt: number[] = [], idx: number[] = [];
  for (const part of piece.parts) {
    if (part.length < 3) continue;
    // The part in the rock's rest frame, math-up (CCW).
    const base: number[] = [];
    for (const q of part) base.push(q.x + piece.cx, q.y + piece.cy);
    for (let k = 0; k < n; k++) {
      // Wedge (centre, o_k, o_k+1) in math-up (Pixi y flipped back): CCW.
      const cx = mx, cy = -my;
      const ax = rp[(1 + k) * 2]!, ay = -rp[(1 + k) * 2 + 1]!;
      const k1 = 1 + ((k + 1) % n);
      const bx = rp[k1 * 2]!, by = -rp[k1 * 2 + 1]!;
      let poly = clipLeft(base, cx, cy, ax, ay);
      if (poly.length >= 6) poly = clipLeft(poly, ax, ay, bx, by);
      if (poly.length >= 6) poly = clipLeft(poly, bx, by, cx, cy);
      if (poly.length < 6) continue;
      // Barycentric weight of the centre: the fan's dome parameter (aUV.x).
      const det = (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
      if (Math.abs(det) < 1e-9) continue;
      const v0 = pos.length / 2;
      for (let i = 0; i < poly.length; i += 2) {
        const x = poly[i]!, y = poly[i + 1]!;
        const wa = ((x - cx) * (by - cy) - (bx - cx) * (y - cy)) / det;
        const wb = ((ax - cx) * (y - cy) - (x - cx) * (ay - cy)) / det;
        pos.push(x - piece.cx, -(y - piece.cy));
        loc.push(x - mx, -y - my);
        vt.push(Math.min(1, Math.max(0, 1 - wa - wb)));
      }
      for (let i = 1; i < poly.length / 2 - 1; i++) idx.push(v0, v0 + i, v0 + i + 1);
    }
  }
  const nv = pos.length / 2;
  const uvs = new Float32Array(nv * 2), rockA = new Float32Array(nv * 4), ore = new Float32Array(nv * 2);
  for (let v = 0; v < nv; v++) {
    uvs[v * 2] = vt[v]!; // aUV.y stays 0: no far-zoom thinning
    rockA[v * 4] = ra[0]!; rockA[v * 4 + 1] = ra[1]!; rockA[v * 4 + 2] = ra[2]!; rockA[v * 4 + 3] = ra[3]!;
    ore[v * 2] = oi; ore[v * 2 + 1] = oc;
  }
  return {
    positions: new Float32Array(pos), uvs, local: new Float32Array(loc), rock: rockA, ore, indices: new Uint32Array(idx),
  };
}
