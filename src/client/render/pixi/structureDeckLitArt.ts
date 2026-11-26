/**
 * Lit deck (`?deckLit=on`, .resume/deck-lit-plan.md slice 2): one deck HEX's
 * floor as a `struct` bake, so the plates get height, normals and live
 * lighting like the lit road. Not a bake job of its own: the `struct` job
 * carries a deck art id (below) and `runBake` hands `forgeStructure` this
 * plan on the full deck hex box.
 *
 * One geometry source: the polygons are `deckHexPolys` (structureDeckTexture.ts),
 * the same calls the vector plate fills flat. The bake adds only what the
 * plate's own strokes draw in vector: the hex seam groove along each edge.
 * The yard's paint (hazard dashes, chevrons) stays OUT of the bake: at
 * DECK_LIT_PPU its ends stair-step, so the lit plate draws those same polys
 * as crisp vector over its yard hex ({@link deckLitPaintContext}), as the lit
 * road keeps its lines vector. Bolts stay baked: they keep their lit relief.
 * The faint wear blobs (alpha < 1) are left to the forge's grime pass (a
 * stamped poly would paint them solid).
 *
 * Art per (look, variant, role): `ring` (a ring hex, seeded as ring slot 0;
 * every ring hex draws it, turned by 60° steps) and `yard` (the plate's
 * middle hex; its hazard ring and chevrons ride on top as vector). 3 variants
 * (STRUCT_SEED_VARIANTS: the job's seed 1..3 = variant 0..2) × 2 roles.
 *
 * Pointy-top hex (the plate frame), Pixi space, hex centre at the origin.
 * Cold path (bake time): allocates freely.
 */
import { HEX_DIRS } from '../../../core/hex/hex.js';
import { DECK_HEX_FLAT, DECK_HEX_SIZE } from '../../../core/hex/plates.js';
import { GraphicsContext } from 'pixi.js';
import { ngon, poly, strip, type Pt } from './structureStyleKit.js';
import { deckHexPolys, deckStyleCtx, type DeckTex } from './structureDeckTexture.js';
import { DECK_FILL, DECK_SEAM, DECK_SEAM_WIDTH } from './structureDeckPlates.js';
import type { StructureVisual } from './structureVisuals.js';

/** The lit deck hex bake's drawing version (its key only: a change re-bakes
 *  just the flag-on deck art). */
export const DECK_PLATE_LIT_VERSION = 2;

/**
 * The lit deck's base albedo (the panels' tone centre), lifted from the
 * vector DECK_FILL (0x2a313b): lit and shaded, the old tone sat nearly as
 * dark as the lit road's carriageway (ROAD_LANE, DECK_FILL × 0.55, unchanged),
 * so roads stopped standing out. ~+35 % luminance keeps the road clearly the
 * darker surface while the lit floor stays a dark steel.
 */
export const DECK_LIT_FILL = 0x3a424e;

/** Room round the hex for the seam groove's outer half (u). */
const SEAM_MARGIN = 16;
/** The bake box: the pointy-top hex (flat to flat × corner to corner) plus the seam's outer half. */
export const DECK_PLATE_HEX_BOX = { w: DECK_HEX_FLAT + 2 * SEAM_MARGIN, h: 2 * DECK_HEX_SIZE + 2 * SEAM_MARGIN } as const;

/** Seam groove: sunk into the plate edge, in the vector seam's colour. */
const SEAM_CUT = { lift: -1.5, bevel: 3 } as const;

export type DeckLitRole = 'ring' | 'yard';
type TexturedDeck = Exclude<DeckTex, 'plain'>;

const PREFIX = 'deckLit.';

/** The `struct` job id of a lit deck hex. */
export function deckLitArtId(tex: TexturedDeck, role: DeckLitRole): string {
  return `${PREFIX}${tex}.${role}`;
}

/** Is `id` a lit deck hex art id? */
export function isDeckLitArtId(id: string): boolean {
  return id.startsWith(PREFIX);
}

/** The pointy-top hex corners about (0, 0), Pixi space (the plate's, `deckPlateContext`). */
function hexCorners(): Pt[] {
  const cs: Pt[] = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    cs.push([DECK_HEX_SIZE * Math.cos(a), -DECK_HEX_SIZE * Math.sin(a)]);
  }
  return cs;
}

/**
 * The draw plan of lit deck art `id` (`deckLitArtId`), seed 1..3 = variant
 * 0..2: the hex's polygons on the full hex box, no rects, no lamps.
 */
export function deckLitVisual(id: string, seed: number): StructureVisual {
  const [tex, role] = id.slice(PREFIX.length).split('.') as [TexturedDeck, DeckLitRole];
  const variant = Math.max(0, seed - 1);
  const cs = hexCorners();
  const c = deckStyleCtx(ngon(0, 0, DECK_HEX_SIZE + SEAM_MARGIN + 8, 6, Math.PI / 6), seed);
  const d = role === 'yard' ? { q: 0, r: 0 } : HEX_DIRS[0]!;
  deckHexPolys(c, tex, variant, [0, 0], cs, DECK_HEX_SIZE, d.q, d.r, DECK_LIT_FILL, 'floor');
  const polys = c.polys.filter((p) => (p.alpha ?? 1) >= 1);
  c.polys.length = 0;
  for (let k = 0; k < 6; k++) poly(c, strip(cs[k]!, cs[(k + 1) % 6]!, DECK_SEAM_WIDTH), DECK_SEAM, 'metal', SEAM_CUT.lift, SEAM_CUT.bevel);
  polys.push(...c.polys);
  return { rects: [], lights: [], footprint: { w: DECK_PLATE_HEX_BOX.w, h: DECK_PLATE_HEX_BOX.h }, polys };
}

/** Built paint overlays, keyed `<look>:<variant>`. */
const paintContexts = new Map<string, GraphicsContext>();

/**
 * The yard hex's paint (look `tex`, `variant`) as crisp vector, in the hex's
 * own frame (centre at the origin, the lit sprite's): the `paint` part of
 * `deckHexPolys`, filled flat in order exactly as the vector plate fills
 * them (its colours, from DECK_FILL). Shared; built once (cold).
 */
export function deckLitPaintContext(tex: TexturedDeck, variant: number): GraphicsContext {
  const key = `${tex}:${variant}`;
  let ctx = paintContexts.get(key);
  if (ctx !== undefined) return ctx;
  ctx = new GraphicsContext();
  const c = deckStyleCtx(ngon(0, 0, DECK_HEX_SIZE * 1.25, 6));
  deckHexPolys(c, tex, variant, [0, 0], hexCorners(), DECK_HEX_SIZE, 0, 0, DECK_FILL, 'paint');
  for (const p of c.polys) {
    const pts: number[] = [];
    for (const [x, y] of p.pts) pts.push(x, y);
    ctx.poly(pts, true).fill({ color: p.color });
  }
  paintContexts.set(key, ctx);
  return ctx;
}
