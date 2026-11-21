/**
 * Structural lock: the missile pose ring must be deep enough to serve the
 * largest display delay the missile mirror may run, so a missile held or
 * caught up through a network gap never reads past its oldest sample.
 */

import { describe, it, expect } from 'vitest';
import { MISSILE_POSE_RING_DEPTH } from './ProjectileRenderState.js';

/** Largest missile display delay (ms): gap smoothing may stretch the delay to
 *  400 ms for a few seconds after a dropout (decision D2 of the gap-smoothing
 *  plan, section 6.4). */
const MAX_MISSILE_DISPLAY_DELAY_MS = 400;

/** Missile poses ride the JSON snapshot at 20 snapshots/s → one sample every
 *  50 ms. */
const JSON_SNAPSHOT_INTERVAL_MS = 50;

/** One extra sample to bracket the oldest interval, plus one for arrival
 *  jitter. */
const RING_HEADROOM_SAMPLES = 2;

describe('MISSILE_POSE_RING_DEPTH', () => {
  it('covers the maximum display delay at the JSON snapshot cadence plus headroom', () => {
    const intervalsToCover = Math.ceil(MAX_MISSILE_DISPLAY_DELAY_MS / JSON_SNAPSHOT_INTERVAL_MS);
    expect(MISSILE_POSE_RING_DEPTH).toBeGreaterThanOrEqual(intervalsToCover + RING_HEADROOM_SAMPLES);
  });
});
