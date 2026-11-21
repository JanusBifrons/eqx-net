/**
 * Structural invariant (netcode gap-smoothing plan 3.1, job S3a-1): the drone
 * pose ring must hold the whole adaptive display-delay range on the
 * server-tick timeline, plus headroom. If the ring is shorter than the delay
 * ceiling, every drone pins to its oldest sample and only moves when a packet
 * arrives. Lives in tests/unit because core may not import the client-zone
 * ceiling constant.
 */
import { describe, it, expect } from 'vitest';
import { POSE_RING_DEPTH } from '../../src/core/contracts/IRenderer.js';
import { ADAPTIVE_DELAY_CEILING_MS } from '../../src/client/net/swarmInterpolation.js';

/** Server simulation rate: drones are tick-stamped at 60 Hz. */
const SERVER_TICK_HZ = 60;
const SERVER_TICK_MS = 1000 / SERVER_TICK_HZ;
/** Headroom slots: arrival jitter + a late packet not evicting the one still needed. */
const RING_HEADROOM_SLOTS = 4;

describe('POSE_RING_DEPTH', () => {
  it('covers ADAPTIVE_DELAY_CEILING_MS of tick-stamped history plus headroom', () => {
    const need = Math.ceil(ADAPTIVE_DELAY_CEILING_MS / SERVER_TICK_MS) + RING_HEADROOM_SLOTS;
    expect(
      POSE_RING_DEPTH,
      `POSE_RING_DEPTH=${POSE_RING_DEPTH} spans ${((POSE_RING_DEPTH - 1) * SERVER_TICK_MS).toFixed(0)} ms; ` +
        `ADAPTIVE_DELAY_CEILING_MS=${ADAPTIVE_DELAY_CEILING_MS} needs >= ${need}.`,
    ).toBeGreaterThanOrEqual(need);
  });
});
