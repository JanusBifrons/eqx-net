import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_IDS, blueprintName, fittedCargoMul, fittedHullMul, fittedUid, rollBlueprint, weaponGate, weaponUnlocked,
} from './blueprints.js';
import { rollEliteLoot } from './elites.js';

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('blueprints (P5)', () => {
  it('gates heat-seekers behind the Missile Rack; other weapons are free', () => {
    expect(weaponUnlocked('heat-seeker', [])).toBe(false);
    expect(weaponUnlocked('heat-seeker', ['bp-missile-rack'])).toBe(true);
    expect(weaponUnlocked('laser', [])).toBe(true);
    expect(weaponGate('heat-seeker')).toBe('bp-missile-rack');
    expect(weaponGate('hitscan')).toBeNull();
  });

  it('cargo and hull multipliers come only from their own blueprints', () => {
    expect(fittedCargoMul([])).toBe(1);
    expect(fittedCargoMul(['bp-cargo-expander'])).toBe(1.5);
    expect(fittedHullMul(['bp-cargo-expander'])).toBe(1);
    expect(fittedHullMul(['bp-reinforced-hull'])).toBe(1.25);
    expect(fittedCargoMul(['not-a-blueprint'])).toBe(1);
  });

  it('names and fitted keys never leak ids into the UI', () => {
    expect(blueprintName('bp-missile-rack')).toBe('Missile Rack');
    expect(blueprintName('mystery')).toBe('Blueprint');
    expect(fittedUid('ship-1')).toBe('fitted:ship-1');
  });

  it('drops are a known id at the given chance; elites sometimes carry one', () => {
    expect(rollBlueprint(() => 0.99, 0.4)).toBeNull();
    const id = rollBlueprint(seeded(3), 1);
    expect(BLUEPRINT_IDS).toContain(id);
    let withBp = 0;
    for (let s = 1; s <= 200; s++) if (rollEliteLoot('gunship', seeded(s)).blueprints.length > 0) withBp++;
    expect(withBp).toBeGreaterThan(40);
    expect(withBp).toBeLessThan(140);
  });
});
