import { describe, it, expect } from 'vitest';
import { shouldBroadcastContact } from './contactFilter.js';
import type { Contact } from '../../core/physics/contactDrain.js';

/**
 * Regression lock for the Phase 6b self-collision bug
 * (diagnostic 2026-05-13T18-16-28-857Z-k5lr41).
 *
 * The user reported their active hull bouncing around their own
 * lingering hull. Root cause: the physics worker spawns both bodies
 * with the same `playerId` as identity, so Rapier's contact event
 * arrives at the wire with `aId === bId`. The client interprets
 * this as "ship X collided with ship X" and applies two conflicting
 * velocities to the same body, snapping it.
 *
 * The filter drops same-id contacts at the broadcast site.
 */
function makeContact(aId: string, bId: string): Contact {
  return {
    aId, bId,
    vAxPost: 1, vAyPost: 2,
    vBxPost: -1, vByPost: -2,
    forceMagnitude: 1000,
  };
}

describe('shouldBroadcastContact', () => {
  it('rejects self-collisions (aId === bId)', () => {
    const sameId = 'e7b12a8d-c27b-4a34-8562-7f2a8fe82841';
    expect(shouldBroadcastContact(makeContact(sameId, sameId))).toBe(false);
  });

  it('accepts inter-ship contacts', () => {
    expect(shouldBroadcastContact(makeContact(
      'e7b12a8d-c27b-4a34-8562-7f2a8fe82841',
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ))).toBe(true);
  });

  it('accepts ship-vs-drone contacts (different namespaces)', () => {
    expect(shouldBroadcastContact(makeContact(
      'e7b12a8d-c27b-4a34-8562-7f2a8fe82841',
      'swarm-42',
    ))).toBe(true);
  });

  it('accepts drone-vs-drone contacts', () => {
    expect(shouldBroadcastContact(makeContact('swarm-1', 'swarm-2'))).toBe(true);
  });

  it('rejects self-collision even when ids are short', () => {
    // The filter is by string equality, not by a specific id format.
    expect(shouldBroadcastContact(makeContact('a', 'a'))).toBe(false);
    expect(shouldBroadcastContact(makeContact('a', 'b'))).toBe(true);
  });
});
