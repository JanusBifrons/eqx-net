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
import { structureWreckSource } from '../../../core/destruction/wreckSource.js';
import { pointInRing } from './wreckGlowStrip.js';

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
  const pivots: Container[] = [];
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
      pivots.push(pivot);
    }
    view?.placeMount(cluster);
    body.addChild(cluster);
  }
  if (view !== null) body.addChild(view.over);
  const mask = new Graphics();
  mask.label = 'wreck-rig-mask';
  const ring = piece.outline.map((v) => ({ x: v.x, y: -v.y }));
  mask.poly(ring).fill({ color: 0xffffff }); // once per piece
  if (pivots.length > 0) addBarrelOverhangs(mask, root, kindId, piece, ring, places, pivots);
  root.addChild(mask);
  root.mask = mask;
  return root;
}

/** Marching steps along a barrel when finding where it leaves the hull. */
const EXIT_STEPS = 32;
/** Where the overhang's owner is decided, in barrel widths: this far back
 *  from the hull exit along the barrel, this far off its axis (a generic
 *  point, never on a cut through the mount or along the barrel). */
const OWNER_BACK = 0.5, OWNER_SIDE = 0.3;

/**
 * A live turret's barrel reaches its muzzle (`structureTurretMuzzle`: 1.6 ×
 * the turret radius), past the hull; the piece mask (its outline) cut it at
 * the hull side, leaving a stub. The barrel past the hull goes with the
 * piece the barrel leaves the hull from (the piece holding the barrel just
 * inside the hull side): that piece's mask adds the barrel strip from there
 * to its tip, so the overhang carries on from the barrel that piece draws.
 * Not the piece holding the PIVOT: a cut through the mount leaves the pivot
 * on a corner shared by every piece around it, so the strip went to a piece
 * the barrel does not lie on and hung off it in space (r3 stills). Inside the
 * hull the barrel still breaks with the pieces it lies on. Root (piece Pixi)
 * frame; build time only.
 */
function addBarrelOverhangs(
  mask: Graphics, root: Container, kindId: string, piece: WreckRigPiece,
  ring: ReadonlyArray<{ x: number; y: number }>, places: ReturnType<typeof structureTurrets>, pivots: readonly Container[],
): void {
  // The structure's hull, body frame (Pixi) → the piece's.
  const hull = structureWreckSource({ k: getStructureKind(kindId).id }).outline.map(([x, y]) => ({ x: x - piece.cx, y: y + piece.cy }));
  for (let i = 0; i < pivots.length; i++) {
    const pv = pivots[i]!, pl = places[i]!;
    const hw = pl.wid, len = Math.max(pl.muzzle, pl.len) + pl.wid;
    const inHull = (lat: number, t: number): boolean => {
      const p = root.toLocal({ x: lat, y: -t }, pv);
      return pointInRing(hull, p.x, p.y);
    };
    // Where the barrel's sides and axis first leave the hull (the earliest).
    let t0 = len;
    for (const lat of [-hw, 0, hw]) {
      let lo = 0, hi = -1;
      for (let k = 1; k <= EXIT_STEPS; k++) { const t = (len * k) / EXIT_STEPS; if (!inHull(lat, t)) { hi = t; break; } lo = t; }
      if (hi < 0) continue;
      for (let k = 0; k < 12; k++) { const m = (lo + hi) / 2; if (inHull(lat, m)) lo = m; else hi = m; }
      t0 = Math.min(t0, lo);
    }
    if (t0 >= len) continue; // all inside the hull (a rack): the outline mask keeps it
    const own = root.toLocal({ x: OWNER_SIDE * hw, y: -Math.max(0, t0 - OWNER_BACK * hw) }, pv);
    if (!pointInRing(ring, own.x, own.y)) continue; // the barrel leaves the hull from another piece
    mask.poly([[-hw, -t0], [hw, -t0], [hw, -len], [-hw, -len]].map(([x, y]) => root.toLocal({ x: x!, y: y! }, pv))).fill({ color: 0xffffff });
  }
}
