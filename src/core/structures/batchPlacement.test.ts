/**
 * Plan then Build — a batch of planned buildings checked against itself
 * (`BatchPlacementChecker`), the rule the server's `place_structures` and the
 * client's planned list share.
 */
import { describe, it, expect } from 'vitest';
import { BatchPlacementChecker, batchPlacementRejections, type BatchPlacementItem } from './batchPlacement.js';
import { PLACEMENT_REJECTION_TEXT, type PlacementDeck, type PlacementRejection } from './placementRules.js';
import { PLACE_REFUSAL_CODES } from '../../shared-types/messages.js';
import { PlateSet } from '../hex/plateSet.js';
import { deckHexCentreInto, plateCentreWorldInto, plateHexes } from '../hex/plates.js';

const centre = (i: number, j: number): { x: number; y: number } => plateCentreWorldInto(i, j, { x: 0, y: 0 });
const ringHex = (i: number, j: number, k: number): { x: number; y: number } => {
  const h = plateHexes(i, j)[k]!;
  return deckHexCentreInto(h.q, h.r, { x: 0, y: 0 });
};
const item = (kind: string, x: number, y: number): BatchPlacementItem => ({ kind, x, y, rot: 0 });

function run(items: BatchPlacementItem[], deck: PlacementDeck | null = null): { index: number[]; code: PlacementRejection[] } {
  const index: number[] = [], code: PlacementRejection[] = [];
  batchPlacementRejections(new BatchPlacementChecker(), items, [], deck, index, code);
  return { index, code };
}

describe('BatchPlacementChecker — a batch checked against itself', () => {
  it('items far apart are all legal', () => {
    expect(run([item('solar', 0, 0), item('solar', 3000, 0), item('reactor', 0, 3000)]).index).toEqual([]);
  });

  it('two items overlapping each other: the later one is refused overlap-structure', () => {
    expect(run([item('solar', 0, 0), item('solar', 100, 0), item('solar', 5000, 0)])).toEqual({ index: [1], code: ['overlap-structure'] });
  });

  it('an item clashing with the world is refused even when the batch is clear', () => {
    const index: number[] = [], code: PlacementRejection[] = [];
    const world = [{ x: 3000, y: 0, radius: 400, halfW: 400, halfH: 400 }];
    batchPlacementRejections(new BatchPlacementChecker(), [item('solar', 0, 0), item('solar', 3000, 0)], world, null, index, code);
    expect({ index, code }).toEqual({ index: [1], code: ['overlap-structure'] });
  });

  it('countOf sums a kind across the earlier items (crate stock)', () => {
    const c = new BatchPlacementChecker();
    c.begin([item('capital', 0, 0), item('solar', 3000, 0), item('capital', 6000, 0), item('capital', 9000, 0)], null);
    expect([0, 1, 2, 3].map((i) => c.countOf('capital', i))).toEqual([0, 1, 1, 2]);
  });

  it('a plate the batch lays is deck for its other items, in any order', () => {
    const ps = new PlateSet<string>();
    const home = centre(0, 0);
    ps.upsert('alice-plate', 'alice', 'connector', home.x, home.y);
    const deck: PlacementDeck = { plates: ps, owner: 'alice' };
    const newPlate = centre(1, 0);
    const onNew = ringHex(1, 0, 2);
    // Alone, a reactor on the new plate is off the deck.
    expect(run([item('reactor', onNew.x, onNew.y)], deck).code).toEqual(['off-deck']);
    // With the connector that lays it in the same batch: fine, before or after.
    expect(run([item('connector', newPlate.x, newPlate.y), item('reactor', onNew.x, onNew.y)], deck).index).toEqual([]);
    expect(run([item('reactor', onNew.x, onNew.y), item('connector', newPlate.x, newPlate.y)], deck).index).toEqual([]);
    const c = new BatchPlacementChecker();
    c.begin([item('reactor', onNew.x, onNew.y), item('connector', newPlate.x, newPlate.y)], deck);
    expect([c.isAnchor(0), c.isAnchor(1)]).toEqual([false, true]);
  });

  it('every placement rejection is a wire refusal code (both sides agree)', () => {
    for (const r of Object.keys(PLACEMENT_REJECTION_TEXT)) expect(PLACE_REFUSAL_CODES).toContain(r);
  });
});
