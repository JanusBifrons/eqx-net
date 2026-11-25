/**
 * Base platforms slice 8 — the player snap lays plates: a connector anywhere
 * in a plate's MIDDLE hex snaps to the plate centre (the anchor); in any
 * other hex it keeps its small slot. Other kinds are unchanged.
 */
import { describe, it, expect } from 'vitest';
import { snapPlacementToDeck } from './deckPlacement.js';
import { snapToDeckSlot, type DeckSnap } from '../hex/deckSnap.js';
import { deckHexCentreInto, plateCentreWorldInto, plateHexes, DECK_HEX_SIZE } from '../hex/plates.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';

const out = (): DeckSnap => ({ x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small' });
const centre = (i: number, j: number): { x: number; y: number } => plateCentreWorldInto(i, j, { x: 0, y: 0 });
const ringHex = (i: number, j: number, k: number): { x: number; y: number } => {
  const h = plateHexes(i, j)[k]!;
  return deckHexCentreInto(h.q, h.r, { x: 0, y: 0 });
};

describe('snapPlacementToDeck — laying a plate', () => {
  it('a connector anywhere in a plate middle hex snaps to the plate centre', () => {
    for (const [i, j] of [[0, 0], [1, 0], [-2, 3]] as const) {
      const c = centre(i, j);
      for (const [dx, dy] of [[0, 0], [300, 0], [-200, 400], [0, -600], [550, 300]] as const) {
        const s = snapPlacementToDeck('connector', c.x + dx, c.y + dy, out());
        expect(s.slot, `${i},${j} +${dx},${dy}`).toBe('plate');
        expect(s.x).toBeCloseTo(c.x, 6);
        expect(s.y).toBeCloseTo(c.y, 6);
        expect(s.rhombus).toBe(-1);
      }
    }
  });

  it('a connector in a ring hex keeps the small-slot snap', () => {
    for (let k = 1; k <= 6; k++) {
      const p = ringHex(1, 0, k);
      const x = p.x + 0.3 * DECK_HEX_SIZE, y = p.y + 0.1 * DECK_HEX_SIZE;
      const s = snapPlacementToDeck('connector', x, y, out());
      const want = snapToDeckSlot('small', x, y, out());
      expect(s.slot, `ring ${k}`).toBe('small');
      expect(s.x).toBe(want.x);
      expect(s.y).toBe(want.y);
      expect(s.rhombus).toBe(want.rhombus);
    }
  });

  it('a non-connector in a middle hex keeps its own slot', () => {
    const c = centre(1, 0);
    for (const kind of ['solar', 'reactor'] as const) {
      const slot = getStructureKind(kind).deckSlot;
      const s = snapPlacementToDeck(kind, c.x + 200, c.y + 100, out());
      expect(s.slot).toBe(slot);
      expect(s).toEqual(snapToDeckSlot(slot, c.x + 200, c.y + 100, out()));
    }
  });

  it('is idempotent on the plate centre', () => {
    const c = centre(2, -1);
    const a = snapPlacementToDeck('connector', c.x + 123, c.y - 77, out());
    const b = snapPlacementToDeck('connector', a.x, a.y, out());
    expect(b).toEqual(a);
  });
});
