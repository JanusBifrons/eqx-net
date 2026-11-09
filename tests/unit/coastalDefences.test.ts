/**
 * Coastal defences catalogue (plan coastal-defences): each gun emplacement
 * repeats its weapon's numbers (reach, reload, damage) so the structure turret
 * path and the ship path agree, its barrels are a ship gun of the same calibre,
 * and the super-guns out-range the battleship's 16".
 */
import { describe, expect, it } from 'vitest';
import { COASTAL_DEFENCE_KINDS, getStructureKind } from '../../src/shared-types/structureKinds.js';
import { getWeapon, weaponAutoFireRange } from '../../src/core/combat/WeaponCatalogue.js';
import { navalTurret, structureMountMuzzle, structureNavalTurret } from '../../src/core/combat/muzzle.js';
import { getShipKind } from '../../src/shared-types/shipKinds.js';
import { AMMO_SHOTS_PER_UNIT } from '../../src/shared-types/ammo.js';

describe('coastal defence catalogue', () => {
  it('every gun repeats its weapon: reach (±1 u), reload and damage', () => {
    for (const id of COASTAL_DEFENCE_KINDS) {
      const k = getStructureKind(id);
      const m = k.mounts![0]!;
      const w = getWeapon(m.weaponId);
      expect(Math.abs(k.weaponRange! - weaponAutoFireRange(w)), id).toBeLessThanOrEqual(1);
      if (m.size !== 'AA') {
        expect(k.fireRateMs, id).toBe((w.cooldownTicks / 60) * 1000);
        expect(k.weaponDamage, id).toBe(w.damage);
      }
    }
  });

  it('every gun spends munitions (they fire shells)', () => {
    for (const id of COASTAL_DEFENCE_KINDS) expect(AMMO_SHOTS_PER_UNIT[id], id).toBeGreaterThan(0);
  });

  it('reach rises with calibre, and both super-guns out-range the 16"', () => {
    const reach = COASTAL_DEFENCE_KINDS.map((id) => getStructureKind(id).weaponRange!);
    const xl = getStructureKind('coastal_barbette_16in').weaponRange!;
    for (let i = 1; i < 5; i++) expect(reach[i]!).toBeGreaterThan(reach[i - 1]!);
    expect(getStructureKind('coastal_lindemann').weaponRange!).toBeGreaterThan(xl * 1.4);
    expect(getStructureKind('siege_gun_80cm').weaponRange!).toBeGreaterThan(xl);
  });

  it('a structure gun is the same size as the ship gun of its calibre', () => {
    const bb = getShipKind('battleship');
    const bbMain = bb.mounts!.find((m) => m.size === 'XL')!;
    const ship = navalTurret(bb, bbMain)!;
    const shore = structureNavalTurret(getStructureKind('coastal_barbette_16in').mounts![0]);
    // Same calibre table, same beam: equal up to the destroyer/class turretScale on ships.
    expect(shore!.len / (bbMain.turretScale ?? 1)).toBeCloseTo(ship.len / (bbMain.turretScale ?? 1), 0);
    expect(shore!.barrels).toBe(2);
    expect(structureNavalTurret(getStructureKind('coastal_turret_11in').mounts![0])!.barrels).toBe(3);
    expect(structureNavalTurret(getStructureKind('aa_quad_40mm').mounts![0])!.barrels).toBe(4);
  });

  it('the shot leaves the drawn barrel tip: gunhouse front + barrel', () => {
    for (const id of COASTAL_DEFENCE_KINDS) {
      const m = getStructureKind(id).mounts![0]!;
      const t = structureNavalTurret(m)!;
      expect(structureMountMuzzle(id, m), id).toBeCloseTo(t.houseL / 2 + t.len, 6);
    }
  });

  it('the old turrets keep their footprint-sized muzzle (records unchanged, no save reset)', () => {
    const m = getStructureKind('turret').mounts![0]!;
    expect(structureNavalTurret(m)).toBeNull();
    expect(structureMountMuzzle('turret', m)).toBeCloseTo(70 * 0.68, 6);
  });
});
