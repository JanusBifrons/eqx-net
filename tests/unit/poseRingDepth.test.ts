/**
 * Structural invariant (netcode gap-smoothing plan 3.1, job S3a-1): the drone
 * pose ring must hold the whole adaptive display-delay range on the
 * server-tick timeline, plus headroom. If the ring is shorter than the delay
 * ceiling, every drone pins to its oldest sample and only moves when a packet
 * arrives. Lives in tests/unit because core may not import the client-zone
 * ceiling constant. S4-3 extends it to the 400 ms maximum total delay after a
 * dropout (ring 21 -> 28); S4-4 moved that 400 ms into the client constant
 * `MAX_TOTAL_DISPLAY_DELAY_MS`.
 */
import { describe, it, expect } from 'vitest';
import { POSE_RING_DEPTH } from '../../src/core/contracts/IRenderer.js';
import { ADAPTIVE_DELAY_CEILING_MS, MAX_TOTAL_DISPLAY_DELAY_MS } from '../../src/client/net/swarmInterpolation.js';

/** Server simulation rate: drones are tick-stamped at 60 Hz. */
const SERVER_TICK_HZ = 60;
const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;
/** Headroom slots: arrival jitter + a late packet not evicting the one still needed. */
const RING_HEADROOM_SLOTS = 4;
/** Arbitrary newest-sample stamp for the synthetic ring. */
const NEWEST_STAMP_MS = 100_000;

describe('POSE_RING_DEPTH', () => {
  it('covers ADAPTIVE_DELAY_CEILING_MS of tick-stamped history plus headroom', () => {
    const need = Math.ceil(ADAPTIVE_DELAY_CEILING_MS / SERVER_TICK_MS) + RING_HEADROOM_SLOTS;
    expect(
      POSE_RING_DEPTH,
      `POSE_RING_DEPTH=${POSE_RING_DEPTH} spans ${((POSE_RING_DEPTH - 1) * SERVER_TICK_MS).toFixed(0)} ms; ` +
        `ADAPTIVE_DELAY_CEILING_MS=${ADAPTIVE_DELAY_CEILING_MS} needs >= ${need}.`,
    ).toBeGreaterThanOrEqual(need);
  });

  it('covers the 400 ms maximum total delay plus headroom', () => {
    const need = Math.ceil(MAX_TOTAL_DISPLAY_DELAY_MS / SERVER_TICK_MS) + RING_HEADROOM_SLOTS;
    expect(
      POSE_RING_DEPTH,
      `POSE_RING_DEPTH=${POSE_RING_DEPTH} spans ${((POSE_RING_DEPTH - 1) * SERVER_TICK_MS).toFixed(0)} ms; ` +
        `MAX_TOTAL_DISPLAY_DELAY_MS=${MAX_TOTAL_DISPLAY_DELAY_MS} needs >= ${need}.`,
    ).toBeGreaterThanOrEqual(need);
  });

  it('a full ring at the tick rate holds a read 400 ms + one tick behind the newest sample without pinning to oldest', () => {
    // One tick-stamped sample per server tick, newest last: the shape the
    // decoder leaves after POSE_RING_DEPTH in-order packets.
    const oldestMs = NEWEST_STAMP_MS - (POSE_RING_DEPTH - 1) * SERVER_TICK_MS;
    // The frame's `now` can run up to one tick past the newest sample, so the
    // worst read point is the max delay plus one tick behind the newest.
    const readMs = NEWEST_STAMP_MS - (MAX_TOTAL_DISPLAY_DELAY_MS + SERVER_TICK_MS);
    // `interpolateSwarmPose` pins to oldest when targetMs <= oldest.arrivalMs;
    // strictly after it, the read is bracketed by two resident samples.
    expect(
      readMs,
      `read point ${(NEWEST_STAMP_MS - readMs).toFixed(1)} ms behind newest is at or before the ` +
        `oldest resident sample ${(NEWEST_STAMP_MS - oldestMs).toFixed(1)} ms behind.`,
    ).toBeGreaterThan(oldestMs);
  });
});
