import { describe, it, expect } from 'vitest';
import { handleContactBatch, shouldBroadcastContact, type ContactBatchHost } from './contactFilter.js';
import type { ContactPayload } from './PhysicsWorkerProxy.js';
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

/**
 * Live report 2026-11-21 (sol-prime): a Sol Dominion flagship fleet razed a
 * new player's home base though the player never attacked anyone. The fleet
 * guards the home pocket, where players build, and its ships bump the base.
 * A ram hands each side the OTHER id as its attacker, so the bumped STRUCTURE
 * was booked as the attacker of the ship that flew into it: that marked the
 * ship hostile and escalated the owner's whole faction to war
 * (`escalateFactionOnDroneHit`). A structure is locked in place and never
 * rams: damage it deals by contact has no attacker.
 */
describe('handleContactBatch: a structure never rams', () => {
  function hostFor(kinds: Record<string, number>) {
    const calls: Array<[string, string, number]> = [];
    const host = {
      sceneWork: { active: false, contacts: 0 },
      collisionGate: { sweep: () => {}, shouldSend: () => false },
      cutField: () => undefined,
      bus: () => ({ emit: () => true }),
      broadcast: () => {},
      disableCollisionDamage: () => false,
      loot: () => ({ hullContact: () => false }),
      applyDamage: (t: string, s: string, d: number) => { calls.push([t, s, d]); return false; },
      swarmRegistry: { get: (id: string) => (kinds[id] === undefined ? undefined : { id, kind: kinds[id] }) },
      lingeringSlots: new Map<string, number>(),
      ships: () => ({ get: () => undefined }),
      getActiveShip: () => undefined,
    } as unknown as ContactBatchHost;
    return { host, calls };
  }
  const ram = (aId: string, bId: string): ContactPayload => ({
    aId, bId, vAxPost: 0, vAyPost: 0, vBxPost: 0, vByPost: 0,
    forceMagnitude: 1e6, impactSpeed: 300, normalSpeed: 300, aMass: 5000, bMass: 5000,
  }) as ContactPayload;

  it('a ship flying into a player structure takes damage with NO attacker; the structure is hit by the ship', () => {
    const { host, calls } = hostFor({ 'flagship-10-e0': 1, 'pstruct-capital': 2 });
    handleContactBatch(host, 1, [ram('flagship-10-e0', 'pstruct-capital')]);
    expect(calls.length).toBe(2);
    expect(calls.find((c) => c[0] === 'flagship-10-e0')?.[1]).toBe('');
    expect(calls.find((c) => c[0] === 'pstruct-capital')?.[1]).toBe('flagship-10-e0');
  });

  it('the same holds with the structure as body A', () => {
    const { host, calls } = hostFor({ 'flagship-10-e0': 1, 'pstruct-capital': 2 });
    handleContactBatch(host, 1, [ram('pstruct-capital', 'flagship-10-e0')]);
    expect(calls.find((c) => c[0] === 'flagship-10-e0')?.[1]).toBe('');
  });

  it('ship-vs-ship rams keep their attacker (ramming is a weapon)', () => {
    const { host, calls } = hostFor({ 'lwbot-1': 1, 'lwbot-2': 1 });
    handleContactBatch(host, 1, [ram('lwbot-1', 'lwbot-2')]);
    expect(calls.find((c) => c[0] === 'lwbot-1')?.[1]).toBe('lwbot-2');
    expect(calls.find((c) => c[0] === 'lwbot-2')?.[1]).toBe('lwbot-1');
  });
});

/**
 * Live report 2026-11-21: a flagship escort flew into a player's PARKED Mining
 * Skiff. The ram booked the parked Skiff as the escort's attacker, so the
 * escort was marked hostile and the player's whole faction went to war with
 * the drones (the fleet then raided the base). Only a ship that was driving
 * into the other (its own pre-step speed toward the other along the contact
 * normal, `aApproach` / `bApproach`) rams; a still or retreating ship never
 * becomes an attacker. Both ships still take their damage.
 */
describe('handleContactBatch: only the ship driving in rams', () => {
  function hostFor(kinds: Record<string, number>) {
    const calls: Array<[string, string, number]> = [];
    const host = {
      sceneWork: { active: false, contacts: 0 },
      collisionGate: { sweep: () => {}, shouldSend: () => false },
      cutField: () => undefined,
      bus: () => ({ emit: () => true }),
      broadcast: () => {},
      disableCollisionDamage: () => false,
      loot: () => ({ hullContact: () => false }),
      applyDamage: (t: string, s: string, d: number) => { calls.push([t, s, d]); return false; },
      swarmRegistry: { get: (id: string) => (kinds[id] === undefined ? undefined : { id, kind: kinds[id] }) },
      lingeringSlots: new Map<string, number>(),
      ships: () => ({ get: () => undefined }),
      getActiveShip: () => undefined,
    } as unknown as ContactBatchHost;
    return { host, calls };
  }
  const ram = (aId: string, bId: string, aApproach: number, bApproach: number): ContactPayload => ({
    aId, bId, vAxPost: 0, vAyPost: 0, vBxPost: 0, vByPost: 0,
    forceMagnitude: 1e6, impactSpeed: 300, normalSpeed: 300, aMass: 5000, bMass: 5000,
    aApproach, bApproach,
  });

  it('a moving escort into a parked Skiff: the parked Skiff is never the attacker, both take damage', () => {
    const { host, calls } = hostFor({ 'flagship-10-e0': 1 });
    handleContactBatch(host, 1, [ram('flagship-10-e0', 'linger-skiff', 300, 0)]);
    expect(calls.length).toBe(2);
    expect(calls.find((c) => c[0] === 'flagship-10-e0')?.[1]).toBe('');
    expect(calls.find((c) => c[0] === 'linger-skiff')?.[1]).toBe('flagship-10-e0');
  });

  it('the same with the parked ship as body A', () => {
    const { host, calls } = hostFor({ 'flagship-10-e0': 1 });
    handleContactBatch(host, 1, [ram('linger-skiff', 'flagship-10-e0', 0, 300)]);
    expect(calls.find((c) => c[0] === 'flagship-10-e0')?.[1]).toBe('');
    expect(calls.find((c) => c[0] === 'linger-skiff')?.[1]).toBe('flagship-10-e0');
  });

  it('a ship backing away while the other drives in is never the attacker', () => {
    const { host, calls } = hostFor({ 'lwbot-1': 1, 'lwbot-2': 1 });
    handleContactBatch(host, 1, [ram('lwbot-1', 'lwbot-2', 400, -100)]);
    expect(calls.find((c) => c[0] === 'lwbot-1')?.[1]).toBe('');
    expect(calls.find((c) => c[0] === 'lwbot-2')?.[1]).toBe('lwbot-1');
  });

  it('a deliberate ram still books the mover, and a head-on books both', () => {
    const { host, calls } = hostFor({ 'lwbot-1': 1 });
    handleContactBatch(host, 1, [ram('player-1', 'lwbot-1', 300, 0)]);
    expect(calls.find((c) => c[0] === 'lwbot-1')?.[1]).toBe('player-1');
    const both = hostFor({ 'lwbot-1': 1, 'lwbot-2': 1 });
    handleContactBatch(both.host, 1, [ram('lwbot-1', 'lwbot-2', 150, 150)]);
    expect(both.calls.find((c) => c[0] === 'lwbot-1')?.[1]).toBe('lwbot-2');
    expect(both.calls.find((c) => c[0] === 'lwbot-2')?.[1]).toBe('lwbot-1');
  });
});
