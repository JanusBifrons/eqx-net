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
 * glow + bright dot). Where 3+ arms meet, every arm's centre line starts with a
 * dash at the centre, so the lines meet there (a Y, a T, a cross… whatever the
 * mask), with a round amber cap over the joint. All flat:
 * ships fly over it.
 */
import type { GraphicsContext } from 'pixi.js';
import type { StructureKindId } from '../../../shared-types/structureKinds.js';
import type { StructureRenderState } from '../../../core/contracts/IRenderer.js';
import { DECK_HEX_INRADIUS } from '../../../core/hex/deckCorners.js';
import { LAMP_AMBER, LAMP_WHITE, mixColor, outlinePx, poly, scalePts, type StyleCtx } from './structureStyleKit.js';
import { DECK_FILL, DECK_SEAM } from './structureDeckPlates.js';
import type { BodyStatusHook } from './structureSocketNubs.js';
import { roadArmsOf } from './roadJoins.js';

/** Road deck tile bake (`road`, flat 800 × 692 hex): the paving only. */
export function road(c: StyleCtx): void {
  const out = outlinePx(c.kindId, c.styleId);
  poly(c, out, DECK_SEAM, 'metal', 0.5, 1);
  poly(c, scalePts(out, 0.93), DECK_FILL, 'metal', 0.5, 1, { seams: 48, seamAngle: Math.PI / 2 });
}

// ── Overlay geometry (local Pixi frame, world units) ───────────────────────

/** Arm length: centre to the deck hex's edge midpoint (the seam). */
export const ROAD_ARM_LEN = DECK_HEX_INRADIUS;
/** Carriageway half width (under a shield gate's 416 u span). */
export const ROAD_HALF_W = 175;
const EDGE_OFF = ROAD_HALF_W - 18;
const EDGE_W = 10;
const LAMP_OFF = ROAD_HALF_W + 34;
const LAMP_STEP = 130;
const DASH_LEN = 60;
const DASH_GAP = 50;
const DASH_W = 10;

const LANE = mixColor(DECK_FILL, 0x000000, 0.45);
const EDGE_LINE = mixColor(LAMP_WHITE, DECK_FILL, 0.3);

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
function circle(cx: number, cy: number, r: number, n = 16): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) { const a = (i * 2 * Math.PI) / n; out.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  return out;
}

/** Arm slot `j`'s angle (radians, Pixi local). */
const armAngle = (j: number): number => ((30 + 60 * j) * Math.PI) / 180;

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
}

export function roadOverlayPlan(mask: number): RoadOverlayPlan {
  const slots: number[] = [];
  for (let j = 0; j < 6; j++) if ((mask >> j) & 1) slots.push(j);
  const junction = slots.length >= 3;
  const edges: number[][] = [];
  const lamps: number[] = [];
  const dashes: number[] = [];
  const n = slots.length;
  const R = ROAD_ARM_LEN;
  for (let k = 0; k < n; k++) {
    const ja = slots[k]!, jb = slots[(k + 1) % n]!;
    const gap = n === 1 ? 6 : ((jb - ja + 6) % 6 || 6);
    const ta = armAngle(ja), tb = armAngle(jb);
    const ua = [Math.cos(ta), Math.sin(ta)] as const, ub = [Math.cos(tb), Math.sin(tb)] as const;
    const pa = [-ua[1], ua[0]] as const; // arm a's side toward b
    const qb = [ub[1], -ub[0]] as const; // arm b's side toward a
    const line: number[] = [ua[0] * R + pa[0] * EDGE_OFF, ua[1] * R + pa[1] * EDGE_OFF];
    const alpha = (gap * Math.PI) / 3;
    if (gap < 3) {
      const tc = EDGE_OFF / Math.tan(alpha / 2);
      line.push(ua[0] * tc + pa[0] * EDGE_OFF, ua[1] * tc + pa[1] * EDGE_OFF);
    } else if (gap > 3) {
      // Round the outside of the bend about the centre.
      const a0 = ta + Math.PI / 2, steps = 4 * (gap - 3);
      for (let s = 0; s <= steps; s++) {
        const a = a0 + ((alpha - Math.PI) * s) / steps;
        line.push(Math.cos(a) * EDGE_OFF, Math.sin(a) * EDGE_OFF);
      }
    }
    line.push(ub[0] * R + qb[0] * EDGE_OFF, ub[1] * R + qb[1] * EDGE_OFF);
    edges.push(line);
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
  const t0 = junction ? 0 : 25;
  for (const j of slots) {
    const a = armAngle(j), ux = Math.cos(a), uy = Math.sin(a);
    for (let t = t0; t + DASH_LEN <= R - 20; t += DASH_LEN + DASH_GAP) dashes.push(ux * t, uy * t, ux * (t + DASH_LEN), uy * (t + DASH_LEN));
  }
  return { slots, junction, edges, lamps, dashes };
}

/** Draw the overlay for local arm mask `mask` into `g` (cold: once per mask). */
export function drawRoadOverlay(g: GraphicsContext, mask: number): void {
  const plan = roadOverlayPlan(mask);
  const R = ROAD_ARM_LEN, W = ROAD_HALF_W;
  // Carriageway: one band per arm and a centre disc that fills the joint.
  for (const j of plan.slots) {
    const a = armAngle(j), ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    fillPoly(g, [px * W, py * W, ux * R + px * W, uy * R + py * W, ux * R - px * W, uy * R - py * W, -px * W, -py * W], LANE, 1);
  }
  fillPoly(g, circle(0, 0, W, 24), LANE, 1);
  for (const line of plan.edges) {
    g.moveTo(line[0]!, line[1]!);
    for (let i = 2; i < line.length; i += 2) g.lineTo(line[i]!, line[i + 1]!);
    strokeNow(g, EDGE_LINE, 0.85, EDGE_W);
  }
  const d = plan.dashes;
  for (let i = 0; i < d.length; i += 4) g.moveTo(d[i]!, d[i + 1]!).lineTo(d[i + 2]!, d[i + 3]!);
  if (d.length > 0) strokeNow(g, LAMP_AMBER, 0.9, DASH_W);
  // The centre lines meet here: one round cap hides the butt-end notches.
  if (plan.junction) fillPoly(g, circle(0, 0, DASH_W * 0.75, 12), LAMP_AMBER, 0.9);
  const l = plan.lamps;
  for (let i = 0; i < l.length; i += 2) fillPoly(g, circle(l[i]!, l[i + 1]!, 24), LAMP_AMBER, 0.16);
  for (let i = 0; i < l.length; i += 2) fillPoly(g, circle(l[i]!, l[i + 1]!, 7, 10), LAMP_AMBER, 1);
  for (let i = 0; i < l.length; i += 2) fillPoly(g, circle(l[i]!, l[i + 1]!, 3, 8), LAMP_WHITE, 1);
}

/** Overlay code: 64 | the road's local arm mask (never 0, so it always draws). */
export function roadCode(_kind: StructureKindId, _st: StructureRenderState | undefined, _tick = 0, id?: number): number {
  return 64 | roadArmsOf(id);
}

/** The road's carriageway overlay (`BodyStatusHook`). */
export const roadStatus: BodyStatusHook = {
  code: roadCode,
  draw: (g, code) => { if (code > 0) drawRoadOverlay(g, code & 63); },
};
