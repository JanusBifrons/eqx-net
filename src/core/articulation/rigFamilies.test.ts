/** Rig family files (stage-4 plan §4 0a): every rig is defined in exactly one
 *  `rigs/<family>.ts`, and the split changed no kind's rig. */
import { describe, expect, it } from 'vitest';
import { STRUCTURE_KINDS_LIST } from '../../shared-types/structureKinds.js';
import { RIG_DEFS, RIG_FAMILIES, rigById, rigForStructureKind } from './rigCatalogue.js';

/** Kind -> rig id before the split (the one map in rigCatalogue.ts), plus the
 *  rigs added since (Family 1: the solar tracker, the reactor fans;
 *  F2: the territory lock beacon; F3J: the shipyard build frame). */
const BEFORE_SPLIT: Readonly<Record<string, string>> = {
  freight_dock: 'dock-crane',
  capital: 'capital-crane',
  turret: 'sandbox-door-turret',
  solar: 'solar-tracker',
  reactor: 'reactor-fans',
  territory_lock: 'lock-beacon',
  shipyard: 'shipyard-frame',
};

describe('rig family files', () => {
  it('has the ten family files', () => {
    expect(Object.keys(RIG_FAMILIES)).toEqual([
      'core', 'power', 'fences', 'lightProduction', 'mining', 'heavyIndustry', 'turrets', 'coastal', 'storage', 'transport',
    ]);
  });

  it('every rig id is defined in exactly one family file', () => {
    const owner = new Map<string, string>();
    for (const [fam, f] of Object.entries(RIG_FAMILIES)) {
      for (const def of f.rigs) {
        expect(owner.get(def.id), `${def.id} in ${fam} and ${owner.get(def.id)}`).toBeUndefined();
        owner.set(def.id, fam);
      }
    }
    expect([...owner.keys()].sort()).toEqual(RIG_DEFS.map((d) => d.id).sort());
    expect(Object.fromEntries(owner)).toEqual({
      'capital-crane': 'core', 'sandbox-door-turret': 'turrets', 'dock-crane': 'transport', 'solar-tracker': 'power', 'reactor-fans': 'power',
      'lock-beacon': 'fences', 'shipyard-frame': 'heavyIndustry',
    });
  });

  it("a family maps kinds only to its own file's rigs", () => {
    for (const [fam, f] of Object.entries(RIG_FAMILIES)) {
      const own = new Set(f.rigs.map((d) => d.id));
      for (const [kind, rigId] of Object.entries(f.rigOfKind)) expect(own.has(rigId!), `${kind} -> ${rigId} in ${fam}`).toBe(true);
    }
  });

  it('rigForStructureKind is unchanged for every catalogue kind', () => {
    for (const k of STRUCTURE_KINDS_LIST) {
      const want = BEFORE_SPLIT[k.id];
      const rig = rigForStructureKind(k.id);
      if (want === undefined) expect(rig, k.id).toBeNull();
      else expect(rig, k.id).toBe(rigById(want));
    }
  });
});
