import { describe, it, expect } from 'vitest';
import { deathHullLoot, killPodSpot, rollHullLoot, vaporisedSalvageExtra } from './hullLoot.js';
import { VAPORISE_SALVAGE_MUL, vaporiseSalvageBonus } from '../../shared-types/lootTables.js';

describe('hull loot (every ship) and vaporised salvage', () => {
  it('VAPORISE_SALVAGE_MUL is 1.5 and the bonus rounds the scaled total', () => {
    expect(VAPORISE_SALVAGE_MUL).toBe(1.5);
    expect(vaporiseSalvageBonus(0)).toBe(0);
    expect(vaporiseSalvageBonus(1)).toBe(1); // round(1.5) = 2
    expect(vaporiseSalvageBonus(14)).toBe(7);
  });

  it('the roll is seeded: same seed, same hull loot', () => {
    expect(rollHullLoot('ship-a', 'fighter', false)).toEqual(rollHullLoot('ship-a', 'fighter', false));
  });

  it('a vaporised death scales only salvage', () => {
    const plain = deathHullLoot('ship-b', 'fighter', false);
    const vap = deathHullLoot('ship-b', 'fighter', true);
    expect(vap.goods.salvage).toBe(Math.round((plain.goods.salvage ?? 0) * 1.5));
    expect(vap.goods.alloy).toBe(plain.goods.alloy);
  });

  it('an AI ship\'s extra scales only the hull salvage still aboard', () => {
    const rolled = rollHullLoot('d:1', 'fighter', false).goods.salvage ?? 0;
    expect(vaporisedSalvageExtra('d:1', 'fighter', false, rolled + 100)?.goods.salvage).toBe(vaporiseSalvageBonus(rolled));
    expect(vaporisedSalvageExtra('d:1', 'fighter', false, 0)).toBeUndefined();
  });

  it('the pod spot is off the killer\'s line, beyond the hull', () => {
    const out = { x: 0, y: 0 };
    killPodSpot(out, 2, 0, 1000, 50, 0, 0); // killer due south: line along +y
    expect(Math.abs(out.x)).toBeGreaterThan(50);
    expect(out.y).toBeCloseTo(1000);
  });
});
