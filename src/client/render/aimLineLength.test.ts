import { describe, it, expect } from 'vitest';
import { aimLineLengthForMount } from './aimLineLength.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { getWeapon, type HitscanWeaponDef } from '../../core/combat/WeaponCatalogue.js';

/** R2.14 — the aim-line preview length must track the mount's bound weapon's
 *  effective reach, NOT a hardcoded 500. */
describe('aimLineLengthForMount (R2.14)', () => {
  it('an interceptor beam mount draws to its hitscan range, not the old 500', () => {
    const interceptor = getShipKind('interceptor');
    const mount = interceptor.mounts[0]!;
    const def = getWeapon(mount.weaponId) as HitscanWeaponDef;
    expect(def.mode).toBe('hitscan');
    // The line is the weapon's actual reach (hitscan range), e.g. 250…
    expect(aimLineLengthForMount(mount)).toBeCloseTo(def.range, 6);
    // …and crucially shorter than the old hardcoded 500 (the reported bug).
    expect(aimLineLengthForMount(mount)).toBeLessThan(500);
  });

  it('matches weaponAutoFireRange for every gameplay mount kind', () => {
    for (const kindId of ['fighter', 'interceptor', 'missile-frigate'] as const) {
      const kind = getShipKind(kindId);
      for (const mount of kind.mounts) {
        const def = getWeapon(mount.weaponId);
        // Hitscan → range; projectile → 0.85×; missile → 0.5×. All finite + > 0.
        const len = aimLineLengthForMount(mount);
        expect(len).toBeGreaterThan(0);
        expect(Number.isFinite(len)).toBe(true);
        if (def.mode === 'hitscan') expect(len).toBeCloseTo(def.range, 6);
      }
    }
  });
});
