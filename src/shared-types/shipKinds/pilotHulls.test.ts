import { describe, expect, it } from 'vitest';
import { PLAYABLE_SHIP_KINDS_LIST } from '../shipKinds.js';
import { capitalClassAndFitOf } from './capitals/index.js';
import { BASE_PILOT_HULL_KINDS_LIST, PILOT_HULL_KINDS_LIST, isBaseHullId } from './pilotHulls.js';

describe('pilot hulls (shared by the Hangar and the sandbox fleet)', () => {
  it('is the playable list minus engineering-only hulls (the old hangarKinds rule)', () => {
    expect(PILOT_HULL_KINDS_LIST.map((k) => k.id)).toEqual(
      PLAYABLE_SHIP_KINDS_LIST.filter((k) => !k.engineeringOnly).map((k) => k.id),
    );
  });

  it('base hulls: one per hull, fit variants folded into their class', () => {
    const ids = BASE_PILOT_HULL_KINDS_LIST.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ['battleship-rail', 'heavy-cruiser-beam', 'battlecruiser-lance']) expect(ids).not.toContain(id);
    for (const id of ['fighter', 'destroyer', 'battleship', 'heavy-cruiser', 'battlecruiser', 'barge']) expect(ids).toContain(id);
    // Every pilot hull is either a base hull or the fit of one that is listed.
    for (const k of PILOT_HULL_KINDS_LIST) {
      const cf = capitalClassAndFitOf(k.id);
      expect(isBaseHullId(k.id) || (cf !== null && ids.includes(cf.classId))).toBe(true);
    }
  });
});
