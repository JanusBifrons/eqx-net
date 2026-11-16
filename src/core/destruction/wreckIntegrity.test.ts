/**
 * Wreck-piece integrity (salvage stream PR 5, capital-destruction.md §S4
 * "Re-split"): the pure I_max formula, the split size gate, salvage worth and
 * the per-weapon wear factor.
 */
import { describe, expect, it } from 'vitest';
import { wreckCanResplit, wreckHullArea, wreckPieceIntegrity, wreckSalvageQty, wreckWearFactor, WRECK_RESPLIT_MIN_RADIUS_PER_RADIUS } from './wreckIntegrity.js';
import { wreckPieceGeometry } from './wreckPieces.js';
import { DESTRUCTION_PROFILES } from '../../shared-types/shipScale/destruction.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipBodyMass } from '../../shared-types/shipScale/tuning.js';
import { WEAPONS } from '../combat/WeaponCatalogue.js';

const cap = DESTRUCTION_PROFILES.capital.resplit!;
const sub = DESTRUCTION_PROFILES.subcap.resplit!;

describe('wreckPieceIntegrity (I_max)', () => {
  it('is the piece\'s mass share × max hull × integrityMul', () => {
    const k = getShipKind('battleship');
    const m = shipBodyMass(k);
    expect(wreckPieceIntegrity('battleship', 0.3 * m)).toBeCloseTo(0.3 * k.maxHealth * cap.integrityMul, 6);
    expect(wreckPieceIntegrity('battleship', m)).toBeCloseTo(k.maxHealth * cap.integrityMul, 6);
  });

  it('clamps the share to 1 and floors at integrityMinFrac × max hull', () => {
    const k = getShipKind('battleship');
    const m = shipBodyMass(k);
    expect(wreckPieceIntegrity('battleship', 3 * m)).toBeCloseTo(k.maxHealth * cap.integrityMul, 6);
    expect(wreckPieceIntegrity('battleship', 0)).toBeCloseTo(cap.integrityMinFrac * k.maxHealth, 6);
    expect(wreckPieceIntegrity('battleship', -5)).toBeCloseTo(cap.integrityMinFrac * k.maxHealth, 6);
  });

  it('uses the sub-cap profile for a sub-capital', () => {
    const k = getShipKind('fighter');
    expect(wreckPieceIntegrity('fighter', 0.5 * shipBodyMass(k))).toBeCloseTo(0.5 * k.maxHealth * sub.integrityMul, 6);
  });

  it('prints how long a battleship\'s biggest piece lasts (mining laser vs guns)', () => {
    const k = getShipKind('battleship');
    const g = wreckPieceGeometry({ kindId: 'battleship', seed: 7, killX: 0, killY: -100, killBlowDamage: 0.3, recentDamageRate: 0.3, snapChance: 0 });
    const big = g.reduce((a, b) => (b.mass > a.mass ? b : a));
    const i = wreckPieceIntegrity('battleship', big.mass);
    console.log(`[wreck integrity] battleship maxHull ${k.maxHealth}, biggest piece ${(big.mass / shipBodyMass(k) * 100).toFixed(1)} % of the hull: I_max ${i.toFixed(0)}; factor-1 damage ${i.toFixed(0)}, ordinary-gun damage ${(i / 0.1).toFixed(0)}`);
    expect(i).toBeGreaterThan(0);
  });
});

describe('wreckCanResplit / wreckSalvageQty', () => {
  it('splits at minAreaFrac of the hull area and the kind-scaled least radius (#18)', () => {
    const a = wreckHullArea('battleship');
    const r = WRECK_RESPLIT_MIN_RADIUS_PER_RADIUS * getShipKind('battleship').radius;
    expect(wreckCanResplit('battleship', cap.minAreaFrac * a, r)).toBe(true);
    expect(wreckCanResplit('battleship', cap.minAreaFrac * a * 0.99, r)).toBe(false);
    expect(wreckCanResplit('battleship', a, r * 0.99)).toBe(false);
  });

  it('salvage is the mass share of salvagePerHull, at least 1', () => {
    const m = shipBodyMass(getShipKind('battleship'));
    expect(wreckSalvageQty('battleship', 0.01 * m)).toBe(Math.round(0.01 * cap.salvagePerHull));
    expect(wreckSalvageQty('battleship', 0)).toBe(1);
    expect(wreckSalvageQty('fighter', 0.1 * shipBodyMass(getShipKind('fighter')))).toBe(1);
  });
});

describe('wreckWearFactor', () => {
  it('ordinary weapons wear at 0.1, a weapon with a wreck factor at that factor, untagged hits at 0.1', () => {
    expect(wreckWearFactor('laser')).toBe(0.1);
    expect(wreckWearFactor(undefined)).toBe(0.1);
    const def = WEAPONS.get('laser')!;
    def.targetFactor = { wreck: 1 };
    try {
      expect(wreckWearFactor('laser')).toBe(1);
    } finally {
      delete def.targetFactor;
    }
  });
});
