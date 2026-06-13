import { describe, it, expect } from 'vitest';
import {
  BUILD_CATEGORIES,
  ROOT_VIEW,
  goBackView,
  categoryById,
} from './buildCategories';
import { STRUCTURE_KINDS_LIST } from '@shared-types/structureKinds';

/**
 * WS-13 / R2.6 — taxonomy + dial nav reducer locks.
 *
 * The exhaustiveness test fails closed: append a 10th structure kind to the
 * catalogue without assigning it a Build category and this RED's — so a new kind
 * can never silently drop out of the Build menu.
 */
describe('buildCategories taxonomy', () => {
  it('covers every structure kind exactly once (no orphan, no duplicate)', () => {
    const categorised = BUILD_CATEGORIES.flatMap((c) => c.kinds);
    const all = STRUCTURE_KINDS_LIST.map((k) => k.id);
    expect(new Set(categorised)).toEqual(new Set(all));
    // length equality rules out duplicates hiding an orphan and vice-versa.
    expect(categorised.length).toBe(all.length);
  });

  it('resolves every category id', () => {
    for (const c of BUILD_CATEGORIES) {
      expect(categoryById(c.id)).toBe(c);
    }
  });
});

describe('goBackView nav reducer', () => {
  it('pops kinds → categories', () => {
    expect(goBackView({ level: 'kinds', category: 'defence' })).toEqual({ level: 'categories' });
  });

  it('pops categories → root', () => {
    expect(goBackView({ level: 'categories' })).toEqual(ROOT_VIEW);
  });

  it('root stays root (no underflow)', () => {
    expect(goBackView(ROOT_VIEW)).toEqual(ROOT_VIEW);
  });
});
