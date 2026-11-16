/**
 * Rock cut (salvage stream): the art of one piece of a cut rock. A rock's
 * wreck has no ship art (its parent kind is `WRECK_ROCK_PARENT_KIND`, not a
 * ship kind), so each piece shows its own stretch of the rock it came from:
 * the field rock shader surface (`placedRockMesh.ts` `rockPieceMeshData`, the
 * same surface the uncut placed rock drew), its vertices in the ROOT rock's
 * rest frame, so every piece of a rock (and of its re-cuts) tiles the original
 * exactly and the surface does not swim when the rock splits.
 *
 * One `Mesh` per piece on the cut-field layer's one shader (no mask). Without
 * the field layer (headless tests) the piece outline is filled in the classic
 * asteroid colour and resource tint, with the rock's outline stroke on its
 * hull edges.
 *
 * Built once per piece (the swarm updater's create path), never per frame
 * (#14); the mesh frees its geometry with it. The result is handed to
 * `WreckPieceSprite` as its art, so the piece keeps the wreck cut-edge glow,
 * hit flash and far-zoom speck.
 */
import { Container, Graphics } from 'pixi.js';
import { EDGE_HULL } from '../../../core/destruction/fractureHull.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieceFrame.js';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor, type WreckRockRef } from '../../../shared-types/messages/wreckDescriptor.js';
import type { CutFieldLayer } from '../field/CutFieldLayer.js';
import { rockPieceMeshData } from '../field/placedRockMesh.js';
import { ASTEROID_COLOR, ASTEROID_OUTLINE } from './spriteBuilders.js';

/** A classic (plain-polygon) rock's resource tint: ice and crystal-veined
 *  rocks read apart from plain rock (the field rock shader draws ore itself). */
export function classicRockTint(resource: string | undefined): number | undefined {
  return resource === 'ice' ? 0xa8dcff : resource === 'crystal' ? 0xd2a8ff : undefined;
}

/** How a rock's piece looks: the uncut rock's resource (`resource`, as the
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

/** A rock piece's art holder: the rock it was cut from, and whether it shows
 *  the field rock shader (else the plain polygon). */
export class RockPieceArt extends Container {
  constructor(readonly rock: WreckRockRef, readonly shaded: boolean) {
    super();
  }
}

/** The plain rock's outline stroke width (`buildAsteroidGfx`). */
const OUTLINE_W = 1.5;

/** The plain look: the piece outline in the asteroid colour, with the
 *  rock's outline stroke inside its hull edges. */
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
 *  body frame, Pixi-down) holding one mesh of the piece's stretch of the
 *  rock's surface. `field`: the cut-field layer (its one rock shader). */
export function buildRockPieceArt(
  g: Pick<WreckPieceGeometry, 'cx' | 'cy' | 'outline' | 'parts' | 'cutEdges'>, rock: WreckRockRef,
  field: Pick<CutFieldLayer, 'buildRockMesh'> | null = null,
): RockPieceArt {
  if (field !== null) {
    const c = new RockPieceArt(rock, true);
    c.addChild(field.buildRockMesh(rockPieceMeshData(g, { shape: rock.shape, r: rock.r, res: rock.res })));
    return c;
  }
  const c = new RockPieceArt(rock, false);
  const gfx = plainPieceGfx(g);
  gfx.tint = rockPieceLook(rock).tint;
  c.addChild(gfx);
  return c;
}

/** Is this wreck a rock's (rock cut)? Its parent kind is not a ship kind:
 *  never look up ship art or a ship kind for it. */
export function isRockWreck(desc: Pick<WreckDescriptor, 'parentKind'> | undefined): boolean {
  return desc !== undefined && desc.parentKind === WRECK_ROCK_PARENT_KIND;
}
