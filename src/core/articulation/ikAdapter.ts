/**
 * The real IK hook for rigs (structure-restyle 2b+): adapts an `IkRequest`
 * (a 2-part hinge chain from `evaluateRig`) onto the closed-form
 * `solveTwoBoneReach` in `ik.ts`.
 *
 * Angle convention: the rig's forward kinematics (`evaluate.ts`) and `ik.ts`
 * both use angle `a` -> `(cos a, sin a)` and rotate a local point (x, y) by
 * `(x c - y s, x s + y c)`, so no flip is needed; only the bone offsets are
 * mapped (below).
 *
 * Mapping (chain [root, child], tip (tx, ty) in the child's frame):
 *  - root frame angle   = originAngle + baseAngle[root] + vRoot
 *  - bone 1 = the child's anchor (ax, ay) in the root frame:
 *      len1 = |(ax, ay)|, o1 = atan2(ay, ax)
 *  - bone 2 = the tip in the child's frame: len2 = |(tx, ty)|, o2 = atan2(ty, tx)
 *  - child frame angle  = root frame angle + baseAngle[child] + vChild
 *  So with the solver's base angle `originAngle + baseAngle[root] + o1`:
 *      shoulder = vRoot
 *      elbow    = vChild + k,  k = baseAngle[child] + o2 - o1
 *  and the limits map the same way (elbow limits shifted by k, kept inside
 *  [-π, π] as the solver requires). For the usual straight bones
 *  (anchor and tip on the local +x axis, no child base angle) k = 0.
 *  A joint whose limits span a full turn or more is free for the solver
 *  ([-π, π]); `evaluateRig` then picks the turn within its limits.
 *
 * Swing side (structure-restyle 2g): with `req.sideX/sideY` set, both folds
 * are solved and the one whose elbow lies further along that direction wins
 * (`req.bend` on a tie). So a crane elbow always rides out over its pad: a
 * fixed fold would put the boom back across the dock for targets on one side.
 *
 * Pure and allocation-free: module-level scratch, one call writes `out[0..1]`.
 */
import type { IkSolve } from './evaluate.js';
import { createIkReachOut, solveTwoBoneReach, type IkLimits } from './ik.js';
import { JOINT_HINGE } from './rig.js';

const scratchOut = createIkReachOut();
const scratchAlt = createIkReachOut();
const TWO_PI = 2 * Math.PI;
const scratchLimits: IkLimits = { shoulderMin: 0, shoulderMax: 0, elbowMin: 0, elbowMax: 0 };

function clampPi(a: number): number {
  return a < -Math.PI ? -Math.PI : a > Math.PI ? Math.PI : a;
}

/** Solver limits for one joint: free when its range spans a full turn. */
function setLimits(lo: number, hi: number, k: number, shoulder: boolean): void {
  const full = hi - lo >= TWO_PI;
  const a = full ? -Math.PI : clampPi(lo + k);
  const b = full ? Math.PI : clampPi(hi + k);
  if (shoulder) { scratchLimits.shoulderMin = a; scratchLimits.shoulderMax = b; } else { scratchLimits.elbowMin = a; scratchLimits.elbowMax = b; }
}

/**
 * `IkSolve` for a 2-part hinge chain. Returns `reached` from the solver.
 * Any other chain shape (not 2 parts, or a slide in it) writes the parts'
 * rest values and returns false.
 */
export const twoBoneIkSolve: IkSolve = (req, out) => {
  const rig = req.rig;
  const chain = req.chain;
  if (chain.length !== 2) {
    for (let k = 0; k < chain.length; k++) out[k] = rig.rest[chain[k]!]!;
    return false;
  }
  const r = chain[0]!;
  const ch = chain[1]!;
  if (rig.jointType[r] !== JOINT_HINGE || rig.jointType[ch] !== JOINT_HINGE) {
    out[0] = rig.rest[r]!;
    out[1] = rig.rest[ch]!;
    return false;
  }

  // Chain root pivot in the host frame.
  const oc = Math.cos(req.originAngle), os = Math.sin(req.originAngle);
  const rax = rig.anchorX[r]!, ray = rig.anchorY[r]!;
  const baseX = req.originX + rax * oc - ray * os;
  const baseY = req.originY + rax * os + ray * oc;

  const ax = rig.anchorX[ch]!, ay = rig.anchorY[ch]!;
  const len1 = Math.sqrt(ax * ax + ay * ay);
  const o1 = len1 > 0 ? Math.atan2(ay, ax) : 0;
  const tx = req.tipX, ty = req.tipY;
  const len2 = Math.sqrt(tx * tx + ty * ty);
  const o2 = len2 > 0 ? Math.atan2(ty, tx) : 0;
  const k = rig.baseAngle[ch]! + o2 - o1;

  setLimits(rig.min[r]!, rig.max[r]!, 0, true);
  setLimits(rig.min[ch]!, rig.max[ch]!, k, false);

  const baseAngle = req.originAngle + rig.baseAngle[r]! + o1;
  solveTwoBoneReach(baseX, baseY, baseAngle, len1, len2, req.targetX, req.targetY, scratchLimits, req.bend, scratchOut);
  let best = scratchOut;
  if (req.sideX !== 0 || req.sideY !== 0) {
    solveTwoBoneReach(baseX, baseY, baseAngle, len1, len2, req.targetX, req.targetY, scratchLimits, req.bend < 0 ? 1 : -1, scratchAlt);
    const along = (scratchOut.elbowX - baseX) * req.sideX + (scratchOut.elbowY - baseY) * req.sideY;
    const alongAlt = (scratchAlt.elbowX - baseX) * req.sideX + (scratchAlt.elbowY - baseY) * req.sideY;
    if (alongAlt > along) best = scratchAlt;
  }
  out[0] = best.shoulder;
  out[1] = best.elbow - k;
  return best.reached;
};
