/**
 * Lit deck (`?deckLit=on`, .resume/deck-lit-plan.md slice 2): the deck
 * floor's lit plates, part of `StructureDeckPlates` (it owns one of these
 * when the flag is on; off, none exists and the floor is today's, exactly).
 *
 * Each plate keeps its vector `Graphics` as the backing (no seam hairlines
 * where lit hexes meet); over it, one Container per plate at the same pose
 * holds seven `MachinedFlatSprite`s (one per hex: the yard art in the middle,
 * the ring art turned by 60° steps round it, `structureDeckLitArt.ts`) and
 * the plate's outer outline (the lit hexes would cover its inner half). The
 * yard sprite carries its paint (hazard ring, chevrons) as a crisp vector
 * child over the lit art (`deckLitPaintContext`, shared per look and variant),
 * so it sits under the zone paint and every structure like the plate itself.
 *
 * Art comes from the existing `struct` bake through `ArtService.struct()`;
 * the handles live in the art ctx's handle map (so art collection sees them
 * in use) and are asked for only once the lit look is first shown.
 *
 * Zoom swap (`deckLitShown`, the FarZoomIcons hysteresis pattern): lit at
 * camera scale ≥ ~0.5, vector at ≤ 0.4. Hidden with `renderable`, never
 * destroyed; off-screen plates and hexes are culled the same way
 * (`isSpriteInView` on the camera rect), so litPass skips them.
 *
 * Per frame: one pass over the plates through a bound callback, no
 * allocation (#14). Building a plate's sprites is cold (once, on first view).
 */
import { Container, Graphics } from 'pixi.js';
import { HEX_DIRS, type HexPoint } from '../../../core/hex/hex.js';
import { DECK_HEX_FLAT, DECK_HEX_SIZE, deckHexCentreInto } from '../../../core/hex/plates.js';
import type { ArtHandle, StructArt } from '../art/ArtService.js';
import type { ShipArtCtx } from '../art/shipArtSprites.js';
import { MachinedFlatSprite } from '../art/MachinedFlatSprite.js';
import { litPass } from '../art/litPass.js';
import { isSpriteInView } from '../spriteUpdateDecisions.js';
import { FAR_ICON } from './FarZoomIcons.js';
import { RIG_UNDER_Z } from './structureRigs.js';
import { deckLitArtId, deckLitPaintContext } from './structureDeckLitArt.js';
import { DECK_VARIANTS, deckPlatePick, type DeckTex } from './structureDeckTexture.js';
import { deckPlateOutlineContext } from './structureDeckPlates.js';

/** Camera scale at or below which the deck draws its vector plates only. */
export const DECK_LIT_FAR_SCALE = 0.4;

/** Lit plates shown at camera `scale`, with hysteresis (as `isIconOnly`):
 *  they go at or below DECK_LIT_FAR_SCALE and come back only at or above
 *  DECK_LIT_FAR_SCALE × FAR_ICON.hysteresis (0.5). Pure. */
export function deckLitShown(scale: number, wasShown: boolean): boolean {
  return wasShown ? scale > DECK_LIT_FAR_SCALE : scale >= DECK_LIT_FAR_SCALE * FAR_ICON.hysteresis;
}

/** zIndex of the lit plates: over the vector plate (`DECK_UNDER_Z`, RIG_UNDER_Z − 0.5),
 *  under the zone markings (`DECK_ZONE_Z`, −1.25). */
export const DECK_LIT_Z = RIG_UNDER_Z - 0.375;

/** Cull radii (world u): a hex (corner radius + seam), a whole plate (centre to its far corners). */
const HEX_CULL_R = DECK_HEX_SIZE + 16;
const PLATE_CULL_R = DECK_HEX_FLAT + DECK_HEX_SIZE + 16;

/** What the lit layer reads each frame (the swarm updater's ctx fits). */
export interface DeckLitView {
  art: ShipArtCtx;
  /** Camera scale (CSS px per world u); absent = 1. */
  cameraScale?: number;
  /** Camera rect, pixi space (`Camera.visibleBoundsInto`); absent = all in view. */
  viewBounds?: Float64Array;
}

interface LitPlate {
  i: number;
  j: number;
  /** Plate centre, pixi space, and its turn (60° steps, the vector plate's). */
  x: number;
  y: number;
  variant: number;
  turns: number;
  /** Built on first view: 7 hex sprites, then the outline. */
  root: Container | null;
  /** The art the sprites were built on (rebuilt when a handle's art moves). */
  ringArt: StructArt | null;
  yardArt: StructArt | null;
  /** Hex centres in pixi world space (x, y × 7). */
  hx: Float64Array;
}

/** Hex `k`'s centre in the plate frame (0 = the middle, 1..6 = HEX_DIRS[k − 1]), pixi space. */
function hexLocalInto(k: number, out: HexPoint): HexPoint {
  if (k === 0) { out.x = 0; out.y = 0; return out; }
  const d = HEX_DIRS[k - 1]!;
  deckHexCentreInto(d.q, d.r, out);
  out.y = -out.y; // Y-flip
  return out;
}

export class StructureDeckLit {
  private readonly plates = new Map<number, LitPlate>();
  /** Art ctx keys and job ids per (variant, role): index variant × 2 + (0 ring | 1 yard). */
  private readonly keys: string[] = [];
  private readonly ids: string[] = [];
  private shown = false;
  private view: DeckLitView | null = null;
  private readonly pt: HexPoint = { x: 0, y: 0 };
  private readonly plateFn = (p: LitPlate): void => this.framePlate(p);

  constructor(private readonly shipContainer: Container, private readonly tex: Exclude<DeckTex, 'plain'>) {
    for (let v = 0; v < DECK_VARIANTS; v++) {
      for (const role of ['ring', 'yard'] as const) {
        this.ids.push(deckLitArtId(tex, role));
        this.keys.push(`${deckLitArtId(tex, role)}#${v}`);
      }
    }
  }

  /** Lit plates currently shown (tests). */
  get shownCount(): number {
    let n = 0;
    for (const p of this.plates.values()) if (p.root?.renderable === true) n++;
    return n;
  }

  /** A plate joined the floor (cold): its key and (i, j), and its centre in pixi space. */
  add(key: number, i: number, j: number, x: number, y: number): void {
    const pick = deckPlatePick(i, j);
    this.plates.set(key, { i, j, x, y, variant: pick.variant, turns: pick.turns, root: null, ringArt: null, yardArt: null, hx: new Float64Array(14) });
  }

  /** A plate left the floor (cold). */
  remove(key: number): void {
    const p = this.plates.get(key);
    if (p === undefined) return;
    this.drop(p);
    this.plates.delete(key);
  }

  /** Per frame: zoom swap, cull, and build plates on first view. */
  frame(view: DeckLitView): void {
    this.shown = view.art.art !== null && deckLitShown(view.cameraScale ?? 1, this.shown);
    this.view = view;
    this.plates.forEach(this.plateFn);
    this.view = null;
  }

  destroy(): void {
    this.plates.forEach((p) => this.drop(p)); // cold
    this.plates.clear();
  }

  private framePlate(p: LitPlate): void {
    const vb = this.view!.viewBounds;
    if (!this.shown || !isSpriteInView(p.x, p.y, PLATE_CULL_R, vb)) {
      if (p.root !== null) p.root.renderable = false;
      return;
    }
    const ring = this.handle(p.variant, 0), yard = this.handle(p.variant, 1);
    const ra = ring?.state === 'ready' ? ring.struct : null, ya = yard?.state === 'ready' ? yard.struct : null;
    if (p.root !== null && ra !== null && ya !== null && (ra !== p.ringArt || ya !== p.yardArt)) this.drop(p); // art re-homed
    if (p.root === null && (ra === null || ya === null || !this.build(p, ra, ya))) return;
    const root = p.root!;
    root.renderable = true;
    for (let k = 0; k < 7; k++) root.children[k]!.renderable = isSpriteInView(p.hx[2 * k]!, p.hx[2 * k + 1]!, HEX_CULL_R, vb);
  }

  /** The art handle for (variant, role 0 ring | 1 yard), asked for again when stale. */
  private handle(variant: number, role: number): ArtHandle | null {
    const actx = this.view!.art;
    if (!actx.art) return null;
    const n = variant * 2 + role;
    let h = actx.handles.get(this.keys[n]!);
    if (h === undefined || h.stale === true) {
      h = actx.art.struct(this.ids[n]!, variant, 0, undefined, true);
      actx.handles.set(this.keys[n]!, h);
    }
    return h;
  }

  /** Build a plate's lit sprites (cold). False when the art is not GPU-lit
   *  (then the plate stays vector). */
  private build(p: LitPlate, ring: StructArt, yard: StructArt): boolean {
    if (!ring.lit || !yard.lit || !litPass.settings) return false;
    const root = new Container();
    root.label = 'deckLit';
    root.zIndex = DECK_LIT_Z;
    root.position.set(p.x, p.y);
    root.rotation = (p.turns * Math.PI) / 3;
    const c = Math.cos(root.rotation), s = Math.sin(root.rotation);
    for (let k = 0; k < 7; k++) {
      const sp = new MachinedFlatSprite(k === 0 ? yard : ring);
      if (sp.lit) sp.lit.selfShadow = false; // a flat floor: no self-shadow march (as wreck pieces)
      hexLocalInto(k, this.pt);
      sp.position.set(this.pt.x, this.pt.y);
      // The middle hex keeps the vector plate's yard; ring hexes turn for variety (a hex maps onto itself).
      if (k > 0) sp.rotation = (deckPlatePick(p.i * 7 + k, p.j * 13 + k).turns * Math.PI) / 3;
      else {
        const paint = new Graphics(deckLitPaintContext(this.tex, p.variant));
        paint.label = 'deckLitPaint';
        sp.addChild(paint);
      }
      p.hx[2 * k] = p.x + c * this.pt.x - s * this.pt.y;
      p.hx[2 * k + 1] = p.y + s * this.pt.x + c * this.pt.y;
      root.addChild(sp);
    }
    const outline = new Graphics(deckPlateOutlineContext());
    outline.label = 'deckLitOutline';
    root.addChild(outline);
    this.shipContainer.sortableChildren = true;
    this.shipContainer.addChild(root);
    p.root = root;
    p.ringArt = ring;
    p.yardArt = yard;
    return true;
  }

  private drop(p: LitPlate): void {
    if (p.root === null) return;
    p.root.parent?.removeChild(p.root);
    p.root.destroy({ children: true }); // lit meshes leave litPass; atlas textures and the shared outline / paint contexts survive
    p.root = null;
    p.ringArt = null;
    p.yardArt = null;
  }
}
