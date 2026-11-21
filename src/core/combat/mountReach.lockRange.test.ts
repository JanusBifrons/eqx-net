/**
 * `shipLockRange` (owner 2026-11-21): a ship's lock range is its own LONGEST
 * weapon's reach (`mountWeaponReach`, the fire gate's per-mount reach), not a
 * flat number. A mining tool counts (a miner locks rocks with it).
 */
import { describe, it, expect } from 'vitest';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { mountWeaponReach, shipLockRange } from './mountReach.js';

const longest = (id: Parameters<typeof getShipKind>[0]): number =>
  Math.max(0, ...(getShipKind(id).mounts ?? []).map((m) => mountWeaponReach(m)));

describe('shipLockRange', () => {
  it("is the ship's longest mount reach", () => {
    for (const id of ['fighter', 'interceptor', 'battleship', 'battleship-rail', 'heavy-cruiser-beam', 'mining-skiff'] as const) {
      expect(shipLockRange(getShipKind(id))).toBe(longest(id));
    }
  });

  it('a short-gunned fighter locks far less far than a railgun battleship', () => {
    const fighter = shipLockRange(getShipKind('fighter'));
    const rail = shipLockRange(getShipKind('battleship-rail'));
    expect(fighter).toBeGreaterThan(0);
    expect(fighter).toBeLessThan(2000);
    expect(rail).toBeGreaterThan(fighter * 10);
    // The interceptor's hitscan is shorter still.
    expect(shipLockRange(getShipKind('interceptor'))).toBeLessThan(fighter);
  });

  it('a ship with only mining tools locks out to its tool; one with no mounts never locks', () => {
    expect(shipLockRange(getShipKind('mining-skiff'))).toBeGreaterThan(0);
    expect(shipLockRange(getShipKind('cargo-pod'))).toBe(0);
  });
});
