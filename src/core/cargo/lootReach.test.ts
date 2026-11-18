import { describe, it, expect } from 'vitest';
import { withinLootOpenReach } from './lootReach.js';
import { LOOT_OPEN_REACH } from '../../shared-types/shipScale/lookup.js';
import { shipWithinHullReach } from '../combat/shipHitShape.js';

describe('withinLootOpenReach (cargo pods 16)', () => {
  it('is the hull-reach test at LOOT_OPEN_REACH', () => {
    for (const d of [0, 20, 60, 120, 200, 400, 1000]) {
      for (const shield of [false, true]) {
        expect(withinLootOpenReach('fighter', shield, d, 0, 0, 0, 0.3))
          .toBe(shipWithinHullReach('fighter', shield, d, 0, 0, 0, 0.3, LOOT_OPEN_REACH));
      }
    }
  });

  it('beside the ship opens; far away does not', () => {
    expect(withinLootOpenReach('fighter', false, 10, 0, 0, 0, 0)).toBe(true);
    expect(withinLootOpenReach('fighter', false, 5000, 0, 0, 0, 0)).toBe(false);
  });
});
