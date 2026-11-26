/**
 * Base platforms — the deck floor under every plate (plan
 * `.resume/base-platforms-plan.md`), drawn while the room's `deck` flag is on.
 *
 * Part of the structure under band, not a layer of its own: every plate's
 * Graphics sits on `shipContainer` at {@link DECK_UNDER_Z}, the bottom of the
 * rig under band (`RIG_UNDER_Z`, `structureRigs.ts`), so pad aprons, hulls and
 * structures all draw on top of it. Pure art: no collider, no nav obstacle.
 *
 * The plates arrive on the render mirror (`RenderMirror.deckPlates`, written
 * by `StructureRowSync` from the derived `PlateSet`) as (i, j) pairs plus a
 * version. A shared `GraphicsContext` holds a plate's art (7 hexes, opaque
 * dark fill, hex seams, a stronger outer outline: the approved wireframe
 * look, neutral steel); each plate is ONE `Graphics` on it, only positioned.
 * The floor's plating texture (`?deckTex=`, `structureDeckTexture.ts`) is
 * painted into that same context: a few seeded contexts per look, and each
 * plate picks one and a 60° turn by its (i, j) (`plain` = one context, no turn).
 * Graphics are added / removed only when the version changes; an unchanged
 * frame compares one number and does nothing (invariant #14).
 */
import { Graphics, GraphicsContext, type Container } from 'pixi.js';
import type { DeckPlatesMirror } from '../../../core/contracts/IRenderer.js';
import { HEX_DIRS, type HexPoint } from '../../../core/hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateCentreWorldInto } from '../../../core/hex/plates.js';
import { RIG_UNDER_Z } from './structureRigs.js';
import { DEFAULT_DECK_TEX, deckPlatePick, drawDeckHexTexture, type DeckTex } from './structureDeckTexture.js';
import { StructureDeckZones } from './structureDeckZones.js';
// Type only: the lit layer is handed in (a value import would cycle the art forge through the lit shader).
import type { DeckLitView, StructureDeckLit } from './structureDeckLit.js';

/** zIndex of the deck floor: the bottom of the structure under band. */
export const DECK_UNDER_Z = RIG_UNDER_Z - 0.5;

/** Deck look (wireframes `COL`): fill, inner hex seams, plate outline. */
export const DECK_FILL = 0x2a313b;
export const DECK_SEAM = 0x151a21;
export const DECK_OUTLINE = 0x0b0e13;
/** Line widths (world units; a deck hex is 1300 u flat to flat). */
export const DECK_SEAM_WIDTH = 28;
export const DECK_OUTLINE_WIDTH = 70;

/** Built plate contexts, keyed `<look>:<variant>` (build time only). */
const plateContexts = new Map<string, GraphicsContext>();

/** The shared art of one plate in look `tex` (seeded `variant`), in its own
 *  Pixi frame (centre hex at the origin, Y down). Built once on first use. */
/** Centre hex (0, 0) and its ring, in game space relative to the centre hex. */
const PLATE_HEXES: ReadonlyArray<{ q: number; r: number }> = [{ q: 0, r: 0 }, ...HEX_DIRS.map((d) => ({ q: d.q, r: d.r }))];
const corner = (cx: number, cy: number, a: number): [number, number] =>
  [cx + DECK_HEX_SIZE * Math.cos(a), -(cy + DECK_HEX_SIZE * Math.sin(a))];

/** Stroke the plate's outer outline into `ctx`: each hex edge with no plate hex beyond it. */
function strokePlateOutline(ctx: GraphicsContext): void {
  const hexes = PLATE_HEXES;
  const c: HexPoint = { x: 0, y: 0 };
  const inPlate = (q: number, r: number): boolean => hexes.some((h) => h.q === q && h.r === r);
  const n: HexPoint = { x: 0, y: 0 };
  for (const h of hexes) {
    deckHexCentreInto(h.q, h.r, c);
    for (const d of HEX_DIRS) {
      if (inPlate(h.q + d.q, h.r + d.r)) continue;
      deckHexCentreInto(h.q + d.q, h.r + d.r, n);
      const a = Math.atan2(n.y - c.y, n.x - c.x);
      const [ax, ay] = corner(c.x, c.y, a - Math.PI / 6);
      const [bx, by] = corner(c.x, c.y, a + Math.PI / 6);
      ctx.moveTo(ax, ay).lineTo(bx, by);
    }
  }
  ctx.stroke({ color: DECK_OUTLINE, width: DECK_OUTLINE_WIDTH, cap: 'round', join: 'round' });
}

/** The plate's outer outline alone (lit deck: drawn over the lit hexes,
 *  which would otherwise cover its inner half). Built once. */
export function deckPlateOutlineContext(): GraphicsContext {
  let ctx = plateContexts.get('outline');
  if (ctx === undefined) { ctx = new GraphicsContext(); strokePlateOutline(ctx); plateContexts.set('outline', ctx); }
  return ctx;
}

export function deckPlateContext(tex: DeckTex = 'plain', variant = 0): GraphicsContext {
  const key = tex === 'plain' ? 'plain' : `${tex}:${variant}`;
  const cached = plateContexts.get(key);
  if (cached !== undefined) return cached;
  const ctx = new GraphicsContext();
  const hexes = PLATE_HEXES;
  const c: HexPoint = { x: 0, y: 0 };
  const hexPoly = (cx: number, cy: number): number[] => {
    const pts: number[] = [];
    for (let k = 0; k < 6; k++) pts.push(...corner(cx, cy, Math.PI / 6 + (k * Math.PI) / 3));
    return pts;
  };
  // Opaque fill (flat, or the plating texture) + inner seams along every hex edge.
  for (const h of hexes) {
    deckHexCentreInto(h.q, h.r, c);
    const pts = hexPoly(c.x, c.y);
    if (tex === 'plain') { ctx.poly(pts, true).fill({ color: DECK_FILL }); continue; }
    const cs: Array<[number, number]> = [];
    for (let k = 0; k < 6; k++) cs.push([pts[2 * k]!, pts[2 * k + 1]!]);
    drawDeckHexTexture(ctx, tex, variant, [c.x, -c.y], cs, DECK_HEX_SIZE, h.q, h.r, DECK_FILL);
  }
  for (const h of hexes) {
    deckHexCentreInto(h.q, h.r, c);
    ctx.poly(hexPoly(c.x, c.y), true).stroke({ color: DECK_SEAM, width: DECK_SEAM_WIDTH, join: 'round' });
  }
  // The plate's outer outline.
  strokePlateOutline(ctx);
  plateContexts.set(key, ctx);
  return ctx;
}

/** Plate lattice (i, j) packed into one map key (no strings, #14). */
function plateKey(i: number, j: number): number {
  return (i + 0x8000) * 0x10000 + (j + 0x8000);
}

/**
 * The game's deck floor: one Graphics per plate on `shipContainer`. The swarm
 * updater calls {@link sync} once per frame with the mirror's plates.
 */
export class StructureDeckPlates {
  private readonly graphics = new Map<number, Graphics>();
  /** Keys seen in the current rebuild (reused). */
  private readonly seen = new Set<number>();
  private version = -1;
  private readonly pt: HexPoint = { x: 0, y: 0 };
  private readonly sweepFn = (g: Graphics, key: number): void => {
    if (this.seen.has(key)) return;
    g.parent?.removeChild(g);
    g.destroy(); // the shared context survives (a Graphics on a context does not own it)
    this.graphics.delete(key);
    this.lit?.remove(key);
  };

  /** Slice 33: zone markings painted on the floor (`?zones=off` ⇒ none). The
   *  swarm updater notes each structure into it; {@link sync} sweeps it. */
  readonly zones: StructureDeckZones | undefined;

  /** Lit deck (`?deckLit=on`, textured looks only): the lit plates over the vector ones. */
  readonly lit: StructureDeckLit | undefined;

  /** `tex`: the floor look (`readDeckTex`, `?deckTex=`); `zones`: paint zone markings;
   *  `lit`: the lit plates (`?deckLit=on`, `restyleLook`; absent = today's floor exactly). */
  constructor(private readonly shipContainer: Container, private readonly tex: DeckTex = DEFAULT_DECK_TEX, zones = true, lit?: StructureDeckLit) {
    this.zones = zones ? new StructureDeckZones(shipContainer) : undefined;
    this.lit = tex !== 'plain' ? lit : undefined;
  }

  /** Live plate Graphics (tests, stats): one per plate. */
  get size(): number { return this.graphics.size; }

  /** Bring the floor in line with `plates` (absent ⇒ none). Only a new
   *  version touches the display tree; `view` (the swarm ctx) drives the lit plates each frame. */
  sync(plates: DeckPlatesMirror | undefined, view?: DeckLitView): void {
    const v = plates?.version ?? 0;
    this.zones?.frame(plates?.deck === true); // last frame's gone structures lose their paint
    if (v !== this.version) this.rebuild(plates, v);
    if (this.lit !== undefined && view !== undefined) this.lit.frame(view);
  }

  private rebuild(plates: DeckPlatesMirror | undefined, v: number): void {
    const count = plates?.count ?? 0;
    this.version = v;
    this.seen.clear();
    for (let n = 0; n < count; n++) {
      const i = plates!.ij[2 * n]!, j = plates!.ij[2 * n + 1]!;
      const key = plateKey(i, j);
      this.seen.add(key);
      if (this.graphics.has(key)) continue;
      let g: Graphics;
      if (this.tex === 'plain') g = new Graphics(deckPlateContext());
      else {
        const pick = deckPlatePick(i, j);
        g = new Graphics(deckPlateContext(this.tex, pick.variant));
        g.rotation = (pick.turns * Math.PI) / 3; // the 7-hex plate maps onto itself
      }
      g.label = 'deckPlate';
      g.zIndex = DECK_UNDER_Z;
      plateCentreWorldInto(i, j, this.pt);
      g.position.set(this.pt.x, -this.pt.y); // Y-flip
      this.shipContainer.sortableChildren = true;
      this.shipContainer.addChild(g);
      this.graphics.set(key, g);
      this.lit?.add(key, i, j, this.pt.x, -this.pt.y);
    }
    this.graphics.forEach(this.sweepFn);
  }

  destroy(): void {
    this.zones?.destroy();
    this.lit?.destroy();
    this.seen.clear();
    this.graphics.forEach(this.sweepFn);
  }
}
