import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { buildRig, rigPartIndex, type RigDef } from './rig.js';
import { createRigPose, evaluateRig, type PlayingClip, type RigPose } from './evaluate.js';
import { twoBoneIkSolve } from './ikAdapter.js';
import { DOCK_RIG_DEF } from './testRigs.js';

/** Host-frame tip of a clip's chain: FK of the tip offset in the tip part's frame. */
function tipOf(pose: RigPose, part: number, tipX: number, tipY: number): { x: number; y: number } {
  const c = pose.cos[part]!, s = pose.sin[part]!;
  return { x: pose.x[part]! + tipX * c - tipY * s, y: pose.y[part]! + tipX * s + tipY * c };
}

const play = (clipId: string, startTick: number, target: { x: number; y: number }): PlayingClip =>
  ({ clipId, startTick, target });

describe('twoBoneIkSolve through evaluateRig (structure-restyle 2b+)', () => {
  const rig = buildRig(DOCK_RIG_DEF);
  const arm2 = rigPartIndex(rig, 'arm2');
  const pose = createRigPose(rig);

  it('arm-reach ends with the tip on a reachable target; not reached when too far', () => {
    // arm1 pivot (-5, 0), bones 8 + 6.
    evaluateRig(rig, play('arm-reach', 100, { x: 3, y: 7 }), 140, pose, twoBoneIkSolve);
    expect(pose.ikReached).toBe(true);
    const t = tipOf(pose, arm2, 6, 0);
    expect(Math.hypot(t.x - 3, t.y - 7)).toBeLessThan(1e-6);

    evaluateRig(rig, play('arm-reach', 100, { x: 30, y: 0 }), 140, pose, twoBoneIkSolve);
    expect(pose.ikReached).toBe(false);
    const far = tipOf(pose, arm2, 6, 0);
    expect(far.x).toBeCloseTo(-5 + 14, 9); // fully extended toward the target
    expect(far.y).toBeCloseTo(0, 9);
  });

  it('mid-clip the chain is between rest and the solution (eased, not snapped)', () => {
    evaluateRig(rig, play('arm-reach', 100, { x: 3, y: 7 }), 120, pose, twoBoneIkSolve);
    const t = tipOf(pose, arm2, 6, 0);
    expect(Math.hypot(t.x - 3, t.y - 7)).toBeGreaterThan(1e-3);
  });

  it('property: every reachable target is hit within 1e-6', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 5, max: 13.9, noNaN: true }), // min reach with arm2 at its 2.5 limit is ~4.8,
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (r, a) => {
          const target = { x: -5 + r * Math.cos(a), y: r * Math.sin(a) };
          evaluateRig(rig, play('arm-reach', 0, target), 40, pose, twoBoneIkSolve);
          const t = tipOf(pose, arm2, 6, 0);
          return pose.ikReached && Math.hypot(t.x - target.x, t.y - target.y) < 1e-6;
        },
      ),
      { numRuns: 300 },
    );
  });

  it('is deterministic: same inputs give the same bits', () => {
    const a = createRigPose(rig), b = createRigPose(rig);
    for (const tick of [0, 13.5, 27, 40, 90]) {
      evaluateRig(rig, play('arm-reach', 0, { x: 1.25, y: -6.5 }), tick, a, twoBoneIkSolve);
      evaluateRig(rig, play('door-open', 0, { x: 0, y: 0 }), tick, b, twoBoneIkSolve);
      evaluateRig(rig, play('arm-reach', 0, { x: 1.25, y: -6.5 }), tick, b, twoBoneIkSolve);
      expect([...b.value, ...b.x, ...b.y, ...b.angle]).toEqual([...a.value, ...a.x, ...a.y, ...a.angle]);
    }
  });

  it('maps offset bones (anchor off-axis, child base angle, tip off-axis, rotated parent)', () => {
    const def: RigDef = {
      id: 'offset-arm',
      parts: [
        { id: 'base', parent: null, anchorX: 3, anchorY: -2, baseAngle: 0.7, joint: { type: 'hinge', min: 0, max: 0 }, rest: 0, layer: 'over', kind: 'cosmetic' },
        { id: 'a', parent: 'base', anchorX: 1, anchorY: 2, baseAngle: -0.4, joint: { type: 'hinge', min: -Math.PI, max: Math.PI }, rest: 0, layer: 'over', kind: 'cosmetic' },
        { id: 'b', parent: 'a', anchorX: 9, anchorY: 3, baseAngle: 0.5, joint: { type: 'hinge', min: -2.5, max: 2.5 }, rest: 0, layer: 'over', kind: 'cosmetic' },
      ],
      clips: [
        { id: 'reach', ik: { chain: ['a', 'b'], tipX: 5, tipY: -2, bend: -1 }, tracks: [
          { part: 'a', keys: [{ tick: 10, fromTarget: true }] },
          { part: 'b', keys: [{ tick: 10, fromTarget: true }] },
        ] },
      ],
    };
    const r2 = buildRig(def);
    const p2 = createRigPose(r2);
    const b = rigPartIndex(r2, 'b');
    const target = { x: 10, y: 6 };
    evaluateRig(r2, play('reach', 0, target), 10, p2, twoBoneIkSolve);
    expect(p2.ikReached).toBe(true);
    const t = tipOf(p2, b, 5, -2);
    expect(Math.hypot(t.x - target.x, t.y - target.y)).toBeLessThan(1e-6);
  });

  it('a chain that is not two hinges returns rest and not-reached', () => {
    const def: RigDef = {
      id: 'slide-arm',
      parts: [
        { id: 'a', parent: null, anchorX: 0, anchorY: 0, joint: { type: 'slide', min: 0, max: 5 }, rest: 1, layer: 'over', kind: 'cosmetic' },
        { id: 'b', parent: 'a', anchorX: 4, anchorY: 0, joint: { type: 'hinge', min: -1, max: 1 }, rest: 0.5, layer: 'over', kind: 'cosmetic' },
      ],
      clips: [{ id: 'reach', ik: { chain: ['a', 'b'], tipX: 2, tipY: 0 }, tracks: [
        { part: 'a', keys: [{ tick: 0, fromTarget: true }] },
        { part: 'b', keys: [{ tick: 0, fromTarget: true }] },
      ] }],
    };
    const r3 = buildRig(def);
    const p3 = createRigPose(r3);
    evaluateRig(r3, play('reach', 0, { x: 3, y: 1 }), 5, p3, twoBoneIkSolve);
    expect(p3.ikReached).toBe(false);
    expect([...p3.value]).toEqual([1, 0.5]);
  });
});

describe('swing side and whole-turn joints (structure-restyle 2g)', () => {
  // Root at the origin facing +x; bones 10 + 10. Elbow free over a full turn
  // [0, 2π], resting folded CCW at 3.0.
  const def: RigDef = {
    id: 'swing-arm',
    parts: [
      { id: 'a', parent: null, anchorX: 0, anchorY: 0, joint: { type: 'hinge', min: -Math.PI, max: Math.PI }, rest: 0, layer: 'over', kind: 'cosmetic' },
      { id: 'b', parent: 'a', anchorX: 10, anchorY: 0, joint: { type: 'hinge', min: 0, max: 2 * Math.PI }, rest: 3, layer: 'over', kind: 'cosmetic' },
    ],
    clips: [
      { id: 'side', ik: { chain: ['a', 'b'], tipX: 10, tipY: 0, swingSide: { x: 0, y: 1 } }, tracks: [
        { part: 'a', keys: [{ tick: 10, fromTarget: true }] },
        { part: 'b', keys: [{ tick: 10, fromTarget: true }] },
      ] },
      { id: 'fixed', ik: { chain: ['a', 'b'], tipX: 10, tipY: 0, bend: 1 }, tracks: [
        { part: 'a', keys: [{ tick: 10, fromTarget: true }] },
        { part: 'b', keys: [{ tick: 10, fromTarget: true }] },
      ] },
    ],
  };
  const r = buildRig(def);
  const p = createRigPose(r);
  const b = rigPartIndex(r, 'b');

  it('the elbow takes the fold on the swing side, whichever side the target is', () => {
    for (const target of [{ x: 12, y: 0.5 }, { x: -12, y: 0.5 }, { x: 5, y: 3 }, { x: -5, y: 3 }]) {
      evaluateRig(r, play('side', 0, target), 10, p, twoBoneIkSolve);
      expect(p.ikReached).toBe(true);
      expect(p.y[b]!, `elbow above for (${target.x}, ${target.y})`).toBeGreaterThan(target.y / 2);
      const t = tipOf(p, b, 10, 0);
      expect(Math.hypot(t.x - target.x, t.y - target.y)).toBeLessThan(1e-6);
    }
    // A fixed CCW fold puts the elbow below the line for a target on the right.
    evaluateRig(r, play('fixed', 0, { x: 12, y: 0.5 }), 10, p, twoBoneIkSolve);
    expect(p.y[b]!).toBeLessThan(0);
  });

  it('a clockwise solution on a [0, 2π] joint blends the short way, over the fold, not out straight', () => {
    const target = { x: 12, y: 0.5 }; // CW fold on the swing side: IK elbow < 0
    evaluateRig(r, play('side', 0, target), 10, p, twoBoneIkSolve);
    const end = p.value[b]!;
    expect(end).toBeGreaterThan(Math.PI); // the 2π copy of a negative elbow
    expect(end).toBeLessThanOrEqual(2 * Math.PI);
    for (let t = 0; t <= 10; t += 0.5) {
      evaluateRig(r, play('side', 0, target), t, p, twoBoneIkSolve);
      expect(p.value[b]!).toBeGreaterThanOrEqual(3 - 1e-12); // never unfolds through 0 (straight)
    }
  });
});
