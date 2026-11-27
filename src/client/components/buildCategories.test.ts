import { describe, it, expect } from 'vitest';
import {
  BUILD_CATEGORIES,
  DECK_CATEGORY,
  buildKindText,
  buildableKinds,
  categoriesFor,
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

  it('a deck room leads with the Deck tab: plates, shield fences and gates, roads, each shown once', () => {
    const deck = categoriesFor(true);
    expect(deck[0]).toBe(DECK_CATEGORY);
    expect(DECK_CATEGORY.kinds).toEqual(['connector', 'shield_pylon', 'shield_gate', 'shield_airlock', 'road']);
    const shown = deck.flatMap((c) => buildableKinds(c, true));
    const all = BUILD_CATEGORIES.flatMap((c) => c.kinds);
    expect(new Set(shown)).toEqual(new Set(all));
    expect(shown.length).toBe(all.length);
    expect(categoryById('core', true).kinds).not.toContain('connector');
    expect(categoryById('core', true).kinds).toContain('capital');
  });

  it('off a deck room there is no Deck tab and the taxonomy is unchanged', () => {
    expect(categoriesFor(false)).toBe(BUILD_CATEGORIES);
    expect(categoryById('core').kinds).toContain('connector');
  });

  it('on a deck room the Connector reads as the Deck plate; elsewhere the catalogue name stands', () => {
    expect(buildKindText('connector', true)?.name).toBe('Deck plate');
    expect(buildKindText('connector', false)).toBeNull();
    expect(buildKindText('shield_pylon', true)).toBeNull();
  });
});
