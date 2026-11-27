/**
 * The keep-placing rule (build-menu redesign M3): after a place you keep
 * placing the same building until you cancel, except a place-once kind
 * (Capital, territory lock) and a crate-stocked kind whose last crate that was.
 * Smelter stands in as a crate-stocked kind here (only the Capital needs a
 * crate today, and it already places once), so the crate branch is locked too.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('./blueprints.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./blueprints.js')>();
  return { ...real, needsPackedCrate: (k: string) => k === 'capital' || k === 'smelter' };
});

const { PLACE_ONCE_KINDS, placementEndsAfterPlace } = await import('./packedStock.js');

describe('placementEndsAfterPlace', () => {
  it('the Capital and a territory lock place once', () => {
    expect([...PLACE_ONCE_KINDS].sort()).toEqual(['capital', 'territory_lock']);
    expect(placementEndsAfterPlace('capital', { 'structure:capital': 3 })).toBe(true);
    expect(placementEndsAfterPlace('territory_lock', null)).toBe(true);
  });

  it('a bank-built kind keeps placing, whatever its crate count', () => {
    expect(placementEndsAfterPlace('solar', {})).toBe(false);
    expect(placementEndsAfterPlace('solar', null)).toBe(false);
    expect(placementEndsAfterPlace('cargo_bay', { 'structure:cargo_bay': 1 })).toBe(false);
  });

  it('a crate-stocked kind keeps placing while crates remain and ends on the last one', () => {
    expect(placementEndsAfterPlace('smelter', { 'structure:smelter': 2 })).toBe(false);
    expect(placementEndsAfterPlace('smelter', { 'structure:smelter': 1 })).toBe(true); // count reaches 0
    expect(placementEndsAfterPlace('smelter', {})).toBe(true);
  });

  it('plan then Build: planned buildings of the kind spend the stock too', () => {
    expect(placementEndsAfterPlace('smelter', { 'structure:smelter': 3 }, true, 1)).toBe(false);
    expect(placementEndsAfterPlace('smelter', { 'structure:smelter': 3 }, true, 2)).toBe(true); // the last unplanned crate
    expect(placementEndsAfterPlace('solar', {}, true, 5)).toBe(false); // bank-built: no cap
  });

  it('unknown stock or a room with no sector never ends a crate kind', () => {
    expect(placementEndsAfterPlace('smelter', null)).toBe(false);
    expect(placementEndsAfterPlace('smelter', { 'structure:smelter': 1 }, false)).toBe(false);
  });
});
