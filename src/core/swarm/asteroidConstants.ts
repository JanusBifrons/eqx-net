/**
 * Tuning knobs for procedurally-shaped asteroids.
 *
 * `ASTEROID_DEFAULT_MASS` is high enough that a 500:1 asteroid:ship ratio
 * means a head-on cruise-speed collision deflects the asteroid by less than
 * the wire-suppression threshold — the rock won't even ship a packet update.
 * Boost-ramming still leaves a comfortable margin.
 */

export const ASTEROID_DEFAULT_MASS = 500;

export const ASTEROID_VERTEX_COUNT_MIN = 6;
export const ASTEROID_VERTEX_COUNT_MAX = 9;

/** Per-vertex radial range as a fraction of the target radius. */
export const ASTEROID_VERTEX_RADIAL_MIN = 0.70;
export const ASTEROID_VERTEX_RADIAL_MAX = 1.00;

/** Per-vertex angular jitter as a fraction of the angular step. */
export const ASTEROID_VERTEX_ANGULAR_JITTER = 0.35;
