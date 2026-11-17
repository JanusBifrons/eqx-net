/**
 * structure-restyle 2g: the dock crane never swings through its own dock.
 *
 * Bug: a reach to the pad's far corner swung the arm through the dock
 * building, then out past the pad's edge on the way back. This samples the
 * boom and jib (midpoints and the elbow) and the clamp tip every half tick of
 * `arm-reach`, `arm-retract` and an aborted reach (retract from the arm's
 * current tip, as `rigClipTip` does), for targets all over the pad.
 *
 * Allowed zone inside the footprint (y < the open edge), by design only:
 *  - the TOWER: within `DOCK_CRANE_TOWER_INSET + 10` of the pivot (the roof
 *    tower the crane slews on; a folded arm's tip passes over it);
 *  - the ROOF LANE: the strip along the open edge the crane slews over, a
 *    boom's length (+25 for its end) either side of the pivot, from 65
 *    below the pivot line up to the open edge. The stowed arm lies in it
 *    (boom along -x, jib folded back over it, tip ≈ 55 below the pivot).
 *    It is two-sided because the jib unfolds from its fold about an elbow
 *    at most 390 above the pivot, so its tip leaves the tower skimming this
 *    strip on whichever side the target is (CCW to the left, CW to the
 *    right); no fixed waypoint avoids that.
 * Everything else below the open edge is the building and is never entered.
 * The tip also never leaves the landing apron (the `lip` outline) ∪ that
 * allowed zone, so it never swings out past the pad's edges either.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { rigPartIndex, type Rig } from './rig.js';
import { createRigPose, evaluateRig, type PlayingClip, type RigPose } from './evaluate.js';
import { twoBoneIkSolve } from './ikAdapter.js';
import {
  DOCK_BAY_CX, DOCK_BAY_CY, DOCK_BAY_HALF_H, DOCK_BAY_HALF_W, DOCK_CRANE_BOOM, DOCK_CRANE_JIB,
  DOCK_CRANE_PIVOT_X, DOCK_CRANE_PIVOT_Y, DOCK_CRANE_REACH_TICKS, DOCK_CRANE_TOWER_INSET,
  FREIGHT_DOCK_HALF_H, rigForStructureKind,
} from './rigCatalogue.js';

const rig: Rig = rigForStructureKind('freight_dock')!;
const pose: RigPose = createRigPose(rig);
const BOOM = rigPartIndex(rig, 'boom');
const JIB = rigPartIndex(rig, 'jib');
const CLAMP = rigPartIndex(rig, 'clamp');

const OPEN_EDGE = FREIGHT_DOCK_HALF_H;
const TOWER_R = DOCK_CRANE_TOWER_INSET + 10;
const LANE_X0 = DOCK_CRANE_PIVOT_X - DOCK_CRANE_BOOM - 25;
const LANE_X1 = DOCK_CRANE_PIVOT_X + DOCK_CRANE_BOOM + 25;
const LANE_Y0 = DOCK_CRANE_PIVOT_Y - 65;

// Landing apron = the painted `lip` outline (host frame).
const lip = rig.parts[rigPartIndex(rig, 'lip')]!;
const lipXs = lip.outline!.filter((_, k) => k % 2 === 0).map((v) => lip.anchorX + v);
const lipYs = lip.outline!.filter((_, k) => k % 2 === 1).map((v) => lip.anchorY + v);
const APRON = { x0: Math.min(...lipXs), x1: Math.max(...lipXs), y0: Math.min(...lipYs), y1: Math.max(...lipYs) };

const EPS = 1e-6;
const inTower = (x: number, y: number): boolean =>
  Math.hypot(x - DOCK_CRANE_PIVOT_X, y - DOCK_CRANE_PIVOT_Y) <= TOWER_R;
const inRoofLane = (x: number, y: number): boolean =>
  x >= LANE_X0 && x <= LANE_X1 && y >= LANE_Y0 && y <= OPEN_EDGE + EPS;
const allowedInside = (x: number, y: number): boolean => inTower(x, y) || inRoofLane(x, y);
const bodyOk = (x: number, y: number): boolean => y >= OPEN_EDGE - EPS || allowedInside(x, y);
const tipOk = (x: number, y: number): boolean =>
  (x >= APRON.x0 - EPS && x <= APRON.x1 + EPS && y >= APRON.y0 - EPS && y <= APRON.y1 + EPS)
  || allowedInside(x, y);

/** First violation along a clip, or null. Samples every half tick. */
function firstViolation(playing: PlayingClip, from = 0): string | null {
  for (let t = from; t <= DOCK_CRANE_REACH_TICKS + 1; t += 0.5) {
    evaluateRig(rig, playing, playing.startTick + t, pose, twoBoneIkSolve);
    const bx = pose.x[BOOM]!, by = pose.y[BOOM]!;
    const ex = pose.x[JIB]!, ey = pose.y[JIB]!;
    const cx = pose.x[CLAMP]!, cy = pose.y[CLAMP]!;
    const samples: readonly (readonly [string, number, number])[] = [
      ['boom mid', bx + (DOCK_CRANE_BOOM / 2) * pose.cos[BOOM]!, by + (DOCK_CRANE_BOOM / 2) * pose.sin[BOOM]!],
      ['elbow', ex, ey],
      ['jib mid', ex + (DOCK_CRANE_JIB / 2) * pose.cos[JIB]!, ey + (DOCK_CRANE_JIB / 2) * pose.sin[JIB]!],
      ['clamp', cx, cy],
    ];
    for (const [name, x, y] of samples) {
      if (!bodyOk(x, y)) return `${playing.clipId} t=${t}: ${name} in the building at (${x.toFixed(1)}, ${y.toFixed(1)})`;
    }
    if (!tipOk(cx, cy)) return `${playing.clipId} t=${t}: clamp off the pad at (${cx.toFixed(1)}, ${cy.toFixed(1)})`;
  }
  return null;
}

/** The clamp tip at `tick` of `playing` (what `rigClipTip` reports), float32 like the wire. */
function tipAt(playing: PlayingClip, tick: number): { x: number; y: number; boom: number; jib: number } {
  evaluateRig(rig, playing, tick, pose, twoBoneIkSolve);
  return { x: Math.fround(pose.x[CLAMP]!), y: Math.fround(pose.y[CLAMP]!), boom: pose.angle[BOOM]!, jib: pose.angle[JIB]! };
}
const angleGap = (a: number, b: number): number => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** Abort a reach to `target` at `abortTick` and retract from the tip it got to
 *  (as `rigClipTip` does): the first violation, or a pose jump at the start, or null. */
function abortViolation(target: { x: number; y: number }, abortTick: number): string | null {
  const tip = tipAt({ clipId: 'arm-reach', startTick: 0, target }, abortTick);
  const retract: PlayingClip = { clipId: 'arm-retract', startTick: abortTick, target: { x: tip.x, y: tip.y } };
  const v = firstViolation(retract);
  if (v !== null) return v;
  const start = tipAt(retract, abortTick);
  // Same pose, not just the same tip: no flip of the boom or the jib.
  const inPlace = Math.hypot(start.x - tip.x, start.y - tip.y) < 0.5
    && angleGap(start.boom, tip.boom) < 0.01 && angleGap(start.jib, tip.jib) < 0.01;
  return inPlace ? null : `retract starts off the aborted pose`;
}

const X0 = DOCK_BAY_CX - DOCK_BAY_HALF_W, X1 = DOCK_BAY_CX + DOCK_BAY_HALF_W;
const Y0 = DOCK_BAY_CY - DOCK_BAY_HALF_H, Y1 = DOCK_BAY_CY + DOCK_BAY_HALF_H;
const padPoint = fc.record({
  x: fc.double({ min: X0, max: X1, noNaN: true }).map(Math.fround),
  y: fc.double({ min: Y0, max: Y1, noNaN: true }).map(Math.fround),
});
/** Corners, edge midpoints, the centre, and the reported far corner. */
const NAMED: readonly { x: number; y: number }[] = [
  { x: X0, y: Y0 }, { x: X1, y: Y0 }, { x: X0, y: Y1 }, { x: X1, y: Y1 },
  { x: DOCK_BAY_CX, y: Y0 }, { x: DOCK_BAY_CX, y: Y1 }, { x: X0, y: DOCK_BAY_CY }, { x: X1, y: DOCK_BAY_CY },
  { x: DOCK_BAY_CX, y: DOCK_BAY_CY }, { x: -380, y: 640 }, { x: 380, y: 640 }, { x: 200, y: 460 },
  { x: 0.5, y: Y0 }, { x: -0.5, y: Y0 },
];

describe('dock crane path (structure-restyle 2g): never through its own dock', () => {
  it('the allowed zone holds the stowed arm and excludes the old far-corner swing', () => {
    expect(firstViolation({ clipId: 'arm-retract', startTick: -1000 })).toBeNull(); // rest
    // The point the old linear reach swung the jib tip through (deep in the dock house).
    expect(bodyOk(-358, 34)).toBe(false);
  });

  it('arm-reach, arm-hold and arm-retract stay out of the building, tip on the apron (named points)', () => {
    for (const target of NAMED) {
      for (const clipId of ['arm-reach', 'arm-hold', 'arm-retract']) {
        expect(firstViolation({ clipId, startTick: 100, target }), `${clipId} → (${target.x}, ${target.y})`).toBeNull();
      }
      evaluateRig(rig, { clipId: 'arm-reach', startTick: 0, target }, DOCK_CRANE_REACH_TICKS, pose, twoBoneIkSolve);
      expect(Math.hypot(pose.x[CLAMP]! - target.x, pose.y[CLAMP]! - target.y), 'reaches').toBeLessThan(1e-3);
    }
  });

  it('property: reach and retract to any pad point stay out of the building', () => {
    fc.assert(fc.property(padPoint, (target) => {
      const reach = firstViolation({ clipId: 'arm-reach', startTick: 0, target });
      const retract = firstViolation({ clipId: 'arm-retract', startTick: 0, target });
      return reach === null && retract === null;
    }), { numRuns: 400 });
  });

  it('property: an aborted reach (retract from the current tip) stays out, starting in place', () => {
    fc.assert(fc.property(
      padPoint, fc.integer({ min: 1, max: DOCK_CRANE_REACH_TICKS - 1 }),
      (target, abortTick) => abortViolation(target, abortTick) === null,
    ), { numRuns: 400 });
  });

  it('regression: aborting a reach to the far left corner (-445.1, 710) at tick 53 stays on the apron', () => {
    // fast-check counterexample [{"x":-445.1157531738281,"y":710},53]: the
    // retract from that mid-reach tip used to lift the clamp out to y 722.0,
    // past the apron edge, instead of retracing the reach.
    const target = { x: Math.fround(-445.1157531738281), y: 710 };
    expect(abortViolation(target, 53)).toBeNull();
    for (const t of [target, ...NAMED]) {
      for (let abortTick = 1; abortTick < DOCK_CRANE_REACH_TICKS; abortTick++) {
        expect(abortViolation(t, abortTick), `(${t.x}, ${t.y}) aborted at ${abortTick}`).toBeNull();
      }
    }
  });
});
