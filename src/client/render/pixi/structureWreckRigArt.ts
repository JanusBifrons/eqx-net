/**
 * A structure wreck piece's share of what the live structure draws OVER its
 * bake (structure break-up: "what you see alive = what breaks"). A live
 * structure draws its bake (`structHandleFor`) PLUS its rig's parts as live
 * Graphics (`StructureRigView`: solar panels, crane boom and pad, hatch
 * leaves, the turret riser, fan blades) PLUS its gun(s) (the mount cluster,
 * `MountVisualManager`); the bake alone has none of them, so a piece
 * wearing only the bake lost them.
 *
 * Not a second rig or mount system: the piece gets one ordinary
 * `StructureRigView` of the kind's rig, posed once in its idle pose (no
 * clip, no sun: aiming parts at rest, lights off, spinners stopped: it is
 * dead), and its guns built by the mount code's own builders (`gunLayers`
 * for a ready gun bake, else today's bar, `buildTurretGfx`), static at the
 * mount's rest angle and placed on the rig's mount part (`placeMount`) as
 * the live cluster is. No `MountVisualManager` entry. All of it sits in the
 * structure's local Pixi frame offset to the piece exactly as the piece's
 * art meshes are (`-cx, cy`), clipped to the piece outline by a mask, so
 * each part breaks with the piece it sits on. Built once per piece sprite;
 * nothing per frame (invariant #14). The caller tints it with the art
 * (burnt like the dead hull) and destroys it with the sprite.
 */
import { Container, Graphics } from 'pixi.js';
import { rigForStructureKind } from '../../../core/articulation/rigCatalogue.js';
import { getStructureKind } from '../../../shared-types/structureKinds.js';
import type { ShipArt } from '../art/ArtService.js';
import { structureTurrets } from '../art/turretLayout.js';
import { buildTurretGfx, gunLayers } from '../MountVisualManager.js';
import { StructureRigView } from './structureRigs.js';

/** The piece geometry this needs: centroid and outline (body-local math-up). */
export interface WreckRigPiece {
  cx: number;
  cy: number;
  outline: ReadonlyArray<{ x: number; y: number }>;
}

/**
 * The rig parts and guns of structure kind `kindId` that fall on `piece`, as
 * one masked container in the piece's local Pixi frame; null when the kind
 * has neither (its bake is all it draws). `guns[i]`: the ready gun bake of
 * `structureTurrets(kindId)[i]` (the live gun's own), null/absent = the bar.
 */
export function structureWreckRigArt(
  kindId: string, piece: WreckRigPiece, guns: ReadonlyArray<ShipArt | null> | null = null,
): Container | null {
  const rig = rigForStructureKind(kindId);
  const places = structureTurrets(kindId);
  if (rig === null && places.length === 0) return null;
  const root = new Container();
  root.label = 'wreck-rig';
  const body = new Container();
  body.label = 'wreck-rig-body';
  // The structure's local Pixi frame → the piece's (as `litPieceGeometry`'s mesh offset).
  body.position.set(-piece.cx, piece.cy);
  root.addChild(body);
  let view: StructureRigView | null = null;
  if (rig !== null) {
    view = new StructureRigView(rig);
    view.running = false; // dead: lit overlays off, spinners hold
    view.update(null, 0, 0, 0, 0, 1, undefined);
    view.over.zIndex = 0; // the game's layer bands mean nothing inside one piece
    view.under.zIndex = 0;
    body.addChild(view.under, view.plane);
  }
  if (places.length > 0) {
    // The live cluster: over the plane parts, under the lifted ones.
    const cluster = new Container();
    cluster.label = 'wreck-guns';
    const color = getStructureKind(kindId).color;
    for (let i = 0; i < places.length; i++) {
      const p = places[i]!;
      const pivot = new Container();
      pivot.label = 'wreck-gun';
      pivot.position.set(p.px, p.py);
      pivot.rotation = -p.mount.baseAngle;
      const art = guns?.[i] ?? null;
      if (art !== null) gunLayers(art, pivot, 0);
      else pivot.addChild(buildTurretGfx(p.mount, color));
      cluster.addChild(pivot);
    }
    view?.placeMount(cluster);
    body.addChild(cluster);
  }
  if (view !== null) body.addChild(view.over);
  const mask = new Graphics();
  mask.label = 'wreck-rig-mask';
  mask.poly(piece.outline.map((v) => ({ x: v.x, y: -v.y }))).fill({ color: 0xffffff }); // once per piece
  root.addChild(mask);
  root.mask = mask;
  return root;
}
