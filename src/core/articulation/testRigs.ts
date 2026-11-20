/**
 * Test fixtures for the articulation unit tests (structure-restyle 2a): a
 * dock-like rig with a door, a pop-up turret slide and a 2-segment arm, and
 * the plan's example clips. Test-only; the sandbox rigs (2f) are authored
 * with the real structure kinds.
 */
import type { IkSolve } from './evaluate.js';
import type { RigDef } from './rig.js';

export const DOOR_OPEN = Math.PI / 2;
export const TURRET_OUT = 6;

export const DOCK_RIG_DEF: RigDef = {
  id: 'test-dock',
  parts: [
    // Child listed before its parent on purpose: buildRig must reorder.
    { id: 'arm2', parent: 'arm1', anchorX: 8, anchorY: 0, joint: { type: 'hinge', min: -2.5, max: 2.5 }, rest: 0, layer: 'over', kind: 'physical' },
    { id: 'arm1', parent: null, anchorX: -5, anchorY: 0, joint: { type: 'hinge', min: -Math.PI, max: Math.PI }, rest: 0, layer: 'over', kind: 'physical' },
    { id: 'door', parent: null, anchorX: 10, anchorY: 0, joint: { type: 'hinge', min: 0, max: DOOR_OPEN }, rest: 0, layer: 'plane', kind: 'physical', outline: [0, -1, 6, -1, 6, 1, 0, 1] },
    { id: 'turret', parent: null, anchorX: 0, anchorY: 5, baseAngle: Math.PI / 2, joint: { type: 'slide', min: 0, max: TURRET_OUT }, rest: 0, layer: 'under', kind: 'physical' },
    { id: 'lamp', parent: 'door', anchorX: 6, anchorY: 0, joint: { type: 'hinge', min: 0, max: 0 }, rest: 0, layer: 'over', kind: 'cosmetic' },
  ],
  clips: [
    { id: 'door-open', tracks: [{ part: 'door', keys: [{ tick: 0, value: 0 }, { tick: 30, value: DOOR_OPEN, ease: 'out' }] }] },
    { id: 'door-close', tracks: [{ part: 'door', keys: [{ tick: 0, value: DOOR_OPEN }, { tick: 30, value: 0 }] }] },
    { id: 'turret-deploy', tracks: [{ part: 'turret', keys: [{ tick: 10, value: TURRET_OUT, ease: 'linear' }] }] },
    { id: 'turret-retract', tracks: [{ part: 'turret', keys: [{ tick: 0, value: TURRET_OUT }, { tick: 20, value: 0, ease: 'linear' }] }] },
    // Deliberately overshoots the door limit: evaluation must clamp.
    { id: 'door-slam', tracks: [{ part: 'door', keys: [{ tick: 5, value: 3, ease: 'linear' }] }] },
    {
      id: 'arm-reach',
      ik: { chain: ['arm1', 'arm2'], tipX: 6, tipY: 0 },
      tracks: [
        { part: 'arm1', keys: [{ tick: 40, fromTarget: true }] },
        { part: 'arm2', keys: [{ tick: 40, fromTarget: true }] },
      ],
    },
    {
      id: 'arm-retract',
      ik: { chain: ['arm1', 'arm2'], tipX: 6, tipY: 0 },
      tracks: [
        { part: 'arm1', keys: [{ tick: 0, fromTarget: true }, { tick: 40, value: 0 }] },
        { part: 'arm2', keys: [{ tick: 0, fromTarget: true }, { tick: 40, value: 0 }] },
      ],
    },
  ],
};

/** A stand-in IK hook (the real 2-bone solver is `ik.ts`, slice 2b): points
 *  the root at the target and bends the second joint by a fixed fraction.
 *  Pure and allocation-free, as the contract requires. */
export const stubIk: IkSolve = (req, out) => {
  const r = req.chain[0]!;
  const c = Math.cos(req.originAngle), s = Math.sin(req.originAngle);
  const ax = req.rig.anchorX[r]!, ay = req.rig.anchorY[r]!;
  const dx = req.targetX - (req.originX + ax * c - ay * s);
  const dy = req.targetY - (req.originY + ax * s + ay * c);
  out[0] = Math.atan2(dy, dx) - req.originAngle - req.rig.baseAngle[r]!;
  out[1] = 0.25;
  return dx * dx + dy * dy <= 400;
};
