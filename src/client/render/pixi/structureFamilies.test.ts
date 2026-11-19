/** Structure families (stage-4 plan §4 0a, §6): every kind is in exactly one
 *  family, and every style C drawer lives in its kind's family file. */
import { describe, expect, it } from 'vitest';
import { STRUCTURE_KINDS_LIST } from '../../../shared-types/structureKinds.js';
import { STRUCTURE_FAMILY, STRUCTURE_FAMILY_IDS, structureFamilyOf } from './structureFamilies.js';
import { STYLE_C, STYLE_C_FAMILIES } from './structureStyleC.js';
import { structureStyleVersion } from './structureStyles.js';
import { bakeKey } from '../art/bake.js';

describe('structure families', () => {
  it('every catalogue kind is in exactly one family, and nothing else is', () => {
    const ids = STRUCTURE_KINDS_LIST.map((k) => k.id);
    expect(Object.keys(STRUCTURE_FAMILY).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(STRUCTURE_FAMILY_IDS, id).toContain(structureFamilyOf(id));
    expect(structureFamilyOf('no_such_kind')).toBeUndefined();
  });

  it('there is one style C file per family', () => {
    expect(Object.keys(STYLE_C_FAMILIES).sort()).toEqual([...STRUCTURE_FAMILY_IDS].sort());
  });

  it("every style C drawer lives in its kind's family file", () => {
    for (const [fam, f] of Object.entries(STYLE_C_FAMILIES)) {
      for (const id of Object.keys(f.kinds)) expect(structureFamilyOf(id), `${id} in ${fam}`).toBe(fam);
    }
  });

  it('STYLE_C is every family table spread, nothing more', () => {
    const n = Object.values(STYLE_C_FAMILIES).reduce((s, f) => s + Object.keys(f.kinds).length, 0);
    expect(Object.keys(STYLE_C.kinds)).toHaveLength(n);
    for (const f of Object.values(STYLE_C_FAMILIES)) {
      for (const [id, d] of Object.entries(f.kinds)) expect(STYLE_C.kinds[id], id).toBe(d);
    }
  });

  it("a family's version rides only its own kinds' bake keys", () => {
    for (const [fam, f] of Object.entries(STYLE_C_FAMILIES)) {
      for (const id of Object.keys(f.kinds)) {
        expect(structureStyleVersion('c', id), id).toBe(f.version);
        const key = bakeKey({ type: 'struct', id, seed: 1, rot: 0, style: 'c' });
        expect(key.endsWith(f.version ? `:Sc.${f.version}` : ':Sc'), `${fam} ${key}`).toBe(true);
      }
    }
    expect(structureStyleVersion('current', 'reactor')).toBe('');
    expect(structureStyleVersion(undefined, 'reactor')).toBe('');
    expect(structureStyleVersion('a', 'reactor')).toBe('');
  });
});
