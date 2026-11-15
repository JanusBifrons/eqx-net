/**
 * Rock cut (salvage stream): the art of one piece of a cut rock. A rock's
 * wreck has no ship art (its parent kind is `WRECK_ROCK_PARENT_KIND`, not a
 * ship kind), so each piece draws the WHOLE parent rock with the existing
 * asteroid art (`buildAsteroidGfx`, the same shape the rock drew and collided
 * with), offset so the rock's centre sits where it was, and clipped to the
 * piece outline. Every piece of a rock (and of its re-cuts: all share the
 * root rock's rest frame) shows its own stretch of the one rock, so the
 * pieces tile the original exactly.
 *
 * Built once per piece (the swarm updater's create path), never per frame
 * (#14). The result is handed to `WreckPieceSprite` as its art, so the piece
 * keeps the wreck cut-edge glow and hit flash.
 */
import { Container, Graphics } from 'pixi.js';
import type { WreckPieceGeometry } from '../../../core/destruction/wreckPieceFrame.js';
import { WRECK_ROCK_PARENT_KIND, type WreckDescriptor, type WreckRockRef } from '../../../shared-types/messages/wreckDescriptor.js';
import { buildAsteroidGfx } from './spriteBuilders.js';

/** The art of a rock's wreck piece `g`, cut from `rock`: a container (piece
 *  body frame, Pixi-down) holding the rock's art and its outline mask. */
export function buildRockPieceArt(g: Pick<WreckPieceGeometry, 'cx' | 'cy' | 'outline'>, rock: WreckRockRef): Container {
  const c = new Container();
  // TODO(fieldRockShader): draw rock pieces with the field rock shader once it lands on main.
  // Plain rock colour: the descriptor carries no resource (a kind-0 rock's
  // ice/crystal tint is not applied to its pieces).
  const art = buildAsteroidGfx(rock.shape, rock.r);
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
