/**
 * ClientEntityFactory routing — every pose-core kind byte maps to a leaf whose
 * poseCoreKind matches the wire constant (the construction-time
 * `assertPoseCoreKind` guard backs this), and an unknown kind is SKIPPED
 * (null), never mis-routed to the drone path (HC#2). Phase 2c adds scrap (3).
 */
import { describe, it, expect } from 'vitest';
import { ClientEntityFactory } from './ClientEntityFactory.js';
import {
  SWARM_KIND_ASTEROID,
  SWARM_KIND_DRONE,
  SWARM_KIND_STRUCTURE,
  SWARM_KIND_SCRAP,
} from '../../../shared-types/swarmWireFormat.js';

describe('ClientEntityFactory', () => {
  it('routes each pose-core kind to a leaf with the matching poseCoreKind', () => {
    const f = new ClientEntityFactory();
    expect(f.leafFor(SWARM_KIND_ASTEROID)?.poseCoreKind).toBe(SWARM_KIND_ASTEROID);
    expect(f.leafFor(SWARM_KIND_DRONE)?.poseCoreKind).toBe(SWARM_KIND_DRONE);
    expect(f.leafFor(SWARM_KIND_STRUCTURE)?.poseCoreKind).toBe(SWARM_KIND_STRUCTURE);
    expect(f.leafFor(SWARM_KIND_SCRAP)?.poseCoreKind).toBe(SWARM_KIND_SCRAP);
  });

  it('returns null (skip) for an unrecognised kind — never the drone path', () => {
    const f = new ClientEntityFactory();
    expect(f.leafFor(99)).toBeNull();
  });

  it('construction asserts registry/wire pose-core agreement', () => {
    expect(() => new ClientEntityFactory()).not.toThrow();
  });
});
