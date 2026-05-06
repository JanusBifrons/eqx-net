import { describe, it, expect } from 'vitest';
import {
  SHIP_KINDS,
  SHIP_KINDS_LIST,
  DEFAULT_SHIP_KIND,
  ShipKindSchema,
  getShipKind,
  isShipKindId,
  shipKindFromIndex,
  shipKindToIndex,
} from '../../src/shared-types/shipKinds.js';

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

  it('catalogue order is fighter -> scout -> heavy (wire-format-stable)', () => {
    // Wire format encodes drone kinds as a u8 index into SHIP_KINDS_LIST.
    // Reordering this list breaks decode for any in-flight v2 packet, so the
    // expected order is locked in by this test. Append-only is safe.
    expect(shipKindToIndex('fighter')).toBe(0);
    expect(shipKindToIndex('scout')).toBe(1);
    expect(shipKindToIndex('heavy')).toBe(2);
  });
});
