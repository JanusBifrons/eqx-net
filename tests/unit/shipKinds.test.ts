import { describe, it, expect } from 'vitest';
import {
  SHIP_KINDS,
  SHIP_KINDS_LIST,
  DEFAULT_SHIP_KIND,
  ShipKindSchema,
  WeaponMountSchema,
  WeaponSlotSchema,
  MountWeaponIdSchema,
  getShipKind,
  isShipKindId,
  shipKindFromIndex,
  shipKindToIndex,
} from '../../src/shared-types/shipKinds.js';
import { WEAPON_IDS } from '../../src/core/combat/WeaponCatalogue.js';

describe('shipKinds catalogue', () => {
  it('has at least three kinds with stable ids', () => {
    expect(SHIP_KINDS_LIST.length).toBeGreaterThanOrEqual(3);
    expect(Object.keys(SHIP_KINDS)).toEqual(expect.arrayContaining(['fighter', 'scout', 'heavy']));
  });

  it('exposes the catalogue default at the front of the list (so "first kind" == default)', () => {
    expect(SHIP_KINDS_LIST[0]!.id).toBe(DEFAULT_SHIP_KIND);
  });

  it('every record passes its own zod schema', () => {
    for (const kind of SHIP_KINDS_LIST) {
      expect(() => ShipKindSchema.parse(kind)).not.toThrow();
    }
  });

  it('physics fields are in plausible ranges', () => {
    for (const kind of SHIP_KINDS_LIST) {
      expect(kind.thrustImpulse).toBeGreaterThan(0);
      expect(kind.boostMultiplier).toBeGreaterThanOrEqual(1);
      expect(kind.linearDamping).toBeGreaterThanOrEqual(0);
      expect(kind.lateralGrip).toBeGreaterThanOrEqual(0);
      expect(kind.lateralGrip).toBeLessThanOrEqual(1);
      expect(kind.maxAngvel).toBeGreaterThan(0);
      expect(kind.maxSpeed).toBeGreaterThan(0);
      expect(kind.radius).toBeGreaterThan(0);
      expect(kind.maxHealth).toBeGreaterThan(0);
    }
  });

  it('Heavy has the highest top speed (boosted terminal); Scout has the lowest', () => {
    // Boosted terminal velocity = thrust * boost / (1 - e^(-d/60))
    const terminal = (k: typeof SHIP_KINDS.fighter): number =>
      (k.thrustImpulse * k.boostMultiplier) / (1 - Math.exp(-k.linearDamping / 60));
    const scout = terminal(SHIP_KINDS.scout);
    const heavy = terminal(SHIP_KINDS.heavy);
    const fighter = terminal(SHIP_KINDS.fighter);
    expect(heavy).toBeGreaterThan(fighter);
    expect(fighter).toBeGreaterThan(scout);
  });

  it('Scout has the highest yaw rate; Heavy the lowest', () => {
    expect(SHIP_KINDS.scout.maxAngvel).toBeGreaterThan(SHIP_KINDS.fighter.maxAngvel);
    expect(SHIP_KINDS.fighter.maxAngvel).toBeGreaterThan(SHIP_KINDS.heavy.maxAngvel);
  });

  it('Heavy has the most hull; Scout the least', () => {
    expect(SHIP_KINDS.heavy.maxHealth).toBeGreaterThan(SHIP_KINDS.fighter.maxHealth);
    expect(SHIP_KINDS.fighter.maxHealth).toBeGreaterThan(SHIP_KINDS.scout.maxHealth);
  });
});

describe('getShipKind / isShipKindId', () => {
  it('isShipKindId narrows known ids', () => {
    expect(isShipKindId('fighter')).toBe(true);
    expect(isShipKindId('scout')).toBe(true);
    expect(isShipKindId('heavy')).toBe(true);
    expect(isShipKindId('garbage')).toBe(false);
    expect(isShipKindId('')).toBe(false);
  });

  it('getShipKind falls back to the catalogue default on unknown / nullish input', () => {
    expect(getShipKind('garbage').id).toBe(DEFAULT_SHIP_KIND);
    expect(getShipKind(null).id).toBe(DEFAULT_SHIP_KIND);
    expect(getShipKind(undefined).id).toBe(DEFAULT_SHIP_KIND);
    expect(getShipKind('').id).toBe(DEFAULT_SHIP_KIND);
  });

  it('getShipKind returns the exact catalogue record for a known id', () => {
    expect(getShipKind('scout')).toBe(SHIP_KINDS.scout);
    expect(getShipKind('heavy')).toBe(SHIP_KINDS.heavy);
  });
});

describe('weapon mounts + slots (Phase 1, 2026-05-11)', () => {
  it('every catalogue kind defines at least one mount and one slot', () => {
    for (const kind of SHIP_KINDS_LIST) {
      expect(kind.mounts, `${kind.id} mounts`).toBeDefined();
      expect(kind.slots, `${kind.id} slots`).toBeDefined();
      expect(kind.mounts!.length).toBeGreaterThanOrEqual(1);
      expect(kind.slots!.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('legacy kinds (fighter/scout/heavy) carry the canonical forward mount + primary slot', () => {
    for (const id of ['fighter', 'scout', 'heavy'] as const) {
      const kind = SHIP_KINDS[id];
      expect(kind.mounts).toHaveLength(1);
      const mount = kind.mounts![0]!;
      expect(mount).toMatchObject({
        id: 'forward',
        localX: 0,
        localY: 0,
        baseAngle: 0,
        arcMin: 0,
        arcMax: 0,
        rotationSpeed: 0,
        weaponId: 'hitscan',
      });
      expect(kind.slots).toHaveLength(1);
      const slot = kind.slots![0]!;
      expect(slot.id).toBe('primary');
      expect(slot.mountIds).toEqual(['forward']);
    }
  });

  it('MountWeaponIdSchema accepts exactly the ids in WEAPON_IDS (parity with WeaponCatalogue)', () => {
    for (const id of WEAPON_IDS) {
      expect(MountWeaponIdSchema.safeParse(id).success).toBe(true);
    }
    // Anything not in WEAPON_IDS should be rejected — this assertion will
    // catch a new weapon added to the catalogue that wasn't mirrored into
    // the mount schema.
    const accepted = MountWeaponIdSchema.options;
    expect([...accepted].sort()).toEqual([...WEAPON_IDS].sort());
  });

  it('WeaponMountSchema rejects arcMax < arcMin', () => {
    const result = WeaponMountSchema.safeParse({
      id: 'bad',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: 0.5,
      arcMax: -0.5,
      rotationSpeed: 0,
      weaponId: 'hitscan',
    });
    expect(result.success).toBe(false);
  });

  it('WeaponSlotSchema requires at least one mount id', () => {
    expect(
      WeaponSlotSchema.safeParse({ id: 'primary', displayName: 'Primary', mountIds: [] }).success,
    ).toBe(false);
  });

  it('ShipKindSchema rejects duplicate mount ids', () => {
    const result = ShipKindSchema.safeParse({
      ...SHIP_KINDS.fighter,
      mounts: [
        { id: 'forward', localX: 0, localY: 0, baseAngle: 0, arcMin: 0, arcMax: 0, rotationSpeed: 0, weaponId: 'hitscan' },
        { id: 'forward', localX: 2, localY: 0, baseAngle: 0, arcMin: 0, arcMax: 0, rotationSpeed: 0, weaponId: 'hitscan' },
      ],
      slots: [{ id: 'primary', displayName: 'Primary', mountIds: ['forward'] }],
    });
    expect(result.success).toBe(false);
  });

  it('ShipKindSchema rejects a slot referencing an unknown mount', () => {
    const result = ShipKindSchema.safeParse({
      ...SHIP_KINDS.fighter,
      mounts: [{ id: 'forward', localX: 0, localY: 0, baseAngle: 0, arcMin: 0, arcMax: 0, rotationSpeed: 0, weaponId: 'hitscan' }],
      slots: [{ id: 'primary', displayName: 'Primary', mountIds: ['ghost'] }],
    });
    expect(result.success).toBe(false);
  });

  it('ShipKindSchema rejects a mount that is in two slots', () => {
    const result = ShipKindSchema.safeParse({
      ...SHIP_KINDS.fighter,
      mounts: [{ id: 'forward', localX: 0, localY: 0, baseAngle: 0, arcMin: 0, arcMax: 0, rotationSpeed: 0, weaponId: 'hitscan' }],
      slots: [
        { id: 'primary', displayName: 'Primary', mountIds: ['forward'] },
        { id: 'secondary', displayName: 'Secondary', mountIds: ['forward'] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('ShipKindSchema rejects a mount with no owning slot', () => {
    const result = ShipKindSchema.safeParse({
      ...SHIP_KINDS.fighter,
      mounts: [
        { id: 'forward', localX: 0, localY: 0, baseAngle: 0, arcMin: 0, arcMax: 0, rotationSpeed: 0, weaponId: 'hitscan' },
        { id: 'orphan',  localX: 2, localY: 0, baseAngle: 0, arcMin: 0, arcMax: 0, rotationSpeed: 0, weaponId: 'hitscan' },
      ],
      slots: [{ id: 'primary', displayName: 'Primary', mountIds: ['forward'] }],
    });
    expect(result.success).toBe(false);
  });

  it('ShipKindSchema rejects mounts present without slots (or vice versa)', () => {
    // mounts without slots
    const noSlots = ShipKindSchema.safeParse({
      ...SHIP_KINDS.fighter,
      mounts: [{ id: 'forward', localX: 0, localY: 0, baseAngle: 0, arcMin: 0, arcMax: 0, rotationSpeed: 0, weaponId: 'hitscan' }],
      slots: undefined,
    });
    expect(noSlots.success).toBe(false);
    // slots without mounts
    const noMounts = ShipKindSchema.safeParse({
      ...SHIP_KINDS.fighter,
      mounts: undefined,
      slots: [{ id: 'primary', displayName: 'Primary', mountIds: ['forward'] }],
    });
    expect(noMounts.success).toBe(false);
  });
});

describe('shipKindToIndex / shipKindFromIndex round-trip (swarm wire format)', () => {
  it('round-trips every kind in the catalogue', () => {
    for (const kind of SHIP_KINDS_LIST) {
      expect(shipKindFromIndex(shipKindToIndex(kind.id))).toBe(kind.id);
    }
  });

  it('shipKindFromIndex falls back to the catalogue default on out-of-range input', () => {
    expect(shipKindFromIndex(255)).toBe(DEFAULT_SHIP_KIND);
    expect(shipKindFromIndex(-1)).toBe(DEFAULT_SHIP_KIND);
  });

  it('catalogue order is fighter -> scout -> heavy -> interceptor -> gunship -> missile-frigate (wire-format-stable)', () => {
    // Wire format encodes drone kinds as a u8 index into SHIP_KINDS_LIST.
    // Reordering this list breaks decode for any in-flight swarm packet, so
    // the expected order is locked in by this test. Append-only is safe.
    expect(shipKindToIndex('fighter')).toBe(0);
    expect(shipKindToIndex('scout')).toBe(1);
    expect(shipKindToIndex('heavy')).toBe(2);
    expect(shipKindToIndex('interceptor')).toBe(3);
    expect(shipKindToIndex('gunship')).toBe(4);
    expect(shipKindToIndex('missile-frigate')).toBe(5);
  });
});

describe('multi-mount kinds (Phase 3, 2026-05-11)', () => {
  it('interceptor has two wing mounts in a single primary slot, both arc-rotating', () => {
    const k = SHIP_KINDS.interceptor;
    expect(k.mounts).toHaveLength(2);
    const wingL = k.mounts!.find((m) => m.id === 'wing-l')!;
    const wingR = k.mounts!.find((m) => m.id === 'wing-r')!;
    // Mirrored offsets across the centreline (port and starboard).
    expect(wingL.localX).toBe(-wingR.localX);
    expect(wingL.localY).toBe(wingR.localY);
    // Both fire forward (baseAngle 0) with symmetric arc and matching slew
    // speeds — same hardpoint type, just mirrored. Phase 4b.1 (2026-05-11)
    // promoted the arcs from zero to ±30° once the rotation runtime spec
    // landed in WeaponMountController.
    for (const m of [wingL, wingR]) {
      expect(m.baseAngle).toBe(0);
      expect(m.arcMin).toBeCloseTo(-Math.PI / 6, 9);
      expect(m.arcMax).toBeCloseTo(Math.PI / 6, 9);
      expect(m.rotationSpeed).toBeGreaterThan(0);
      expect(m.weaponId).toBe('hitscan');
    }
    expect(k.slots).toHaveLength(1);
    expect(k.slots![0]!.id).toBe('primary');
    expect(k.slots![0]!.mountIds).toEqual(['wing-l', 'wing-r']);
  });

  it('gunship has a forward and a rear mount; rear fires backward with a wider arc', () => {
    const k = SHIP_KINDS.gunship;
    expect(k.mounts).toHaveLength(2);
    const forward = k.mounts!.find((m) => m.id === 'forward')!;
    const rear = k.mounts!.find((m) => m.id === 'rear')!;
    expect(forward.baseAngle).toBe(0);
    expect(rear.baseAngle).toBeCloseTo(Math.PI, 6);
    // Rear sits behind the forward mount (Pixi-up: tail is +y).
    expect(rear.localY).toBeGreaterThan(forward.localY);
    // Forward mount has a smaller arc than the rear (the rear is the wide
    // sweep that covers the gunship's blind sides while the body cruises).
    expect(rear.arcMax - rear.arcMin).toBeGreaterThan(forward.arcMax - forward.arcMin);
    // Both mounts rotate at the same speed (single chassis hardware).
    expect(forward.rotationSpeed).toBe(rear.rotationSpeed);
    expect(forward.rotationSpeed).toBeGreaterThan(0);
    expect(k.slots).toHaveLength(1);
    expect(k.slots![0]!.mountIds).toEqual(['forward', 'rear']);
  });

  it('Heavy is still the deepest hull (multi-mount kinds slot between)', () => {
    // Lock the relative ordering so a future tuning pass doesn't accidentally
    // make gunship beefier than heavy or interceptor frailer than scout.
    expect(SHIP_KINDS.heavy.maxHealth).toBeGreaterThan(SHIP_KINDS.gunship.maxHealth);
    expect(SHIP_KINDS.gunship.maxHealth).toBeGreaterThan(SHIP_KINDS.fighter.maxHealth);
    expect(SHIP_KINDS.fighter.maxHealth).toBeGreaterThan(SHIP_KINDS.interceptor.maxHealth);
    expect(SHIP_KINDS.interceptor.maxHealth).toBeGreaterThan(SHIP_KINDS.scout.maxHealth);
  });
});
