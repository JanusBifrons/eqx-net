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
 *
 * structure-restyle 3i: the same checks run on the Capital's bay (same arm,
 * its own tower and pad). Outside the footprint beside the hull is not the
 * building. The tip-on-apron rule is the dock's only: the Capital's 500-wide
 * apron is narrower than the arm's swing (a near target leaves the elbow out
 * to the side, over open space in front of the hull).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { rigPartIndex, type Rig } from './rig.js';
import { createRigPose, evaluateRig, type PlayingClip, type RigPose } from './evaluate.js';
import { twoBoneIkSolve } from './ikAdapter.js';
import {
  CAPITAL_BAY, DOCK_CRANE_BOOM, DOCK_CRANE_JIB, DOCK_CRANE_REACH_TICKS, FREIGHT_DOCK_BAY, rigById, type CraneBay,
} from './rigCatalogue.js';

/**
 * Joint speed caps (rad/tick), from the clip length. Each half of a reach or
 * retract is DOCK_CRANE_REACH_TICKS / 2 = 30 ticks on smoothstep, whose peak
 * speed is 1.5x its mean. The stow <-> READY half swings the boom a quarter
 * turn: 1.5 * (π/2) / 30 ≈ 0.0785, the arm's design speed (STOW_SPEED). The
 * straight half moves the joints by a travel that depends on the target (up
 * to ~2.4 rad of jib unfold to the dock pad's far corners), so no joint may
 * outrun that travel evenly eased: 1.5 * travel / 30, +10 % for sampling
 * (and never under STOW_SPEED). The whip broke both: 0.144 at the dock pad's
 * centre, 0.090 at the Capital bay's.
 */
const STOW_SPEED = 0.08;
const PACE_SLACK = 1.1;

function describeCranePath(bay: CraneBay, tipOnApron: boolean, extra: readonly { x: number; y: number }[]): void {
  const rig: Rig = rigById(bay.rigId)!;
  const pose: RigPose = createRigPose(rig);
  const BOOM = rigPartIndex(rig, 'boom');
  const JIB = rigPartIndex(rig, 'jib');
  const CLAMP = rigPartIndex(rig, 'clamp');

  const OPEN_EDGE = bay.halfH;
  // The tower: the dock's 60 inset + 10 (the same tower on every kind).
  const TOWER_R = 70;
  const LANE_X0 = bay.pivotX - DOCK_CRANE_BOOM - 25;
  const LANE_X1 = bay.pivotX + DOCK_CRANE_BOOM + 25;
  const LANE_Y0 = bay.pivotY - 65;

  // Landing apron = the painted `lip` outline (host frame).
  const lip = rig.parts[rigPartIndex(rig, 'lip')]!;
  const lipXs = lip.outline!.filter((_, k) => k % 2 === 0).map((v) => lip.anchorX + v);
  const lipYs = lip.outline!.filter((_, k) => k % 2 === 1).map((v) => lip.anchorY + v);
  const APRON = { x0: Math.min(...lipXs), x1: Math.max(...lipXs), y0: Math.min(...lipYs), y1: Math.max(...lipYs) };

  const EPS = 1e-6;
  const inTower = (x: number, y: number): boolean =>
    Math.hypot(x - bay.pivotX, y - bay.pivotY) <= TOWER_R;
  const inRoofLane = (x: number, y: number): boolean =>
    x >= LANE_X0 && x <= LANE_X1 && y >= LANE_Y0 && y <= OPEN_EDGE + EPS;
  const allowedInside = (x: number, y: number): boolean => inTower(x, y) || inRoofLane(x, y);
  const bodyOk = (x: number, y: number): boolean => y >= OPEN_EDGE - EPS || Math.abs(x) >= bay.halfW - EPS || allowedInside(x, y);
  const tipOk = (x: number, y: number): boolean => !tipOnApron ||
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

  const X0 = bay.cx - bay.padHalfW, X1 = bay.cx + bay.padHalfW;
  const Y0 = bay.cy - bay.padHalfH, Y1 = bay.cy + bay.padHalfH;
  const padPoint = fc.record({
    x: fc.double({ min: X0, max: X1, noNaN: true }).map(Math.fround),
    y: fc.double({ min: Y0, max: Y1, noNaN: true }).map(Math.fround),
  });
  /** Corners, edge midpoints, the centre, and the reported far corner. */
  const NAMED: readonly { x: number; y: number }[] = [
    { x: X0, y: Y0 }, { x: X1, y: Y0 }, { x: X0, y: Y1 }, { x: X1, y: Y1 },
    { x: bay.cx, y: Y0 }, { x: bay.cx, y: Y1 }, { x: X0, y: bay.cy }, { x: X1, y: bay.cy },
    { x: bay.cx, y: bay.cy }, ...extra,
    { x: 0.5, y: Y0 }, { x: -0.5, y: Y0 },
  ];

  describe(`${bay.rigId} path (structure-restyle 2g, 3i): never through its own building`, () => {
    it('the allowed zone holds the stowed arm and excludes the old far-corner swing', () => {
      expect(firstViolation({ clipId: 'arm-retract', startTick: -1000 })).toBeNull(); // rest
      // A point deep in the building is never allowed (for the dock, where the
      // old linear reach swung the jib tip through).
      expect(bodyOk(bay.pivotX - 358, bay.pivotY - 106)).toBe(false);
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

    it('motion: from READY the clamp runs straight at the target and stops on it, one fold, no pop into hold', () => {
      // Bug (Capital bay take): the jib unfolded first (linear) while the boom
      // leant last (cubic 'in'), so the clamp swung out sideways and down
      // away from the ship, then the boom whipped it across at full speed and
      // the arm stopped dead in the hold pose (a one-frame snap). The retract
      // did the same in reverse.
      const READY_T = DOCK_CRANE_REACH_TICKS / 2;
      const fold = (v: number): number => (Math.sin(v) >= 0 ? 1 : -1);
      for (const target of NAMED) {
        const label = `(${target.x}, ${target.y})`;
        const reach: PlayingClip = { clipId: 'arm-reach', startTick: 0, target };
        const at = (p: PlayingClip, t: number) => {
          evaluateRig(rig, p, p.startTick + t, pose, twoBoneIkSolve);
          return { boom: pose.value[BOOM]!, jib: pose.value[JIB]!, x: pose.x[CLAMP]!, y: pose.y[CLAMP]! };
        };
        const start = at(reach, READY_T);
        const len = Math.hypot(target.x - start.x, target.y - start.y);
        const ux = (target.x - start.x) / len, uy = (target.y - start.y) / len;
        const f0 = fold(start.jib);
        let prev = start;
        for (let t = READY_T + 0.5; t <= DOCK_CRANE_REACH_TICKS; t += 0.5) {
          const p = at(reach, t);
          const dx = p.x - start.x, dy = p.y - start.y;
          // On the line from the READY tip to the target, never off to the side.
          expect(Math.abs(dx * uy - dy * ux), `${label} reach t=${t} off the line`).toBeLessThan(1);
          // Never moving away from the target.
          const d = Math.hypot(target.x - p.x, target.y - p.y);
          expect(d, `${label} reach t=${t} backs off`).toBeLessThanOrEqual(Math.hypot(target.x - prev.x, target.y - prev.y) + 1e-6);
          expect(fold(p.jib), `${label} reach t=${t} fold flipped`).toBe(f0);
          prev = p;
        }
        // Comes to rest on the target: the last half tick barely moves.
        const end = at(reach, DOCK_CRANE_REACH_TICKS);
        const late = at(reach, DOCK_CRANE_REACH_TICKS - 0.5);
        expect(Math.abs(end.boom - late.boom) + Math.abs(end.jib - late.jib), `${label} reach ends at speed`).toBeLessThan(1e-2);
        // Reach end == hold == retract start (no pop), same fold.
        const hold = at({ clipId: 'arm-hold', startTick: 100, target }, 0);
        const ret = at({ clipId: 'arm-retract', startTick: 200, target }, 0);
        for (const q of [hold, ret]) {
          expect(Math.abs(q.boom - end.boom) + Math.abs(q.jib - end.jib), `${label} pose pops`).toBeLessThan(1e-9);
        }
        // Retract back to READY: straight away from the target, same fold, leaving at rest.
        const retract: PlayingClip = { clipId: 'arm-retract', startTick: 0, target };
        const r1 = at(retract, 0.5);
        expect(Math.abs(r1.boom - end.boom) + Math.abs(r1.jib - end.jib), `${label} retract leaves at speed`).toBeLessThan(1e-2);
        let prevD = 0;
        for (let t = 0.5; t <= READY_T; t += 0.5) {
          const p = at(retract, t);
          const d = Math.hypot(target.x - p.x, target.y - p.y);
          expect(d, `${label} retract t=${t} swings back`).toBeGreaterThanOrEqual(prevD - 1e-6);
          expect(fold(p.jib), `${label} retract t=${t} fold flipped`).toBe(f0);
          prevD = d;
        }
      }
    });

    it('motion: no joint whips: boom and jib never outrun the stow swing or their straight-line travel, evenly eased', () => {
      // Bug (boom-ease): the straight tip line starts by the boom pivot (the
      // READY tip, jib folded), where the IK angles turn fastest per unit of
      // tip travel, so an evenly eased tip whipped the boom at the start of
      // the line (and at the end of the retract): 0.144 rad/tick at the dock
      // pad's centre, 0.090 at the Capital bay's.
      const HALF = DOCK_CRANE_REACH_TICKS / 2;
      for (const target of NAMED) {
        // The straight half's joint travel: the largest joint change per
        // fine step, summed (the same whatever the timing along the line).
        const reach: PlayingClip = { clipId: 'arm-reach', startTick: 0, target };
        let travel = 0;
        evaluateRig(rig, reach, HALF, pose, twoBoneIkSolve);
        let qb = pose.value[BOOM]!, qj = pose.value[JIB]!;
        for (let t = HALF + 0.05; t <= DOCK_CRANE_REACH_TICKS + 1e-9; t += 0.05) {
          evaluateRig(rig, reach, t, pose, twoBoneIkSolve);
          const b = pose.value[BOOM]!, j = pose.value[JIB]!;
          travel += Math.max(Math.abs(b - qb), Math.abs(j - qj));
          qb = b; qj = j;
        }
        const cap = Math.max(STOW_SPEED, (1.5 * travel / HALF) * PACE_SLACK);
        for (const clipId of ['arm-reach', 'arm-retract']) {
          const playing: PlayingClip = { clipId, startTick: 0, target };
          let pb = NaN, pj = NaN, mb = 0, mj = 0;
          for (let t = 0; t <= DOCK_CRANE_REACH_TICKS; t += 0.5) {
            evaluateRig(rig, playing, t, pose, twoBoneIkSolve);
            const b = pose.value[BOOM]!, j = pose.value[JIB]!;
            if (t > 0) {
              mb = Math.max(mb, Math.abs(b - pb) / 0.5);
              mj = Math.max(mj, Math.abs(j - pj) / 0.5);
            }
            pb = b; pj = j;
          }
          const label = `${clipId} → (${target.x}, ${target.y})`;
          expect(mb, `${label} boom (travel ${travel.toFixed(2)})`).toBeLessThan(cap);
          expect(mj, `${label} jib (travel ${travel.toFixed(2)})`).toBeLessThan(cap);
        }
      }
    });

    it.runIf(bay === FREIGHT_DOCK_BAY)('regression: aborting a reach to the far left corner (-445.1, 710) at tick 53 stays on the apron', () => {
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
}

describeCranePath(FREIGHT_DOCK_BAY, true, [{ x: -380, y: 640 }, { x: 380, y: 640 }, { x: 200, y: 460 }]);
describeCranePath(CAPITAL_BAY, false, [{ x: -200, y: 480 }, { x: 240, y: 480 }, { x: 100, y: 350 }]);
