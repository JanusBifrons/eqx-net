/**
 * Style C "transport" — the ROAD deck tile (base platforms slices 20, 31).
 *
 * The baked body is only the tile's paving: a dark seam kerb and the deck
 * plates' own fill (`structureDeckPlates.ts`), so it reads as part of the
 * floor. The carriageway itself is the road's body-status overlay
 * ({@link roadStatus}, the socket-nub context, shared per arm mask): it must
 * run past the 800 u footprint the bake is cut to, out to the deck hex's edge
 * midpoints (650 u), and it depends on the neighbours (`roadJoins.ts`).
 *
 * The overlay, in the road's local Pixi frame (the deck hex is flat-top there,
 * edge midpoints at 30° + 60°·j): a dark carriageway arm from the centre to
 * each edge in the mask, pale edge lines along both sides (meeting at bends),
 * an amber dashed centre line, small amber lamps outside the edge lines (soft
 * glow + bright dot). The dashes repeat a whole number of times per arm
 * (ROAD_DASH_PERIOD) with a dash centred on both the hex centre and the seam:
 * each arm ends in a half dash, so a neighbour's half completes it across the
 * seam, and at the centre the arms' half dashes meet (one dash through a
 * straight, an equal-pronged Y, T or cross at a junction, a round cap on the
 * joint). All flat:
 * ships fly over it.
 *
 * Lit deck spike (`?deckLit=on`, `StyleCtx.arms` set): the carriageway SURFACE
 * of the same plan is baked into the road's art (`roadLitPolys`,
 * `structureStyleC.transport.roadLit.ts`) on the full deck hex; the overlay
 * then skips only its carriageway fill (`ROAD_LIT_SURFACE`) and still paints
 * the edge lines, dashes and lamps crisp on top.
 */
import type { GraphicsContext } from 'pixi.js';
import type { StructureKindId } from '../../../shared-types/structureKinds.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { DECK_HEX_INRADIUS } from '../../../core/hex/deckCorners.js';
import { LAMP_AMBER, LAMP_WHITE, mixColor, outlinePx, poly, scalePts, type StyleCtx } from './structureStyleKit.js';
import { DECK_FILL, DECK_SEAM } from './structureDeckPlates.js';
import type { BodyStatusHook } from './structureSocketNubs.js';
import { roadArmsOf } from './roadJoins.js';
import { roadLitPolys } from './structureStyleC.transport.roadLit.js';

/** Road deck tile bake (`road`, flat 800 × 692 hex): the paving only; with
 *  an arm mask (lit deck spike) the carriageway too, on the full deck hex. */
export function road(c: StyleCtx): void {
  const out = outlinePx(c.kindId, c.styleId);
  poly(c, out, DECK_SEAM, 'metal', 0.5, 1);
  poly(c, scalePts(out, 0.93), DECK_FILL, 'metal', 0.5, 1, { seams: 48, seamAngle: Math.PI / 2 });
  if (c.arms !== undefined) roadLitPolys(c, roadOverlayPlan(c.arms));
}

// ── Overlay geometry (local Pixi frame, world units) ───────────────────────

/** Arm length: centre to the deck hex's edge midpoint (the seam). */
export const ROAD_ARM_LEN = DECK_HEX_INRADIUS;
/** Carriageway half width (under a shield gate's 416 u span). */
export const ROAD_HALF_W = 175;
/** The lit carriageway outline runs this far past the seam (over a texel at
 *  the lit bake's density), so its edge fade lies under the neighbour's art. */
export const ROAD_LANE_OVERRUN = 4;
const EDGE_OFF = ROAD_HALF_W - 18;
const EDGE_W = 10;
const LAMP_OFF = ROAD_HALF_W + 34;
const LAMP_STEP = 130;
const DASH_LEN = 60;
/** Dash repeat along an arm: the arm length split into whole repeats (~110 u). */
export const ROAD_DASH_PERIOD = DECK_HEX_INRADIUS / Math.round(DECK_HEX_INRADIUS / 110);
const DASH_W = 10;

/** Carriageway, edge line and dash widths (the lit bake reads them too). */
export const ROAD_EDGE_W = EDGE_W;
export const ROAD_DASH_W = DASH_W;
export const ROAD_LANE = mixColor(DECK_FILL, 0x000000, 0.45);
export const ROAD_EDGE_LINE = mixColor(LAMP_WHITE, DECK_FILL, 0.3);
const LANE = ROAD_LANE;
const EDGE_LINE = ROAD_EDGE_LINE;

const _fill = { color: 0, alpha: 1 };
const _stroke = { color: 0, alpha: 1, width: 0, cap: 'butt' as const, join: 'miter' as const };

function fillPoly(g: GraphicsContext, pts: number[], color: number, alpha: number): void {
  _fill.color = color; _fill.alpha = alpha;
  g.poly(pts, true).fill(_fill);
}
function strokeNow(g: GraphicsContext, color: number, alpha: number, width: number): void {
  _stroke.color = color; _stroke.alpha = alpha; _stroke.width = width;
  g.stroke(_stroke);
}
export function circle(cx: number, cy: number, r: number, n = 16): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const a = (i * 2 * Math.PI) / n; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  return out;
}

/** Arm slot `j`'s angle (radians, Pixi local). */
export const armAngle = (j: number): number => ((30 + 60 * j) * Math.PI) / 180;

/** Is (x, y) on the carriageway of any arm in `slots` but `skip` (padded)? */
function onOtherArm(x: number, y: number, slots: readonly number[], skip: number, pad: number): boolean {
  for (const j of slots) {
    if (j === skip) continue;
    const a = armAngle(j), ux = Math.cos(a), uy = Math.sin(a);
    const along = x * ux + y * uy, lat = Math.abs(-x * uy + y * ux);
    if (along > -pad && along < ROAD_ARM_LEN + pad && lat < ROAD_HALF_W + pad) return true;
  }
  return false;
}

/** The pieces the overlay draws for a local arm mask (pure; tests read it). */
export interface RoadOverlayPlan {
  /** Arm slots, ascending. */
  slots: number[];
  junction: boolean;
  /** Edge lines as polylines (flat x, y). */
  edges: number[][];
  /** Lamp centres (flat x, y). */
  lamps: number[];
  /** Centre-line dashes as segments (x0, y0, x1, y1). */
  dashes: number[];
  /** Carriageway pieces the vector overlay fills, in order: one band per arm, then the centre disc. */
  bands: number[][];
  /** The carriageway as ONE outline (the union of `bands`; the lit bake's plate, so it never stacks). */
  lane: number[];
}

/** The side line between arms `ja` → `jb` (`gap` slots apart), `off` from
 *  the axes: arm a's end, the inner corner (or the outer arc about the
 *  centre, `arcK` steps per slot past a straight), arm b's end. Pushed onto `line`. */
function sideLine(line: number[], ja: number, jb: number, gap: number, off: number, arcK: number, R = ROAD_ARM_LEN): void {
  const ta = armAngle(ja), tb = armAngle(jb);
  const ua = [Math.cos(ta), Math.sin(ta)] as const, ub = [Math.cos(tb), Math.sin(tb)] as const;
  const pa = [-ua[1], ua[0]] as const; // arm a's side toward b
  const qb = [ub[1], -ub[0]] as const; // arm b's side toward a
  line.push(ua[0] * R + pa[0] * off, ua[1] * R + pa[1] * off);
  const alpha = (gap * Math.PI) / 3;
  if (gap < 3) {
    const tc = off / Math.tan(alpha / 2);
    line.push(ua[0] * tc + pa[0] * off, ua[1] * tc + pa[1] * off);
  } else if (gap > 3) {
    // Round the outside of the bend about the centre.
    const a0 = ta + Math.PI / 2, steps = arcK * (gap - 3);
    for (let s = 0; s <= steps; s++) {
      const a = a0 + ((alpha - Math.PI) * s) / steps;
      line.push(Math.cos(a) * off, Math.sin(a) * off);
    }
  }
  line.push(ub[0] * R + qb[0] * off, ub[1] * R + qb[1] * off);
}

export function roadOverlayPlan(mask: number): RoadOverlayPlan {
  const slots: number[] = [];
  for (let j = 0; j < 6; j++) if ((mask >> j) & 1) slots.push(j);
  const junction = slots.length >= 3;
  const edges: number[][] = [];
  const lamps: number[] = [];
  const dashes: number[] = [];
  const lane: number[] = [];
  const n = slots.length;
  const R = ROAD_ARM_LEN;
  for (let k = 0; k < n; k++) {
    const ja = slots[k]!, jb = slots[(k + 1) % n]!;
    const gap = n === 1 ? 6 : ((jb - ja + 6) % 6 || 6);
    const ta = armAngle(ja), tb = armAngle(jb);
    const ua = [Math.cos(ta), Math.sin(ta)] as const, ub = [Math.cos(tb), Math.sin(tb)] as const;
    const pa = [-ua[1], ua[0]] as const; // arm a's side toward b
    const qb = [ub[1], -ub[0]] as const; // arm b's side toward a
    const line: number[] = [];
    sideLine(line, ja, jb, gap, EDGE_OFF, 4);
    edges.push(line);
    sideLine(lane, ja, jb, gap, ROAD_HALF_W, 8, R + ROAD_LANE_OVERRUN);
    // Lamps outside this edge: each arm side is in exactly one pair.
    for (const [j, u, p] of [[ja, ua, pa], [jb, ub, qb]] as const) {
      for (let t = 100; t <= R - 50; t += LAMP_STEP) {
        const x = u[0] * t + p[0] * LAMP_OFF, y = u[1] * t + p[1] * LAMP_OFF;
        if (onOtherArm(x, y, slots, j, 30)) continue;
        if (Math.hypot(x, y) < ROAD_HALF_W + 40) continue;
        lamps.push(x, y);
      }
    }
  }
  const steps = Math.round(R / ROAD_DASH_PERIOD);
  for (const j of slots) {
    const a = armAngle(j), ux = Math.cos(a), uy = Math.sin(a);
    for (let k = 0; k <= steps; k++) {
      const c = k * ROAD_DASH_PERIOD;
      const t0 = Math.max(0, c - DASH_LEN / 2), t1 = Math.min(R, c + DASH_LEN / 2);
      dashes.push(ux * t0, uy * t0, ux * t1, uy * t1);
    }
  }
  const bands: number[][] = [];
  const W = ROAD_HALF_W;
  for (const j of slots) {
    const a = armAngle(j), ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    bands.push([px * W, py * W, ux * R + px * W, uy * R + py * W, ux * R - px * W, uy * R - py * W, -px * W, -py * W]);
  }
  bands.push(circle(0, 0, W, 24));
  return { slots, junction, edges, lamps, dashes, bands, lane };
}

/** Draw the overlay for local arm mask `mask` into `g` (cold: once per mask). */
export function drawRoadOverlay(g: GraphicsContext, mask: number, fill = true): void {
  const plan = roadOverlayPlan(mask);
  // Carriageway: one band per arm and a centre disc that fills the joint.
  if (fill) for (const b of plan.bands) fillPoly(g, b, LANE, 1);
  for (const line of plan.edges) {
    g.moveTo(line[0]!, line[1]!);
    for (let i = 2; i < line.length; i += 2) g.lineTo(line[i]!, line[i + 1]!);
    strokeNow(g, EDGE_LINE, 0.85, EDGE_W);
  }
  const d = plan.dashes;
  for (let i = 0; i < d.length; i += 4) g.moveTo(d[i]!, d[i + 1]!).lineTo(d[i + 2]!, d[i + 3]!);
  if (d.length > 0) strokeNow(g, LAMP_AMBER, 0.9, DASH_W);
  // Where arms meet at an angle, a round cap (the dash's own width) fills the
  // butt-end notch at the joint.
  if (plan.slots.length >= 2) fillPoly(g, circle(0, 0, DASH_W / 2, 12), LAMP_AMBER, 0.9);
  const l = plan.lamps;
  for (let i = 0; i < l.length; i += 2) fillPoly(g, circle(l[i]!, l[i + 1]!, 24), LAMP_AMBER, 0.16);
  for (let i = 0; i < l.length; i += 2) fillPoly(g, circle(l[i]!, l[i + 1]!, 7, 10), LAMP_AMBER, 1);
  for (let i = 0; i < l.length; i += 2) fillPoly(g, circle(l[i]!, l[i + 1]!, 3, 8), LAMP_WHITE, 1);
}

/** Overlay code bit (lit deck spike): the road's lit art carries the
 *  carriageway surface, so the overlay draws only its lines, dashes and lamps. */
export const ROAD_LIT_SURFACE = 128;

/** Overlay code: 64 | the road's local arm mask (never 0, so it always draws). */
export function roadCode(_kind: StructureKindId, _st: StructureRenderState | undefined, _tick = 0, id?: number): number {
  return 64 | roadArmsOf(id);
}

/** The road's carriageway overlay (`BodyStatusHook`). */
export const roadStatus: BodyStatusHook = {
  code: roadCode,
  draw: (g, code) => { if (code > 0) drawRoadOverlay(g, code & 63, (code & ROAD_LIT_SURFACE) === 0); },
};
