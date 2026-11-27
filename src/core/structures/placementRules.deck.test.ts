/**
 * Base platforms — the `off-deck` placement rule (`placementRejection`'s deck
 * context). On a deck room a player's structure must stand on one of their
 * own plates; a connector (the Deck plate) may also lay a NEW plate on the
 * centre of any clear plate, in open space too. No deck context = no deck rule.
 */
import { describe, it, expect } from 'vitest';
import { placementRejection, type PlacementDeck } from './placementRules.js';
import { OwnerPlateList, PlateSet } from '../hex/plateSet.js';
import { deckHexCentreInto, plateCentreHex, plateCentreWorldInto, plateHexes } from '../hex/plates.js';
import { HEX_DIRS } from '../hex/hex.js';
import type { GridObstacle } from './Grid.js';

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

  it('a connector lays a new plate on ANY plate centre: open space starts a new deck', () => {
    for (const [i, j] of [[9, -7], [2, 2], [-6, 3], [5, 0]] as const) {
      expect(reject('connector', centre(i, j), deckOf('alice')), 'alice ' + i + ',' + j).toBeNull();
      expect(reject('connector', centre(i, j), deckOf('nobody')), 'nobody ' + i + ',' + j).toBeNull();
    }
    // Still only a connector, and only on a plate centre.
    const c = centre(9, -7);
    expect(reject('reactor', c, deckOf('nobody'))).toBe('off-deck');
    expect(reject('connector', { x: c.x + 40, y: c.y }, deckOf('nobody'))).toBe('off-deck');
    // The renderer copy agrees.
    const list: PlacementDeck = { plates: new OwnerPlateList(), owner: 'nobody' };
    expect(reject('connector', c, list)).toBeNull();
    expect(reject('reactor', c, list)).toBe('off-deck');
  });

  it("another owner's laid plate is taken: its anchor stands on the centre", () => {
    const b = centre(4, 0);
    const anchor = { x: b.x, y: b.y, radius: 40, halfW: 40, halfH: 40 };
    expect(placementRejection('connector', b.x, b.y, [anchor], null, 0, false, deckOf('alice'))).toBe('overlap-structure');
  });

  it('a new plate in open space still needs clear space', () => {
    const c = centre(9, -7);
    const rock = { x: ringHex(9, -7, 3).x, y: ringHex(9, -7, 3).y, radius: 100 };
    expect(placementRejection('connector', c.x, c.y, [], [rock], 0, false, deckOf('nobody'))).toBe('plate-blocked');
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

describe('placementRejection — laying a plate needs clear space (plate-blocked)', () => {
  const c = centre(1, 0); // borders alice's (0,0)
  const rock = (p: { x: number; y: number }, radius = 100, parts?: GridObstacle['parts']): GridObstacle => ({ x: p.x, y: p.y, radius, parts });
  /** A hex two steps out from plate (1,0)'s centre: off the plate. */
  const outside = (dir: number): { x: number; y: number } => {
    const h = plateCentreHex(1, 0), d = HEX_DIRS[dir]!;
    return deckHexCentreInto(h.q + 2 * d.q, h.r + 2 * d.r, { x: 0, y: 0 });
  };
  const lay = (obstacles: GridObstacle[], structures: Parameters<typeof placementRejection>[3] = []) =>
    placementRejection('connector', c.x, c.y, structures, obstacles, 0, false, deckOf('alice'));

  it('a clear plate is laid', () => {
    expect(lay([])).toBeNull();
  });

  it('a rock in any of the 6 ring hexes blocks it', () => {
    for (let k = 1; k <= 6; k++) expect(lay([rock(ringHex(1, 0, k))]), 'ring ' + k).toBe('plate-blocked');
  });

  it('a rock on the connector itself is still overlap-obstacle', () => {
    expect(lay([rock(c)])).toBe('overlap-obstacle');
  });

  it('a rock off the plate does not block it', () => {
    for (let d = 0; d < 6; d++) expect(lay([rock(outside(d))]), 'dir ' + d).toBeNull();
  });

  it('a big rock reaching over the plate edge blocks it; its parts decide', () => {
    const p = outside(0);
    expect(lay([rock(p, 900)])).toBe('plate-blocked');
    // Same bounding circle, but the body is a small triangle round its centre.
    const small = [[{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 0, y: 100 }]];
    expect(lay([rock(p, 900, small)])).toBeNull();
    // A part reaching back toward the plate centre blocks again.
    const dx = c.x - p.x, dy = c.y - p.y, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    const reach = [[{ x: -uy * 100, y: ux * 100 }, { x: ux * 880, y: uy * 880 }, { x: uy * 100, y: -ux * 100 }]];
    expect(lay([rock(p, 900, reach)])).toBe('plate-blocked');
  });

  it("another owner's structure on the plate blocks it", () => {
    const p = ringHex(1, 0, 3);
    expect(lay([], [{ x: p.x, y: p.y, radius: 40, halfW: 40, halfH: 40 }])).toBe('plate-blocked');
    const q = outside(3);
    expect(lay([], [{ x: q.x, y: q.y, radius: 40, halfW: 40, halfH: 40 }])).toBeNull();
  });

  it('the clear-space rule only applies to a NEW plate (not building on your own deck)', () => {
    const p = ringHex(0, 0, 2);
    expect(placementRejection('reactor', p.x, p.y, [], [rock(ringHex(0, 0, 5))], 0, false, deckOf('alice'))).toBeNull();
  });
});
