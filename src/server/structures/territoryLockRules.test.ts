/**
 * Territory Lock placement rules (sector control): only the holder's side may
 * build one, at most one per sector, and only a BUILT lock locks.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCK_NOT_HELD_REASON,
  LOCK_TAKEN_REASON,
  isLiveTerritoryLock,
  territoryLockRefusal,
} from './territoryLockRules.js';
import type { StructureRecord } from './StructureRegistry.js';
import { STRUCTURE_KINDS_LIST, TERRITORY_LOCK_COST, getStructureKind } from '../../shared-types/structureKinds.js';
import { STARTER_STRUCTURE_KINDS } from '../../shared-types/blueprints.js';

const rec = (kind: string, owner: string, isConstructed = true): StructureRecord =>
  ({ id: `s-${kind}`, owner, kind, isConstructed }) as unknown as StructureRecord;

describe('territoryLockRefusal', () => {
  it('ignores every other kind', () => {
    expect(territoryLockRefusal('alice', 'connector', 'orion-belt', null, [])).toBeNull();
  });

  it('refuses when the builder\'s side does not hold the sector', () => {
    expect(territoryLockRefusal('alice', 'territory_lock', 'orion-belt', null, [])).toBe(LOCK_NOT_HELD_REASON);
    expect(territoryLockRefusal('alice', 'territory_lock', 'orion-belt', 'bob', [])).toBe(LOCK_NOT_HELD_REASON);
    // No meter running: the static controller stands in (never a player).
    expect(territoryLockRefusal('alice', 'territory_lock', 'sol-prime', undefined, [])).toBe(LOCK_NOT_HELD_REASON);
  });

  it('allows the holder, once per sector (a lock still building counts)', () => {
    expect(territoryLockRefusal('alice', 'territory_lock', 'orion-belt', 'alice', [rec('capital', 'alice')])).toBeNull();
    expect(
      territoryLockRefusal('alice', 'territory_lock', 'orion-belt', 'alice', [rec('territory_lock', 'alice', false)]),
    ).toBe(LOCK_TAKEN_REASON);
  });

  it('only a built lock is live', () => {
    expect(isLiveTerritoryLock(rec('territory_lock', 'alice', true))).toBe(true);
    expect(isLiveTerritoryLock(rec('territory_lock', 'alice', false))).toBe(false);
    expect(isLiveTerritoryLock(rec('capital', 'alice', true))).toBe(false);
  });
});

describe('Territory Lock catalogue record', () => {
  it('is the priciest normal structure, built from minerals like a starter kind', () => {
    expect(getStructureKind('territory_lock').constructionCost).toBe(TERRITORY_LOCK_COST);
    for (const k of STRUCTURE_KINDS_LIST) {
      if (k.id !== 'territory_lock') expect(k.constructionCost).toBeLessThan(TERRITORY_LOCK_COST);
    }
    expect(STARTER_STRUCTURE_KINDS).toContain('territory_lock');
    // Appended last (wire subtype index, invariant #11).
    expect(STRUCTURE_KINDS_LIST.at(-1)!.id).toBe('territory_lock');
  });
});
