import { describe, it, expect } from 'vitest';
import {
  BUILD_CATEGORIES,
  buildableKinds,
  categoryById,
} from './buildCategories';
import { STRUCTURE_KINDS_LIST, isBuildableStructureKind } from '@shared-types/structureKinds';

/**
 * WS-13 / R2.6 — taxonomy locks.
 *
 * The exhaustiveness test fails closed: append a 10th structure kind to the
 * catalogue without assigning it a Build category and this RED's — so a new kind
 * can never silently drop out of the Build menu.
 */
describe('buildCategories taxonomy', () => {
  it('covers every buildable structure kind exactly once (no orphan, no duplicate)', () => {
    const categorised = BUILD_CATEGORIES.flatMap((c) => c.kinds);
    const all = STRUCTURE_KINDS_LIST.map((k) => k.id).filter((id) => isBuildableStructureKind(id));
    expect(new Set(categorised)).toEqual(new Set(all));
    // length equality rules out duplicates hiding an orphan and vice-versa.
    expect(categorised.length).toBe(all.length);
  });

  it('offers the road deck tile on a deck room only', () => {
    const transport = categoryById('transport');
    expect(buildableKinds(transport, true)).toContain('road');
    expect(buildableKinds(transport, false)).not.toContain('road');
    expect(buildableKinds(transport, false)).toContain('teleporter');
  });

  it('resolves every category id', () => {
    for (const c of BUILD_CATEGORIES) {
      expect(categoryById(c.id)).toBe(c);
    }
  });
});
