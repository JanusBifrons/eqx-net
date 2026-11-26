/**
 * Lit deck spike (`?deckLit=on`, .resume/deck-lit-plan.md): the road tile's
 * carriageway SURFACE baked into the road's own `struct` bake, so it gets
 * height, normals and live lighting like any other structure art. The edge
 * lines, centre dashes and lamps stay the crisp vector overlay on top
 * (`structureStyleC.transport.road.ts`, `ROAD_LIT_SURFACE`): at the lit
 * bake's density (DECK_LIT_PPU, ~2.4 u a texel) thin paint would stair-step.
 *
 * One geometry source: this reads the same `roadOverlayPlan` the overlay
 * paints. Only low-frequency detail, which survives that density:
 *  - the carriageway: ONE outline (`plan.lane`), dark 'metal' LEVELLED at
 *    height 0 (`PolyOp.level`): no lift, so no bevel rim at its edges, and
 *    the paving's own edge ramps under it are flattened away;
 *  - panel joints across each arm: shallow grooves a few texels wide, half a
 *    period off the hex centre so they line up across the seam with the
 *    neighbour's (the arm is a whole number of periods; none on the seam);
 *  - panels a few percent lighter or darker (seeded; the half panel at the
 *    seam stays the base tone so two tiles' halves read as one panel);
 *  - two worn wheel tracks along each arm, running on across the seam.
 * The forge's own grime noise lies over all of it.
 *
 * The seam (slice 1 review): the old plate had a 1.5 u lift with a 3 u bevel,
 * so its arm end was a lit rim, and its edge fade sat exactly on the seam, on
 * the texture's last texel row (box margin 2 u). Now the surface is flat at
 * the seam, runs ROAD_LANE_OVERRUN past it, and the box has room for it.
 *
 * The art frame is the whole deck hex (+ the overrun), set on the ctx for
 * `poly`'s fit check. Cold path (bake time): allocates freely.
 */
import { DECK_HEX_SIZE } from '../../../core/hex/plates.js';
import { mixColor, ngon, poly, rng, type Pt, type Pts, type StyleCtx } from './structureStyleKit.js';
import {
  armAngle, ROAD_ARM_LEN, ROAD_DASH_PERIOD, ROAD_HALF_W, ROAD_LANE, ROAD_LANE_OVERRUN, type RoadOverlayPlan,
} from './structureStyleC.transport.road.js';

/** The lit road's art frame: the full flat-top deck hex, grown so the
 *  carriageway's overrun past the seam still fits. */
export const DECK_HEX_FRAME: Pts = ngon(0, 0, DECK_HEX_SIZE + 8, 6);

/** Panel joint width (u; ~2 texels at DECK_LIT_PPU) and depth. */
export const ROAD_JOINT_W = 5;
const JOINT_DEPTH = -0.5;
const JOINT = mixColor(ROAD_LANE, 0x000000, 0.25);
/** Panel tone spread (fraction toward black / white). */
const PANEL_TONE = 0.06;
/** Wheel tracks: lateral offset (fraction of the half width) and width (u). */
const TRACK_OFF = 0.5;
const TRACK_W = 44;
const TRACK = mixColor(ROAD_LANE, 0x000000, 0.12);

/** Flat (x, y) pairs as points. */
function pts(flat: readonly number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

/** The band along arm direction (ux, uy) from t0 to t1, lateral s0..s1. */
function armBand(ux: number, uy: number, t0: number, t1: number, s0: number, s1: number): Pt[] {
  const px = -uy, py = ux;
  return [
    [ux * t0 + px * s0, uy * t0 + py * s0], [ux * t1 + px * s0, uy * t1 + py * s0],
    [ux * t1 + px * s1, uy * t1 + py * s1], [ux * t0 + px * s1, uy * t0 + py * s1],
  ];
}

/** Joint positions along an arm: half a period off the centre, clear of the
 *  hub, never on the seam. Pure (tests read it). */
export function roadJointTs(): number[] {
  const out: number[] = [];
  for (let t = ROAD_DASH_PERIOD / 2; t < ROAD_ARM_LEN; t += ROAD_DASH_PERIOD) if (t > ROAD_HALF_W + 20) out.push(t);
  return out;
}

/** Bake the road's carriageway surface into `c` (its frame becomes the deck hex). */
export function roadLitPolys(c: StyleCtx, plan: RoadOverlayPlan): void {
  c.frame = DECK_HEX_FRAME;
  const flat = { level: 0 };
  poly(c, pts(plan.lane), ROAD_LANE, 'metal', 0, 0.5, flat);
  const joints = roadJointTs();
  const r = rng(c.seed * 6151 + 31);
  const W = ROAD_HALF_W - 2, end = ROAD_ARM_LEN + ROAD_LANE_OVERRUN;
  for (const j of plan.slots) {
    const a = armAngle(j), ux = Math.cos(a), uy = Math.sin(a);
    // Panel tones between joints (the outer half panel keeps the base tone).
    for (let k = 0; k + 1 < joints.length; k++) {
      const tone = (r() * 2 - 1) * PANEL_TONE;
      const col = mixColor(ROAD_LANE, tone < 0 ? 0x000000 : 0xffffff, Math.abs(tone));
      poly(c, armBand(ux, uy, joints[k]!, joints[k + 1]!, -W, W), col, 'metal', 0, 0.5, flat);
    }
    // Worn wheel tracks, on past the seam into the neighbour's identical ones.
    for (const side of [-1, 1]) {
      const s = side * W * TRACK_OFF;
      poly(c, armBand(ux, uy, ROAD_HALF_W, end, s - TRACK_W / 2, s + TRACK_W / 2), TRACK, 'metal', 0, 0.5, flat);
    }
    for (const t of joints) poly(c, armBand(ux, uy, t - ROAD_JOINT_W / 2, t + ROAD_JOINT_W / 2, -W, W), JOINT, 'metal', JOINT_DEPTH, 1.5, flat);
  }
}
