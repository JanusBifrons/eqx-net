/**
 * Corridor + clearance numbers derived from the LIVE ship catalogue, so a
 * bigger flyable ship automatically widens generated corridors (and the
 * budget lock in tests/unit/baseBudgets.test.ts forces a review).
 */
import { GAMEPLAY_SHIP_KINDS_LIST } from '../../shared-types/shipKinds.js';
import { CORRIDOR_RADIUS_MULTIPLE, MIN_CORRIDOR_WIDTH } from '../../shared-types/baseBudgets.js';

let maxRadius = 0;
for (const k of GAMEPLAY_SHIP_KINDS_LIST) maxRadius = Math.max(maxRadius, k.radius);

/** Largest player-flyable ship radius (engineering-only kinds excluded). */
export const MAX_FLYABLE_RADIUS = maxRadius;

/** Minimum corridor width every generator must leave for fly-through (u). */
export const CORRIDOR_WIDTH = Math.max(MIN_CORRIDOR_WIDTH, Math.ceil(CORRIDOR_RADIUS_MULTIPLE * maxRadius));
