/**
 * How far a landing search (warp drop, trip arrival, fleet warp) must look,
 * from the landing ship's own spawn clearance.
 *
 * Two hulls need their clearances apart, so a battleship landing beside a
 * parked battleship needs ~11.5 km. A fixed 6 km ring search gave up and fell
 * back to the overlapping point. The search now reaches own + the largest
 * clearance of any kind (at least the old 6 km), and obstacles are gathered
 * that far again beyond it (at least the old 8 km).
 */
import { SHIP_KINDS_LIST } from '../shipKinds.js';
import { shipTuning } from './tuning.js';

const MIN_MAX_DISTANCE = 6000;
const MIN_NEAR = 8000;
/** One search ring past the touching distance, so the ring lands clear. */
const RING_SLACK = 150;

let maxClearance = -1;
/** The largest spawn clearance of any ship kind at this process's scale. */
function largestClearance(): number {
  if (maxClearance < 0) {
    maxClearance = 0;
    for (const k of SHIP_KINDS_LIST) maxClearance = Math.max(maxClearance, shipTuning(k).spawnClearance);
  }
  return maxClearance;
}

/** `maxDistance`: how far the ring search may move the ship.
 *  `near`: obstacles farther than this from the target are ignored. */
export function landingReach(ownClearance: number): { near: number; maxDistance: number } {
  const big = largestClearance();
  const maxDistance = Math.max(MIN_MAX_DISTANCE, ownClearance + big + RING_SLACK);
  return { maxDistance, near: Math.max(MIN_NEAR, maxDistance + ownClearance + big) };
}
