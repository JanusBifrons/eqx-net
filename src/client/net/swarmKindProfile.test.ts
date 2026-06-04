/**
 * Phase 3 lock (Generic Entity Pipeline): the client swarm-kind profile routes
 * kinds 0/1 to exactly today's predWorld behaviour, and returns null (skip —
 * NOT the drone path) for any unrecognised kind. This is the HC#2 fix: a future
 * pose-core kind (e.g. structure = 2) must not be mis-routed as a drone.
 */

import { describe, it, expect } from 'vitest';
import { SWARM_KIND_ASTEROID, SWARM_KIND_DRONE, SWARM_KIND_STRUCTURE } from '../../shared-types/swarmWireFormat.js';
import { swarmKindClientProfile } from './swarmKindProfile.js';

describe('swarmKindClientProfile', () => {
  it('asteroid (kind 0) is a static, no-AI, no-shield body (today\'s behaviour)', () => {
    const p = swarmKindClientProfile(SWARM_KIND_ASTEROID);
    expect(p).not.toBeNull();
    expect(p!.staticBody).toBe(true); // locked + posed from packet
    expect(p!.hasAiBehaviour).toBe(false);
    expect(p!.hasShield).toBe(false);
  });

  it('drone (kind 1) is a dynamic AI body with a shield (today\'s behaviour)', () => {
    const p = swarmKindClientProfile(SWARM_KIND_DRONE);
    expect(p).not.toBeNull();
    expect(p!.staticBody).toBe(false); // kinematic follower, not locked/posed here
    expect(p!.hasAiBehaviour).toBe(true); // registered HostileDroneBehaviour
    expect(p!.hasShield).toBe(true); // setHullExposed swap
  });

  it('structure (kind 2, P4) is a static, no-AI, no-shield body — but damageable server-side', () => {
    const p = swarmKindClientProfile(SWARM_KIND_STRUCTURE);
    expect(p).not.toBeNull();
    expect(p!.staticBody).toBe(true); // locked + posed from packet, like an asteroid
    expect(p!.hasAiBehaviour).toBe(false);
    expect(p!.hasShield).toBe(false);
  });

  it('an unrecognised kind returns null — the caller SKIPS it (never the drone path, HC#2)', () => {
    expect(swarmKindClientProfile(7)).toBeNull();
    expect(swarmKindClientProfile(255)).toBeNull();
  });

  it('static kinds (asteroid) drive lockBody + setShipState; dynamic kinds (drone) drive neither', () => {
    // The predWorld branches read these flags directly, so the profile IS the
    // routing contract: staticBody ⇒ lock + pose; hasAiBehaviour ⇒ register;
    // hasShield ⇒ setHullExposed.
    expect(swarmKindClientProfile(SWARM_KIND_ASTEROID)!.staticBody).toBe(true);
    expect(swarmKindClientProfile(SWARM_KIND_DRONE)!.staticBody).toBe(false);
  });
});
