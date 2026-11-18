import { describe, expect, it } from 'vitest';
import {
  DEBT_FLOOR, LAUNCHABLE_HULL_KINDS, LAUNCH_COST, LAUNCH_COSTS_ON, isLaunchableHull, launchCost, launchVerdict,
} from './launch.js';
import { STARTER_HULL_KINDS } from './blueprints.js';
import { PLAYABLE_SHIP_KINDS_LIST, getShipKind } from './shipKinds.js';
import { sizeClassOf } from './shipScale/tuning.js';

const base = { wallet: 0, freeLaunches: 0, ownedHere: false, costsOn: true };

describe('launch table', () => {
  it('is the one starter list (no second list of free hulls)', () => {
    expect([...STARTER_HULL_KINDS].sort()).toEqual([...LAUNCHABLE_HULL_KINDS].sort());
  });

  it('only lists real, player-flyable, non-engineering hulls', () => {
    const playable = new Set(PLAYABLE_SHIP_KINDS_LIST.filter((k) => !k.engineeringOnly).map((k) => k.id));
    for (const k of LAUNCHABLE_HULL_KINDS) expect(playable.has(k)).toBe(true);
  });

  it('charges for capitals and nothing for sub-capitals', () => {
    for (const k of LAUNCHABLE_HULL_KINDS) {
      const capital = sizeClassOf(getShipKind(k)) === 'capital';
      expect(LAUNCH_COST[k]! > 0).toBe(capital);
    }
  });

  it('is switched on now the Hangar shows prices; off, every cost reads 0', () => {
    expect(LAUNCH_COSTS_ON).toBe(true);
    expect(launchCost('battleship')).toBe(60_000);
    expect(launchCost('battleship', false)).toBe(0);
  });

  it('knows Shipyard hulls are not launchable', () => {
    expect(isLaunchableHull('heavy')).toBe(false);
    expect(isLaunchableHull('fighter')).toBe(true);
  });
});

describe('launchVerdict', () => {
  it('owned hull launches free, even a Shipyard one', () => {
    expect(launchVerdict({ ...base, kind: 'heavy', ownedHere: true })).toEqual({ kind: 'owned', cost: 0 });
  });
  it('refuses a Shipyard hull you do not own', () => {
    expect(launchVerdict({ ...base, kind: 'heavy' })).toMatchObject({ kind: 'refuse', reason: 'shipyard' });
  });
  it('sub-capitals are free', () => {
    expect(launchVerdict({ ...base, kind: 'fighter' }).kind).toBe('free');
  });
  it('pays from the wallet when it can', () => {
    expect(launchVerdict({ ...base, kind: 'destroyer', wallet: 2_500, freeLaunches: 5 })).toEqual({ kind: 'pay', cost: 2_500 });
  });
  it('spends a free launch when short', () => {
    expect(launchVerdict({ ...base, kind: 'battleship', wallet: 100, freeLaunches: 1 })).toEqual({ kind: 'token', cost: 0 });
  });
  it('goes into debt once free launches are gone', () => {
    expect(launchVerdict({ ...base, kind: 'battleship', wallet: 0 })).toEqual({ kind: 'debt', cost: 60_000 });
  });
  it('allows debt exactly down to the floor', () => {
    expect(launchVerdict({ ...base, kind: 'battleship', wallet: DEBT_FLOOR + 60_000 }).kind).toBe('debt');
  });
  it('refuses below the floor', () => {
    expect(launchVerdict({ ...base, kind: 'battleship', wallet: DEBT_FLOOR + 59_999 })).toMatchObject({ kind: 'refuse', reason: 'broke' });
  });
  it('everything launchable is free while costs are off', () => {
    for (const k of LAUNCHABLE_HULL_KINDS) {
      expect(launchVerdict({ ...base, kind: k, costsOn: false, wallet: DEBT_FLOOR }).kind).toBe('free');
    }
  });
});
