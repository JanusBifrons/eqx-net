/**
 * A structure wreck piece's share of the structure's RIG parts (structure
 * break-up: "what you see alive = what breaks"). A live structure draws its
 * bake (`structHandleFor`) PLUS its rig's parts as live Graphics on top
 * (`StructureRigView`: solar panels, crane boom and pad, hatch leaves, the
 * turret riser, fan blades); the bake alone has none of them, so a piece
 * wearing only the bake lost them (the solar array's panels, the Capital's
 * crane and pad).
 *
 * Not a second rig renderer: the piece gets one ordinary `StructureRigView`
 * of the kind's rig, posed once at rest (no clip, no sun: aiming parts at
 * rest, lights off, spinners stopped: it is dead), in the structure's local
 * Pixi frame offset to the piece exactly as the piece's art meshes are
 * (`-cx, cy`), and clipped to the piece outline by a mask, so each part
 * breaks with the piece it sits on. Built once per piece sprite; nothing per
 * frame (invariant #14). The caller tints it with the art (burnt like the
 * dead hull) and destroys it with the sprite.
 */
import { Container, Graphics } from 'pixi.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { StructureRigView } from './structureRigs.js';

/** The piece geometry this needs: centroid and outline (body-local math-up). */
export interface WreckRigPiece {
  cx: number;
  cy: number;
  outline: ReadonlyArray<{ x: number; y: number }>;
}

/**
 * The rig parts of structure kind `kindId` that fall on `piece`, as one
 * masked container in the piece's local Pixi frame; null when the kind has
 * no rig (its bake is all it draws).
 */
export function structureWreckRigArt(kindId: string, piece: WreckRigPiece): Container | null {
  const rig = rigForStructureKind(kindId);
  if (rig === null) return null;
  const view = new StructureRigView(rig);
  view.running = false; // dead: lit overlays off, spinners hold
  view.update(null, 0, 0, 0, 0, 1, undefined);
  const root = new Container();
  root.label = 'wreck-rig';
  const body = new Container();
  body.label = 'wreck-rig-body';
  // The structure's local Pixi frame → the piece's (as `litPieceGeometry`'s mesh offset).
  body.position.set(-piece.cx, piece.cy);
  body.addChild(view.under, view.plane, view.over);
  view.over.zIndex = 0; // the game's layer bands mean nothing inside one piece
  view.under.zIndex = 0;
  root.addChild(body);
  const mask = new Graphics();
  mask.label = 'wreck-rig-mask';
  mask.poly(piece.outline.map((v) => ({ x: v.x, y: -v.y }))).fill({ color: 0xffffff }); // once per piece
  root.addChild(mask);
  root.mask = mask;
  return root;
}
