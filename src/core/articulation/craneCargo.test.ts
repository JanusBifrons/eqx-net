/**
 * Structure-restyle 3e: the goods a dock crane moves during its hold.
 * Which way they flow (`craneCargoFlow`) from the hold on the wire, and the
 * path the flow pulse runs along on the real dock crane's arm
 * (`craneArmPath`): the clamp first, the slewing pivot (the dock) last.
 */
import { describe, expect, it } from 'vitest';
import { rigClipIndex, type Rig } from './rig.js';
import { createRigPose, evaluateRig } from './evaluate.js';
import { twoBoneIkSolve } from './ikAdapter.js';
import { DOCK_BAY_CX, DOCK_BAY_CY, DOCK_CRANE_PIVOT_X, DOCK_CRANE_PIVOT_Y, rigForStructureKind } from './rigCatalogue.js';
import { CRANE_CARGO_BOTH, CRANE_CARGO_IN, CRANE_CARGO_OUT, craneArmPath, craneCargoFlow, craneCargoReadout } from './craneCargo.js';

describe('craneCargoReadout (own-ship HUD)', () => {
  const H = 300;
  const S = 1000;

  it('before the hold it names the first move at 0 (unload first)', () => {
    expect(craneCargoReadout(0, 0, CRANE_CARGO_IN, S)).toBe(CRANE_CARGO_IN * S);
    expect(craneCargoReadout(0, H, CRANE_CARGO_OUT, S)).toBe(CRANE_CARGO_OUT * S);
    expect(craneCargoReadout(0, H, CRANE_CARGO_BOTH, S)).toBe(CRANE_CARGO_IN * S);
    expect(craneCargoReadout(0, H, 0, S)).toBe(0);
  });

  it('runs 0..99 through one move, capped below 100 (the trade lands at hold end)', () => {
    expect(craneCargoReadout(H / 2, H, CRANE_CARGO_IN, S)).toBe(CRANE_CARGO_IN * S + 50);
    expect(craneCargoReadout(H, H, CRANE_CARGO_IN, S)).toBe(CRANE_CARGO_IN * S + 99);
  });

  it('a mixed dock counts its unload half and load half separately', () => {
    expect(craneCargoReadout(H / 4, H, CRANE_CARGO_BOTH, S)).toBe(CRANE_CARGO_IN * S + 50);
    expect(craneCargoReadout(H / 2, H, CRANE_CARGO_BOTH, S)).toBe(CRANE_CARGO_OUT * S + 0);
    expect(craneCargoReadout((3 * H) / 4, H, CRANE_CARGO_BOTH, S)).toBe(CRANE_CARGO_OUT * S + 50);
  });
});

describe('craneCargoFlow (hold timing)', () => {
  const H = 300;

  it('no flow without a hold, a direction, or outside the hold', () => {
    expect(craneCargoFlow(10, 0, CRANE_CARGO_IN)).toBe(0);
    expect(craneCargoFlow(10, H, 0)).toBe(0);
    expect(craneCargoFlow(-1, H, CRANE_CARGO_IN)).toBe(0);
    expect(craneCargoFlow(H, H, CRANE_CARGO_IN)).toBe(0);
    expect(craneCargoFlow(Number.NaN, H, CRANE_CARGO_IN)).toBe(0);
  });

  it('an unload flows ship -> dock, a load dock -> ship, for the whole hold', () => {
    for (const e of [0, 1, H / 2, H - 1]) {
      expect(craneCargoFlow(e, H, CRANE_CARGO_IN)).toBe(CRANE_CARGO_IN);
      expect(craneCargoFlow(e, H, CRANE_CARGO_OUT)).toBe(CRANE_CARGO_OUT);
    }
  });

  it('a mixed dock unloads for the first half, then loads', () => {
    expect(craneCargoFlow(0, H, CRANE_CARGO_BOTH)).toBe(CRANE_CARGO_IN);
    expect(craneCargoFlow(H / 2 - 1, H, CRANE_CARGO_BOTH)).toBe(CRANE_CARGO_IN);
    expect(craneCargoFlow(H / 2, H, CRANE_CARGO_BOTH)).toBe(CRANE_CARGO_OUT);
    expect(craneCargoFlow(H - 1, H, CRANE_CARGO_BOTH)).toBe(CRANE_CARGO_OUT);
  });
});

describe('craneArmPath (the dock crane arm)', () => {
  const rig: Rig = rigForStructureKind('freight_dock')!;
  const pose = createRigPose(rig);
  const hold = rigClipIndex(rig, 'arm-hold');
  const target = { x: DOCK_BAY_CX + 120, y: DOCK_BAY_CY + 30 };
  evaluateRig(rig, { clipId: 'arm-hold', startTick: 0, target }, 10, pose, twoBoneIkSolve);

  it('runs clamp (at the ship) -> elbow -> pivot (on the dock)', () => {
    const out = new Float64Array(2 * (rig.maxChain + 1));
    const n = craneArmPath(rig, hold, pose, out);
    expect(n).toBe(3);
    expect(out[0]).toBeCloseTo(target.x, 0);
    expect(out[1]).toBeCloseTo(target.y, 0);
    const elbow = rig.clips[hold]!.chain[1]!;
    expect(out[2]).toBeCloseTo(pose.x[elbow]!, 9);
    expect(out[3]).toBeCloseTo(pose.y[elbow]!, 9);
    expect(out[4]).toBeCloseTo(DOCK_CRANE_PIVOT_X, 6);
    expect(out[5]).toBeCloseTo(DOCK_CRANE_PIVOT_Y, 6);
  });

  it('no path for a clip without an IK chain, a bad clip, or a short buffer', () => {
    expect(craneArmPath(rig, -1, pose, new Float64Array(8))).toBe(0);
    expect(craneArmPath(rig, hold, pose, new Float64Array(4))).toBe(0);
    const turret = rigForStructureKind('turret');
    if (turret === null) return;
    const ci = turret.clips.findIndex((c) => c.chain.length === 0);
    if (ci >= 0) expect(craneArmPath(turret, ci, createRigPose(turret), new Float64Array(8))).toBe(0);
  });
});
