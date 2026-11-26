/**
 * Base platforms slice 33 — zone markings painted on the deck floor (the
 * owner's mock-up), part of the deck floor layer ({@link StructureDeckPlates}
 * owns one of these; not a layer of its own):
 *  - industry: a hazard-stripe band (amber / near-black diagonals) in a
 *    rectangle a margin outside the building's footprint, turning with it;
 *  - guns: a dashed red danger ring with a faint red fill;
 *  - Capital: a blue border round its deck hex (solid outer line, dashed inner).
 *
 * Flat paint just above the plates and under everything else ({@link DECK_ZONE_Z}).
 * Each marking is ONE `Graphics` on a shared per-kind `GraphicsContext`, built
 * once on first use (build time only): a frame only stamps the structures it
 * saw and re-positions a Graphics whose pose changed; a structure gone from the
 * swarm loses its paint at the next frame's sweep (invariant #14). Deck rooms
 * only (the plates' deck flag); `?zones=off` turns it off.
 */
import { Graphics, GraphicsContext, type Container } from 'pixi.js';
import { arcSubpath } from '../arcSubpath.js';
import { DECK_HEX_SIZE } from '../../../core/hex/plates.js';
import { getStructureKind } from '../../../shared-types/structureKinds/lookup.js';
import { structureFamilyOf, type StructureFamilyId } from './structureFamilies.js';

/** `?zones=on|off` (base platforms slice 33); default on (spike). */
export function readZonesFlag(search: string): boolean {
  return !/[?&]zones=off\b/.test(search);
}

export type DeckZone = 'industry' | 'gun' | 'capital';

/** Industry: the production / heavy-industry / mining families, plus the two
 *  freight buildings the mock-up stripes (cargo bay, freight dock). */
const INDUSTRY_FAMILIES: ReadonlySet<StructureFamilyId> = new Set<StructureFamilyId>(['lightProduction', 'heavyIndustry', 'mining']);
const INDUSTRY_EXTRA_KINDS: ReadonlySet<string> = new Set(['cargo_bay', 'freight_dock']);
const GUN_FAMILIES: ReadonlySet<StructureFamilyId> = new Set<StructureFamilyId>(['turrets', 'coastal']);

/** The marking a structure kind gets, or null for none. */
export function deckZoneOf(kindId: string | undefined): DeckZone | null {
  if (kindId === undefined) return null;
  if (kindId === 'capital') return 'capital';
  if (INDUSTRY_EXTRA_KINDS.has(kindId)) return 'industry';
  const fam = structureFamilyOf(kindId);
  if (fam === undefined) return null;
  if (INDUSTRY_FAMILIES.has(fam)) return 'industry';
  if (GUN_FAMILIES.has(fam)) return 'gun';
  return null;
}

/** zIndex: just above the deck plates (`DECK_UNDER_Z` = RIG_UNDER_Z − 0.5), below rig pads. */
export const DECK_ZONE_Z = -1.25;

/** Paint look (mock-up colours; world units). */
export const ZONE_AMBER = 0xd9a92a;
export const ZONE_STRIPE_DARK = 0x16181b;
export const ZONE_RED = 0xd8342c;
export const ZONE_BLUE = 0x3d7fd9;
export const ZONE_ALPHA = 0.85;
/** Industry band: gap outside the footprint, band depth, stripe period. */
export const INDUSTRY_MARGIN = 50;
export const INDUSTRY_BAND = 70;
export const STRIPE_PERIOD = 100;
/** Gun ring: gap outside the bounding circle, line width, dash, fill alpha. */
export const GUN_MARGIN = 40;
export const GUN_RING_WIDTH = 18;
export const GUN_DASH = 60;
export const GUN_FILL_ALPHA = 0.08;
/** Capital hex border: outer / inner radius (fraction of the deck hex), widths. */
export const CAPITAL_OUTER = 0.94;
export const CAPITAL_INNER = 0.84;
export const CAPITAL_LINE = 30;
export const CAPITAL_DASH = 90;

type Pt = [number, number];

/** Clip convex polygon `poly` to `a·x + b·y >= c` (Sutherland–Hodgman, build time). */
function clipHalf(poly: Pt[], a: number, b: number, c: number): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]!, q = poly[(k + 1) % poly.length]!;
    const dp = a * p[0] + b * p[1] - c, dq = a * q[0] + b * q[1] - c;
    if (dp >= 0) out.push(p);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

/** Diagonal stripes over the rectangle [x0,x1]×[y0,y1]: dark base, amber
 *  stripes where `(x + y) mod P < P/2` (one phase for the whole band). */
function stripedRect(ctx: GraphicsContext, x0: number, y0: number, x1: number, y1: number): void {
  ctx.rect(x0, y0, x1 - x0, y1 - y0).fill({ color: ZONE_STRIPE_DARK, alpha: ZONE_ALPHA });
  const rect: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const P = STRIPE_PERIOD;
  for (let s = Math.floor((x0 + y0) / P) * P; s < x1 + y1; s += P) {
    const poly = clipHalf(clipHalf(rect, 1, 1, s), -1, -1, -(s + P / 2));
    if (poly.length < 3) continue;
    ctx.poly(poly.flat(), true).fill({ color: ZONE_AMBER, alpha: ZONE_ALPHA });
  }
}

/** Industry band in the kind's local frame (footprint `w` along x at rotation 0). */
function drawIndustry(ctx: GraphicsContext, w: number, h: number): void {
  const ix = w / 2 + INDUSTRY_MARGIN, iy = h / 2 + INDUSTRY_MARGIN;
  const ox = ix + INDUSTRY_BAND, oy = iy + INDUSTRY_BAND;
  stripedRect(ctx, -ox, -oy, ox, -iy); // top (full width)
  stripedRect(ctx, -ox, iy, ox, oy); // bottom (full width)
  stripedRect(ctx, -ox, -iy, -ix, iy); // left (between)
  stripedRect(ctx, ix, -iy, ox, iy); // right (between)
}

/** Dashed line a→b (`dash` on, `dash` off), into the current path. */
function dashedSegment(ctx: GraphicsContext, ax: number, ay: number, bx: number, by: number, dash: number): void {
  const len = Math.hypot(bx - ax, by - ay);
  const n = Math.max(1, Math.round(len / (2 * dash)));
  const step = len / n, ux = (bx - ax) / len, uy = (by - ay) / len;
  for (let k = 0; k < n; k++) {
    const t0 = k * step + step / 4, t1 = t0 + step / 2; // centred dash per step: corners stay clean
    ctx.moveTo(ax + ux * t0, ay + uy * t0).lineTo(ax + ux * t1, ay + uy * t1);
  }
}

function drawGun(ctx: GraphicsContext, radius: number): void {
  const r = radius + GUN_MARGIN;
  ctx.circle(0, 0, r).fill({ color: ZONE_RED, alpha: GUN_FILL_ALPHA });
  const n = Math.max(8, Math.round((2 * Math.PI * r) / (2 * GUN_DASH)));
  const step = (2 * Math.PI) / n;
  for (let k = 0; k < n; k++) {
    const a0 = k * step;
    arcSubpath(ctx, 0, 0, r, a0, a0 + step / 2); // never moveTo + arc() (LESSONS)
  }
  ctx.stroke({ color: ZONE_RED, alpha: ZONE_ALPHA, width: GUN_RING_WIDTH, cap: 'butt' });
}

/** Pointy-top hex corners at circumradius `r` (the deck's hexes; Pixi frame). */
function hexCorners(r: number): Pt[] {
  const pts: Pt[] = [];
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    pts.push([r * Math.cos(a), -r * Math.sin(a)]);
  }
  return pts;
}

function drawCapital(ctx: GraphicsContext): void {
  ctx.poly(hexCorners(DECK_HEX_SIZE * CAPITAL_OUTER).flat(), true)
    .stroke({ color: ZONE_BLUE, alpha: ZONE_ALPHA, width: CAPITAL_LINE, join: 'miter' });
  const inner = hexCorners(DECK_HEX_SIZE * CAPITAL_INNER);
  for (let k = 0; k < 6; k++) {
    const a = inner[k]!, b = inner[(k + 1) % 6]!;
    dashedSegment(ctx, a[0], a[1], b[0], b[1], CAPITAL_DASH);
  }
  ctx.stroke({ color: ZONE_BLUE, alpha: ZONE_ALPHA, width: CAPITAL_LINE * 0.6, cap: 'butt' });
}

/** Built marking contexts, keyed by kind id (build time only). */
const zoneContexts = new Map<string, GraphicsContext>();

/** The shared paint of `kindId` (its zone's look at the kind's size), or null. */
export function deckZoneContext(kindId: string | undefined): GraphicsContext | null {
  const zone = deckZoneOf(kindId);
  if (zone === null) return null;
  const key = zone === 'capital' ? 'capital' : kindId!;
  const cached = zoneContexts.get(key);
  if (cached !== undefined) return cached;
  const ctx = new GraphicsContext();
  if (zone === 'capital') drawCapital(ctx);
  else {
    const k = getStructureKind(kindId);
    if (zone === 'industry') drawIndustry(ctx, k.footprint.w, k.footprint.h);
    else drawGun(ctx, k.radius);
  }
  zoneContexts.set(key, ctx);
  return ctx;
}

interface ZoneEntry { g: Graphics; kind: string; stamp: number; x: number; y: number; a: number }

/**
 * The zone paint of every marked structure on a deck. The swarm updater calls
 * {@link note} for each structure it poses; {@link StructureDeckPlates.sync}
 * calls {@link frame} at the start of the next frame (sweep + new stamp).
 */
export class StructureDeckZones {
  private readonly entries = new Map<number, ZoneEntry>();
  private stamp = 0;
  /** The room floors its plates (the plates' deck flag): off ⇒ no paint. */
  deck = false;
  private readonly sweepFn = (e: ZoneEntry, id: number): void => {
    if (e.stamp !== this.stamp) this.drop(id, e);
  };

  constructor(private readonly shipContainer: Container) {}

  /** Live markings (tests, stats). */
  get size(): number { return this.entries.size; }

  /** The marking Graphics of structure `id` (tests). */
  graphicsOf(id: number): Graphics | undefined { return this.entries.get(id)?.g; }

  /** Free the paint of structures not noted since the last call, then start a frame. */
  frame(deck: boolean): void {
    this.deck = deck;
    if (!deck) this.stamp++; // off the deck: everything goes now
    this.entries.forEach(this.sweepFn);
    this.stamp++;
  }

  /** Structure `id` of kind `kindId` stands at game pose (x, y, angle) this frame. */
  note(id: number, kindId: string | undefined, x: number, y: number, angle: number): void {
    if (!this.deck) return;
    let e = this.entries.get(id);
    if (e !== undefined && e.kind !== kindId) { this.drop(id, e); e = undefined; } // recycled id
    if (e === undefined) {
      const ctx = deckZoneContext(kindId);
      if (ctx === null) return;
      const g = new Graphics(ctx);
      g.label = 'deckZone';
      g.zIndex = DECK_ZONE_Z;
      this.shipContainer.sortableChildren = true;
      this.shipContainer.addChild(g);
      e = { g, kind: kindId!, stamp: 0, x: Number.NaN, y: Number.NaN, a: Number.NaN };
      this.entries.set(id, e);
    }
    e.stamp = this.stamp;
    if (e.x === x && e.y === y && e.a === angle) return;
    e.x = x; e.y = y; e.a = angle;
    e.g.position.set(x, -y); // Y-flip
    // The Capital's border is its deck hex: it never turns with the building.
    e.g.rotation = e.kind === 'capital' ? 0 : -angle;
  }

  destroy(): void {
    this.stamp++;
    this.entries.forEach(this.sweepFn);
  }

  private drop(id: number, e: ZoneEntry): void {
    e.g.parent?.removeChild(e.g);
    e.g.destroy(); // the shared context survives
    this.entries.delete(id);
  }
}
