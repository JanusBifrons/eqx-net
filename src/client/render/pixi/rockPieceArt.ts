/**
 * Rock cut (salvage stream): the art of one piece of a cut rock. A rock's
 * wreck has no ship art (its parent kind is `WRECK_ROCK_PARENT_KIND`, not a
 * ship kind), so each piece shows its own stretch of the art the uncut rock
 * drew (`rockPieceLook`): the Machined rock bake of its shape, radius and
 * resource (`rockHandleFor`, the same handle key the uncut rock used, so an
 * already baked rock is reused) once ready, else the plain asteroid polygon
 * in the resource's classic tint, as the uncut rock. Every piece of a rock
 * (and of its re-cuts: all share the root rock's rest frame) samples the one
 * rock where it came from, so the pieces tile the original exactly and keep
 * its colour.
 *
 * No mask (a stencil mask per piece breaks the batch: 3 draw calls a piece):
 *  - Machined bake: one `Mesh` of the piece's convex parts, textured with
 *    the rock's bake via UVs from the piece's place in the rock's rest frame
 *    (as baked ship wreck pieces do, `wreckPieceMeshes`). Batch mode, so
 *    every piece of every rock on one atlas page joins one draw call.
 *  - GPU-lit bake: one `LitShipMesh` with the piece's geometry (as lit ship
 *    wreck tiles do, `litPieceGeometry`).
 *  - Plain look: the piece outline filled in the asteroid colour, with the
 *    rock's outline stroke (inner half, as the mask showed it) on its hull
 *    edges only. A `Graphics`, which batches.
 *
 * Built once per piece (the swarm updater's create path, and once more when
 * the Machined bake becomes ready), never per frame (#14); the geometry is
 * freed with the piece. The result is handed to `WreckPieceSprite` as its
 * art, so the piece keeps the wreck cut-edge glow, hit flash and far-zoom
 * speck.
 */
import { Container, Geometry, Graphics, Mesh, MeshGeometry, type DestroyOptions } from 'pixi.js';
import { EDGE_HULL } from '../../../core/destruction/fractureHull.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieceFrame.js';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor, type WreckRockRef } from '../../../shared-types/messages/wreckDescriptor.js';
import type { ArtHandle, StructArt } from '../art/ArtService.js';
import { LitShipMesh } from '../art/litShipShader.js';
import { litPass } from '../art/litPass.js';
import { ASTEROID_COLOR, ASTEROID_OUTLINE } from './spriteBuilders.js';

/** A classic (non-Machined) rock's resource tint: ice and crystal-veined
 *  rocks read apart from plain rock (the Machined rock bakes its colour). */
export function classicRockTint(resource: string | undefined): number | undefined {
  return resource === 'ice' ? 0xa8dcff : resource === 'crystal' ? 0xd2a8ff : undefined;
}

/** How a rock's piece looks: the uncut rock's art key (`resource`, as the
 *  uncut rock's `asteroidResource`: absent for plain rock) and its classic
 *  tint (white for plain rock). */
export function rockPieceLook(rock: WreckRockRef): { resource: string | undefined; tint: number } {
  return { resource: rock.res, tint: classicRockTint(rock.res) ?? 0xffffff };
}

/** The far-zoom speck colour of a rock's piece: the rock's colour. */
export function rockPieceSpeckColor(rock: WreckRockRef): number {
  const t = rockPieceLook(rock).tint;
  return ((((ASTEROID_COLOR >> 16) & 255) * ((t >> 16) & 255) / 255) << 16)
    | ((((ASTEROID_COLOR >> 8) & 255) * ((t >> 8) & 255) / 255) << 8)
    | (((ASTEROID_COLOR & 255) * (t & 255)) / 255);
}

/** A rock piece's art holder: which Machined bake it shows (null: the plain
 *  polygon), so the updater swaps it once the bake is ready. Frees its mesh
 *  geometry with it (a `Mesh` never destroys its geometry). */
export class RockPieceArt extends Container {
  /** The piece mesh's own geometry (null: the plain polygon). */
  geom: Geometry | null = null;

  constructor(readonly rock: WreckRockRef, readonly struct: StructArt | null, readonly lit: boolean) {
    super();
  }

  override destroy(options?: DestroyOptions): void {
    const g = this.geom;
    this.geom = null;
    super.destroy(options);
    g?.destroy();
  }
}

/** The plain rock's outline stroke width (`buildAsteroidGfx`). */
const OUTLINE_W = 1.5;

/** The piece's triangles (a fan per convex part), body-local Pixi-down. */
function pieceTriangles(parts: WreckPieceGeometry['parts']): { pos: Float32Array; idx: Uint32Array } {
  let nv = 0, nt = 0;
  for (const p of parts) { nv += p.length; nt += Math.max(0, p.length - 2); }
  const pos = new Float32Array(nv * 2);
  const idx = new Uint32Array(nt * 3);
  let v = 0, t = 0;
  for (const p of parts) {
    const base = v;
    for (const q of p) { pos[v * 2] = q.x; pos[v * 2 + 1] = -q.y; v++; }
    for (let i = 1; i < p.length - 1; i++) { idx[t++] = base; idx[t++] = base + i; idx[t++] = base + i + 1; }
  }
  return { pos, idx };
}

/** The plain look: the piece outline in the asteroid colour, with the
 *  rock's outline stroke inside its hull edges (the half the old mask kept). */
function plainPieceGfx(g: Pick<WreckPieceGeometry, 'outline' | 'cutEdges'>): Graphics {
  const gfx = new Graphics();
  const o = g.outline, n = o.length;
  const pts: number[] = [];
  for (const v of o) pts.push(v.x, -v.y);
  gfx.poly(pts).fill({ color: ASTEROID_COLOR });
  const h = OUTLINE_W / 2;
  for (let i = 0; i < n; i++) {
    if (g.cutEdges[i] !== EDGE_HULL) continue;
    const a = o[i]!, b = o[(i + 1) % n]!;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    // Inward normal of a CCW (math-up) outline: the left of each edge.
    const nx = (-dy / len) * h, ny = (dx / len) * h;
    gfx.poly([a.x, -a.y, b.x, -b.y, b.x + nx, -(b.y + ny), a.x + nx, -(a.y + ny)]).fill({ color: ASTEROID_OUTLINE });
  }
  return gfx;
}

/** The art of a rock's wreck piece `g`, cut from `rock`: a container (piece
 *  body frame, Pixi-down) holding one mesh of the piece on the rock's art.
 *  `handle`: the rock's Machined bake (`rockHandleFor`), used once ready. */
export function buildRockPieceArt(
  g: Pick<WreckPieceGeometry, 'cx' | 'cy' | 'outline' | 'parts' | 'cutEdges'>, rock: WreckRockRef, handle: ArtHandle | null = null,
): RockPieceArt {
  const struct = handle !== null && handle.state === 'ready' ? handle.struct : null;
  const settings = litPass.settings;
  if (struct === null) {
    const c = new RockPieceArt(rock, null, false);
    const gfx = plainPieceGfx(g);
    gfx.tint = rockPieceLook(rock).tint;
    c.addChild(gfx);
    return c;
  }
  const { pos, idx } = pieceTriangles(g.parts);
  const uvs = new Float32Array(pos.length);
  const tex = struct.tex, f = tex.frame;
  if (struct.lit && settings) {
    // GPU-lit: the lit shader lights in the rock's frame (rock centre at 0,
    // world units) and samples the data page directly (`litPieceGeometry`).
    const l = struct.lit;
    const PW = tex.source.width, PH = tex.source.height;
    for (let i = 0; i < pos.length; i += 2) {
      const x = pos[i]! + g.cx, y = pos[i + 1]! - g.cy;
      pos[i] = x; pos[i + 1] = y;
      uvs[i] = (f.x + x * l.ppu + l.w / 2) / PW;
      uvs[i + 1] = (f.y + y * l.ppu + l.h / 2) / PH;
    }
    const geom = new Geometry({ attributes: { aPosition: pos, aUV: uvs }, indexBuffer: idx });
    const mesh = new LitShipMesh({ tex, w: l.w, rows: l.h, y0: 0, hullH: l.h, ppu: l.ppu, maxH: l.maxH, emisMax: l.emisMax }, settings);
    mesh.geometry = geom;
    mesh.position.set(-g.cx, g.cy); // the rock's centre in the piece frame
    const c = new RockPieceArt(rock, struct, true);
    c.geom = geom;
    c.addChild(mesh);
    litPass.register(mesh);
    return c;
  }
  // Baked: the bake is drawn centred at 1/density world units per texel, so
  // a point (x, y) of the rock (rock-centred, Pixi-down) is texel
  // (x, y) * density + size / 2, UVs relative to the texture frame.
  const d = struct.density;
  for (let i = 0; i < pos.length; i += 2) {
    uvs[i] = ((pos[i]! + g.cx) * d + f.width / 2) / f.width;
    uvs[i + 1] = ((pos[i + 1]! - g.cy) * d + f.height / 2) / f.height;
  }
  const geom = new MeshGeometry({ positions: pos, uvs, indices: idx });
  geom.batchMode = 'batch'; // a big piece still joins the batch
  const c = new RockPieceArt(rock, struct, false);
  c.geom = geom;
  c.addChild(new Mesh({ geometry: geom, texture: tex }));
  return c;
}

/** Is this wreck a rock's (rock cut)? Its parent kind is not a ship kind:
 *  never look up ship art or a ship kind for it. */
export function isRockWreck(desc: Pick<WreckDescriptor, 'parentKind'> | undefined): boolean {
  return desc !== undefined && desc.parentKind === WRECK_ROCK_PARENT_KIND;
}
