/**
 * Rock cut (salvage stream): the art of one piece of a cut rock. A rock's
 * wreck has no ship art (its parent kind is `WRECK_ROCK_PARENT_KIND`, not a
 * ship kind), so each piece draws the WHOLE parent rock with the art the
 * uncut rock drew (`rockPieceLook`): the Machined rock bake of its shape,
 * radius and resource (`rockHandleFor`, the same handle key the uncut rock
 * used, so an already baked rock is reused) once ready, else the plain
 * asteroid polygon (`buildAsteroidGfx`) in the resource's classic tint, as
 * the uncut rock. It is offset so the rock's centre sits where it was and
 * clipped to the piece outline. Every piece of a rock (and of its re-cuts:
 * all share the root rock's rest frame) shows its own stretch of the one
 * rock, so the pieces tile the original exactly and keep its colour.
 *
 * Built once per piece (the swarm updater's create path, and once more when
 * the Machined bake becomes ready), never per frame (#14). The result is
 * handed to `WreckPieceSprite` as its art, so the piece keeps the wreck
 * cut-edge glow, hit flash and far-zoom speck.
 */
import { Container, Graphics } from 'pixi.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieceFrame.js';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor, type WreckRockRef } from '../../../shared-types/messages/wreckDescriptor.js';
import type { ArtHandle, StructArt } from '../art/ArtService.js';
import { MachinedFlatSprite } from '../art/MachinedFlatSprite.js';
import { ASTEROID_COLOR, buildAsteroidGfx } from './spriteBuilders.js';

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
 *  polygon), so the updater swaps it once the bake is ready. */
export class RockPieceArt extends Container {
  constructor(readonly rock: WreckRockRef, readonly struct: StructArt | null, readonly lit: boolean) {
    super();
  }
}

/** The art of a rock's wreck piece `g`, cut from `rock`: a container (piece
 *  body frame, Pixi-down) holding the rock's art and its outline mask.
 *  `handle`: the rock's Machined bake (`rockHandleFor`), used once ready. */
export function buildRockPieceArt(
  g: Pick<WreckPieceGeometry, 'cx' | 'cy' | 'outline'>, rock: WreckRockRef, handle: ArtHandle | null = null,
): RockPieceArt {
  const struct = handle !== null && handle.state === 'ready' ? handle.struct : null;
  let art: Container;
  let lit = false;
  if (struct !== null) {
    const m = new MachinedFlatSprite(struct);
    lit = m.lit !== null;
    art = m;
  } else {
    art = buildAsteroidGfx(rock.shape, rock.r);
    art.tint = rockPieceLook(rock).tint;
  }
  const c = new RockPieceArt(rock, struct, lit);
  // The rock's centre in the piece's body frame: math-up (-cx, -cy), pixiY = -gameY.
  art.position.set(-g.cx, g.cy);
  const mask = new Graphics();
  const pts: number[] = [];
  for (const v of g.outline) pts.push(v.x, -v.y);
  mask.poly(pts);
  mask.fill({ color: 0xffffff });
  c.addChild(art, mask);
  art.mask = mask;
  return c;
}

/** Is this wreck a rock's (rock cut)? Its parent kind is not a ship kind:
 *  never look up ship art or a ship kind for it. */
export function isRockWreck(desc: Pick<WreckDescriptor, 'parentKind'> | undefined): boolean {
  return desc !== undefined && desc.parentKind === WRECK_ROCK_PARENT_KIND;
}
