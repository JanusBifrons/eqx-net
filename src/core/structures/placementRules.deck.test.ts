/**
 * Base platforms — the `off-deck` placement rule (`placementRejection`'s deck
 * context). On a deck room a player's structure must stand on one of their
 * own plates; a connector may also lay a NEW plate on the centre of a plate
 * bordering theirs. No deck context = no deck rule.
 */
import { describe, it, expect } from 'vitest';
import { placementRejection, type PlacementDeck } from './placementRules.js';
import { OwnerPlateList, PlateSet } from '../hex/plateSet.js';
import { deckHexCentreInto, plateCentreWorldInto, plateHexes } from '../hex/plates.js';

const centre = (i: number, j: number): { x: number; y: number } => plateCentreWorldInto(i, j, { x: 0, y: 0 });
const ringHex = (i: number, j: number, k: number): { x: number; y: number } => {
  const h = plateHexes(i, j)[k]!;
  return deckHexCentreInto(h.q, h.r, { x: 0, y: 0 });
};

function plates(): PlateSet<string> {
  const ps = new PlateSet<string>();
  const a = centre(0, 0), b = centre(4, 0);
  ps.upsert('alice-plate', 'alice', 'connector', a.x, a.y);
  ps.upsert('bob-plate', 'bob', 'connector', b.x, b.y);
  return ps;
}
const deckOf = (owner: string): PlacementDeck => ({ plates: plates(), owner });
const reject = (kind: string, p: { x: number; y: number }, deck: PlacementDeck | null): ReturnType<typeof placementRejection> =>
  placementRejection(kind, p.x, p.y, [], null, 0, false, deck);

describe('placementRejection — off-deck', () => {
  it('a structure on one of the owner\'s plates is ok', () => {
    expect(reject('reactor', ringHex(0, 0, 2), deckOf('alice'))).toBeNull();
    expect(reject('solar', ringHex(0, 0, 5), deckOf('alice'))).toBeNull();
  });

  it('a structure off every plate is rejected', () => {
    expect(reject('reactor', centre(9, -7), deckOf('alice'))).toBe('off-deck');
    expect(reject('reactor', ringHex(1, 0, 1), deckOf('alice'))).toBe('off-deck');
  });

  it('a connector on the centre of a plate bordering the owner\'s deck lays a new plate', () => {
    for (const [i, j] of [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]] as const) {
      expect(reject('connector', centre(i, j), deckOf('alice')), `${i},${j}`).toBeNull();
    }
  });

  it('a connector on a plate centre NOT bordering the owner\'s deck is rejected', () => {
    expect(reject('connector', centre(2, 2), deckOf('alice'))).toBe('off-deck');
    // Bordering only bob's plate is not alice's deck.
    expect(reject('connector', centre(5, 0), deckOf('alice'))).toBe('off-deck');
  });

  it('a non-connector on an adjacent plate centre is rejected (only connectors lay plates)', () => {
    expect(reject('reactor', centre(1, 0), deckOf('alice'))).toBe('off-deck');
  });

  it('a connector next to (not on) an adjacent plate centre is rejected', () => {
    const c = centre(1, 0);
    expect(reject('connector', { x: c.x + 40, y: c.y }, deckOf('alice'))).toBe('off-deck');
  });

  it("another owner's plate is not your deck", () => {
    expect(reject('reactor', ringHex(4, 0, 3), deckOf('alice'))).toBe('off-deck');
    expect(reject('reactor', ringHex(4, 0, 3), deckOf('bob'))).toBeNull();
  });

  it('deck flag off (no deck context): no deck rule', () => {
    expect(reject('reactor', centre(9, -7), null)).toBeNull();
    expect(placementRejection('reactor', 12345, -6789, [])).toBeNull();
  });

  it('occupancy stays the overlap check: a structure on an occupied spot is overlap-structure', () => {
    const c = centre(0, 0);
    const fp = { x: c.x, y: c.y, radius: 40, kind: 'connector', rot: 0 };
    expect(placementRejection('connector', c.x, c.y, [fp], null, 0, false, deckOf('alice'))).toBe('overlap-structure');
  });

  it('OwnerPlateList (the renderer copy) answers exactly like the PlateSet', () => {
    const ps = plates();
    const list = new OwnerPlateList().set('alice', ps.platesInto('alice', []));
    const a: PlacementDeck = { plates: ps, owner: 'alice' };
    const b: PlacementDeck = { plates: list, owner: 'alice' };
    for (let x = -9000; x <= 9000; x += 431) {
      for (let y = -9000; y <= 9000; y += 517) {
        for (const kind of ['connector', 'reactor']) {
          expect(placementRejection(kind, x, y, [], null, 0, false, b)).toBe(placementRejection(kind, x, y, [], null, 0, false, a));
        }
      }
    }
    for (const [i, j] of [[1, 0], [2, 2], [5, 0], [0, 0]] as const) {
      const c = centre(i, j);
      expect(placementRejection('connector', c.x, c.y, [], null, 0, false, b)).toBe(placementRejection('connector', c.x, c.y, [], null, 0, false, a));
    }
    expect(list.plateAtWorld('bob', centre(4, 0).x, centre(4, 0).y)).toBe(false);
  });
});
