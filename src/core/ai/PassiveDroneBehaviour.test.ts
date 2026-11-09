import { describe, it, expect } from 'vitest';
import { PassiveDroneBehaviour } from './PassiveDroneBehaviour.js';
import { AiController } from './AiController.js';

/**
 * Lock-to-fire: a pilot's AUTO group locks only drones hostile to them, so a
 * passive drone (peacefulDrones rooms: auto-fire-test, combat-drone-test …)
 * must keep a hostility LEDGER even though it never acts on it. Before this,
 * `startHostile` / a hit marked nothing and AUTO never engaged the drone.
 */
describe('PassiveDroneBehaviour hostility ledger', () => {
  it('answers isHostileToPlayer after markHostile, until purged', () => {
    const b = new PassiveDroneBehaviour();
    expect(b.isHostileToPlayer('p1')).toBe(false);
    b.markHostile('p1', 10);
    expect(b.isHostileToPlayer('p1')).toBe(true);
    expect(b.isHostileToPlayer('p2')).toBe(false);
    b.purgeHostility('p1');
    expect(b.isHostileToPlayer('p1')).toBe(false);
  });

  it('flows through AiController.isEntityHostileToPlayer (the server npcHostileTo path)', () => {
    const ai = new AiController();
    ai.register('d1', 0, new PassiveDroneBehaviour());
    ai.markHostile('d1', 'p1', 5);
    expect(ai.isEntityHostileToPlayer('d1', 'p1')).toBe(true);
  });

  it('never exposes a `hostileTo` set (the mount ticker would aim + fire its turrets)', () => {
    const b = new PassiveDroneBehaviour();
    b.markHostile('p1', 1);
    expect((b as unknown as { hostileTo?: unknown }).hostileTo).toBeUndefined();
  });
});
