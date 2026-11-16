/**
 * The tractor's hold cushion keeps the load off the emitter's hull
 * (barge-mining still 2026-11-15: a tractored rock piece was pulled INTO the
 * barge's side, a red "395" ram number and a shield flash where it touched).
 * The cushion is measured from the muzzle, and a big hull reaches further
 * than the weapon's 250 u `hold` from a mount on its deck.
 */
import { describe, expect, it } from 'vitest';
import type { TractorForceField } from '../physics/forceFields.js';
import { TRACTOR_LINE_CAP } from '../physics/forceFields.js';
import { setTractorHold, setTractorMountConstants, setTractorMuzzle } from './tractorField.js';
import { pointToShipPolygonDistance } from './Weapons.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';
import { TRACTOR_DEF } from './tractorSpec.js';
import type { WeaponMount } from '../../shared-types/shipKinds.js';

function field(): TractorForceField {
  return {
    kind: 'tractor', active: true, mx: 0, my: 0, mvx: 0, mvy: 0, target: 't', emitter: 'e',
    force: 0, dRef: 1, reach: 0, hold: 0, lineHalfWidth: 0, lineFrac: 0,
    lineCount: 0, lineIds: new Array<string>(TRACTOR_LINE_CAP).fill(''),
  };
}

/** Pose the field for emitter `kind` at (ex, ey, angle), mount `m`, a load of
 *  radius `r` at (tx, ty); returns where the load rests (muzzle + hold along
 *  the line) and how far that rest circle is from the hull. */
function rest(kind: string, m: WeaponMount, ex: number, ey: number, angle: number, tx: number, ty: number, r: number) {
  const f = field();
  setTractorMountConstants(f, m);
  setTractorMuzzle(f, ex, ey, angle, m);
  setTractorHold(f, m, kind, angle, tx, ty, r);
  const d = Math.hypot(tx - f.mx, ty - f.my);
  const rx = f.mx + ((tx - f.mx) / d) * f.hold;
  const ry = f.my + ((ty - f.my) / d) * f.hold;
  return { f, gap: pointToShipPolygonDistance(rx, ry, ex, ey, angle, shipCollisionParts(kind)) - r };
}

describe('tractor hold cushion clears the emitter hull', () => {
  // A mount on a battleship's deck, a little in from its side.
  const m = { id: 'tractor-t', weaponId: 'tractor', size: 'M', localX: 200, localY: 600 } as unknown as WeaponMount;

  for (const angle of [0, 0.9, -2.2]) {
    it(`a big load pulled in from abeam rests clear of a capital's hull (heading ${angle})`, () => {
      // The load sits 2,000 u out to the hull's +x side (rotated with it).
      const c = Math.cos(angle), s = Math.sin(angle);
      const tx = 5000 + 2000 * c - 600 * s, ty = -300 + 2000 * s + 600 * c;
      const { f, gap } = rest('battleship', m, 5000, -300, angle, tx, ty, 180);
      expect(gap, `hold ${f.hold.toFixed(0)}`).toBeGreaterThanOrEqual(-1e-6);
    });
  }

  it('a load pulled across the hull from the far side rests clear of the far side', () => {
    const { f, gap } = rest('battleship', m, 0, 0, 0, -3000, 600, 120);
    expect(gap, `hold ${f.hold.toFixed(0)}`).toBeGreaterThanOrEqual(-1e-6);
  });

  it('a small ship\'s tractor keeps the weapon\'s own hold (no re-tune)', () => {
    const s = { id: 'tractor-s', weaponId: 'tractor', size: 'S', localX: 0, localY: 10 } as unknown as WeaponMount;
    const { f } = rest('heavy', s, 0, 0, 0, 0, 1500, 9);
    expect(f.hold).toBe(TRACTOR_DEF.tractor!.hold);
  });
});
