/**
 * Structure-restyle 3e: the cargo crate a dock crane carries during its hold.
 * Timing (`craneCargoAlong`) from the hold on the wire, and the point on the
 * real dock crane's arm (`craneCargoPoint`): the clamp at 0, the slewing
 * pivot (the dock) at 1, on the boom / jib in between.
 */
import { describe, expect, it } from 'vitest';
import { rigClipIndex, type Rig } from './rig.js';
import { createRigPose, evaluateRig } from './evaluate.js';
import { twoBoneIkSolve } from './ikAdapter.js';
import { DOCK_BAY_CX, DOCK_BAY_CY, DOCK_CRANE_PIVOT_X, DOCK_CRANE_PIVOT_Y, rigForStructureKind } from './rigCatalogue.js';
import {
  CRANE_CARGO_BOTH, CRANE_CARGO_IN, CRANE_CARGO_OUT, craneCargoAlong, craneCargoPoint, type ArmPoint,
} from './craneCargo.js';

describe('craneCargoAlong (hold timing)', () => {
  const H = 300;

  it('shows nothing without a hold, a direction, or outside the hold', () => {
    expect(craneCargoAlong(10, 0, CRANE_CARGO_IN)).toBe(-1);
    expect(craneCargoAlong(10, H, 0)).toBe(-1);
    expect(craneCargoAlong(-1, H, CRANE_CARGO_IN)).toBe(-1);
    expect(craneCargoAlong(H, H, CRANE_CARGO_IN)).toBe(-1);
    expect(craneCargoAlong(Number.NaN, H, CRANE_CARGO_IN)).toBe(-1);
  });

  it('unload: grips at the clamp, rides in steadily, then is gone into the dock', () => {
    expect(craneCargoAlong(0, H, CRANE_CARGO_IN)).toBe(0);
    expect(craneCargoAlong(H * 0.1, H, CRANE_CARGO_IN)).toBe(0);
    let prev = 0;
    for (let e = H * 0.13; e < H * 0.84; e += 3) {
      const u = craneCargoAlong(e, H, CRANE_CARGO_IN);
      expect(u).toBeGreaterThanOrEqual(prev);
      expect(u).toBeLessThanOrEqual(1);
      prev = u;
    }
    expect(craneCargoAlong(H * 0.5, H, CRANE_CARGO_IN)).toBeGreaterThan(0.3);
    expect(craneCargoAlong(H * 0.5, H, CRANE_CARGO_IN)).toBeLessThan(0.7);
    expect(craneCargoAlong(H * 0.95, H, CRANE_CARGO_IN)).toBe(-1);
  });

  it('load: the exact reverse, ending in the clamp at the ship', () => {
    for (let e = 0; e < H; e += 7) {
      expect(craneCargoAlong(e, H, CRANE_CARGO_OUT)).toBeCloseTo(craneCargoAlong(H - e, H, CRANE_CARGO_IN), 9);
    }
    expect(craneCargoAlong(H - 1, H, CRANE_CARGO_OUT)).toBe(0);
  });

  it('mixed dock: unload in the first half, load in the second', () => {
    expect(craneCargoAlong(0, H, CRANE_CARGO_BOTH)).toBe(0);
    expect(craneCargoAlong(H * 0.25, H, CRANE_CARGO_BOTH)).toBeCloseTo(craneCargoAlong(H * 0.5, H, CRANE_CARGO_IN), 9);
    expect(craneCargoAlong(H * 0.49, H, CRANE_CARGO_BOTH)).toBe(-1);
    expect(craneCargoAlong(H * 0.75, H, CRANE_CARGO_BOTH)).toBeCloseTo(craneCargoAlong(H * 0.5, H, CRANE_CARGO_OUT), 9);
    expect(craneCargoAlong(H - 1, H, CRANE_CARGO_BOTH)).toBe(0);
  });
});

describe('craneCargoPoint (on the dock crane arm)', () => {
  const rig: Rig = rigForStructureKind('freight_dock')!;
  const pose = createRigPose(rig);
  const hold = rigClipIndex(rig, 'arm-hold');
  const target = { x: DOCK_BAY_CX + 120, y: DOCK_BAY_CY + 30 };
  evaluateRig(rig, { clipId: 'arm-hold', startTick: 0, target }, 10, pose, twoBoneIkSolve);
  const out: ArmPoint = { x: 0, y: 0, angle: 0 };

  it('0 is the clamp at the ship, 1 is the pivot on the dock', () => {
    expect(craneCargoPoint(rig, hold, pose, 0, out)).toBe(true);
    expect(out.x).toBeCloseTo(target.x, 0);
    expect(out.y).toBeCloseTo(target.y, 0);
    expect(craneCargoPoint(rig, hold, pose, 1, out)).toBe(true);
    expect(out.x).toBeCloseTo(DOCK_CRANE_PIVOT_X, 6);
    expect(out.y).toBeCloseTo(DOCK_CRANE_PIVOT_Y, 6);
  });

  it('moves by arc length along jib then boom, never off the arm', () => {
    const elbow = { x: pose.x[rig.clips[hold]!.chain[1]!]!, y: pose.y[rig.clips[hold]!.chain[1]!]! };
    const jibLen = Math.hypot(target.x - elbow.x, target.y - elbow.y);
    const boomLen = Math.hypot(elbow.x - DOCK_CRANE_PIVOT_X, elbow.y - DOCK_CRANE_PIVOT_Y);
    // The elbow sits at along = jib / (jib + boom).
    craneCargoPoint(rig, hold, pose, jibLen / (jibLen + boomLen), out);
    expect(out.x).toBeCloseTo(elbow.x, 3);
    expect(out.y).toBeCloseTo(elbow.y, 3);
    let px = target.x, py = target.y;
    const steps = 40;
    for (let k = 1; k <= steps; k++) {
      craneCargoPoint(rig, hold, pose, k / steps, out);
      // Equal steps of `along` are equal steps of distance (± a corner).
      expect(Math.hypot(out.x - px, out.y - py)).toBeLessThanOrEqual((jibLen + boomLen) / steps + 1e-6);
      px = out.x; py = out.y;
    }
  });

  it('heads root -> tip along the segment it is on; clamps along to [0, 1]', () => {
    craneCargoPoint(rig, hold, pose, 0.05, out);
    const jib = rig.clips[hold]!.chain[1]!;
    expect(Math.cos(out.angle - pose.angle[jib]!)).toBeCloseTo(1, 6);
    const a = { ...out };
    craneCargoPoint(rig, hold, pose, -3, out);
    expect(out.x).toBeCloseTo(target.x, 0);
    craneCargoPoint(rig, hold, pose, 7, out);
    expect(out.x).toBeCloseTo(DOCK_CRANE_PIVOT_X, 6);
    expect(a.angle).not.toBeNaN();
  });

  it('a clip with no IK chain gives no point', () => {
    const turret = rigForStructureKind('turret');
    if (turret === null) return;
    const ci = turret.clips.findIndex((c) => c.chain.length === 0);
    if (ci < 0) return;
    expect(craneCargoPoint(turret, ci, createRigPose(turret), 0.5, out)).toBe(false);
    expect(craneCargoPoint(rig, -1, pose, 0.5, out)).toBe(false);
  });
});
