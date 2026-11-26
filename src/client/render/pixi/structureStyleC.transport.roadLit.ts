/**
 * Lit deck spike, slice 1 (`?deckLit=on`, .resume/deck-lit-plan.md): the road
 * tile's carriageway baked INTO the road's own `struct` bake, so it gets
 * height, normals and live lighting like any other structure art.
 *
 * One geometry source: this reads the same `roadOverlayPlan` the vector
 * overlay paints (`structureStyleC.transport.road.ts`) and turns each piece
 * into StyleCtx `poly()` calls:
 *  - the carriageway: ONE outline (`plan.lane`, the union of the overlay's
 *    bands and centre disc, so lifts never stack), dark 'metal' with a slight
 *    lift, plus fine expansion joints across each arm (shallow grooves);
 *  - edge lines and dashes: flat 'mark' paint strips;
 *  - lamps: a raised metal housing with a 'glow' lens (no point lights yet).
 *
 * The art frame is the whole deck hex (arms run to its edge midpoints), set
 * on the ctx for `poly`'s fit check. Cold path (bake time): allocates freely.
 */
import { DECK_HEX_SIZE } from '../../../core/hex/plates.js';
import { glow, LAMP_AMBER, ngon, poly, type Pt, type Pts, type StyleCtx } from './structureStyleKit.js';
import {
  armAngle, circle, ROAD_ARM_LEN, ROAD_DASH_PERIOD, ROAD_DASH_W, ROAD_EDGE_LINE, ROAD_EDGE_W, ROAD_HALF_W, ROAD_LANE, type RoadOverlayPlan,
} from './structureStyleC.transport.road.js';

/** The lit road's art frame: the full flat-top deck hex (2 u over, so the
 *  arm ends that sit exactly on the seam still fit). */
export const DECK_HEX_FRAME: Pts = ngon(0, 0, DECK_HEX_SIZE + 2, 6);

const LANE_LIFT = 1.5;
const MARK_LIFT = 0.3;
const JOINT_W = 2.5;
const LAMP_HOUSING = 0x3a3f48;
const LAMP_HOUSING_R = 13;
const LAMP_LENS_R = 7;

/** Flat (x, y) pairs as points. */
function pts(flat: readonly number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

/** A polyline (flat x, y) as a closed strip polygon `w` wide (mitred joins). */
export function strokeStrip(line: readonly number[], w: number): Pt[] {
  const n = line.length / 2, h = w / 2;
  const left: Pt[] = [], right: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const x = line[i * 2]!, y = line[i * 2 + 1]!;
    let nx = 0, ny = 0, k = 1;
    const seg = (a: number, b: number): [number, number] => {
      const dx = line[b * 2]! - line[a * 2]!, dy = line[b * 2 + 1]! - line[a * 2 + 1]!;
      const l = Math.hypot(dx, dy) || 1;
      return [-dy / l, dx / l];
    };
    if (i === 0) [nx, ny] = seg(0, 1);
    else if (i === n - 1) [nx, ny] = seg(n - 2, n - 1);
    else {
      const [ax, ay] = seg(i - 1, i), [bx, by] = seg(i, i + 1);
      const mx = ax + bx, my = ay + by, ml = Math.hypot(mx, my) || 1;
      nx = mx / ml; ny = my / ml;
      k = 1 / Math.max(0.25, nx * ax + ny * ay); // mitre length, capped
    }
    left.push([x + nx * h * k, y + ny * h * k]);
    right.push([x - nx * h * k, y - ny * h * k]);
  }
  return left.concat(right.reverse());
}

/** A segment (x0, y0) → (x1, y1) as a quad `w` wide. */
function segQuad(x0: number, y0: number, x1: number, y1: number, w: number): Pt[] {
  const l = Math.hypot(x1 - x0, y1 - y0) || 1;
  const px = (-(y1 - y0) / l) * (w / 2), py = ((x1 - x0) / l) * (w / 2);
  return [[x0 + px, y0 + py], [x1 + px, y1 + py], [x1 - px, y1 - py], [x0 - px, y0 - py]];
}

/** Bake the road plan into `c` (its art frame becomes the full deck hex). */
export function roadLitPolys(c: StyleCtx, plan: RoadOverlayPlan): void {
  c.frame = DECK_HEX_FRAME;
  // Carriageway: one plate, then shallow joints across each arm (clear of the hub).
  poly(c, pts(plan.lane), ROAD_LANE, 'metal', LANE_LIFT, 3);
  for (const j of plan.slots) {
    const a = armAngle(j), ux = Math.cos(a), uy = Math.sin(a), px = -uy, py = ux;
    const W = ROAD_HALF_W - 4;
    for (let t = ROAD_DASH_PERIOD / 2; t < ROAD_ARM_LEN - 10; t += ROAD_DASH_PERIOD) {
      if (t < ROAD_HALF_W + 20) continue;
      poly(c, segQuad(ux * t + px * W, uy * t + py * W, ux * t - px * W, uy * t - py * W, JOINT_W), ROAD_LANE, 'metal', -0.4, 0.5);
    }
  }
  for (const line of plan.edges) poly(c, strokeStrip(line, ROAD_EDGE_W), ROAD_EDGE_LINE, 'mark', MARK_LIFT, 0.5);
  const d = plan.dashes;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === d[i + 2] && d[i + 1] === d[i + 3]) continue;
    poly(c, segQuad(d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!, ROAD_DASH_W), LAMP_AMBER, 'mark', MARK_LIFT, 0.5);
  }
  if (plan.slots.length >= 2) poly(c, pts(circle(0, 0, ROAD_DASH_W / 2, 12)), LAMP_AMBER, 'mark', MARK_LIFT, 0.5);
  const l = plan.lamps;
  for (let i = 0; i < l.length; i += 2) {
    poly(c, pts(circle(l[i]!, l[i + 1]!, LAMP_HOUSING_R, 16)), LAMP_HOUSING, 'metal', 4, 2);
    glow(c, pts(circle(l[i]!, l[i + 1]!, LAMP_LENS_R, 12)), LAMP_AMBER);
  }
}
