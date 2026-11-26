/**
 * Base platforms slice 14 — the deck floor under every plate. Locks: one
 * Graphics per plate on the shared plate context (counted, not timed: the
 * phone is the perf target), add / remove only on a plate-set version change,
 * an unchanged frame builds nothing, and the floor sits in the under band.
 */
import { describe, expect, it } from 'vitest';
import { Container, Graphics } from 'pixi.js';
import type { DeckPlatesMirror } from '../../../core/contracts/IRenderer.js';
import { plateCentreWorldInto } from '../../../core/hex/plates.js';
import { DECK_UNDER_Z, StructureDeckPlates, deckPlateContext } from './structureDeckPlates.js';
import { RIG_UNDER_Z } from './structureRigs.js';

function mirrorOf(version: number, plates: Array<[number, number]>): DeckPlatesMirror {
  const ij = new Int32Array(Math.max(2, plates.length * 2));
  plates.forEach(([i, j], n) => { ij[2 * n] = i; ij[2 * n + 1] = j; });
  return { version, count: plates.length, ij };
}

function plateGraphics(c: Container): Graphics[] {
  return c.children.filter((ch): ch is Graphics => ch instanceof Graphics && ch.label === 'deckPlate');
}

describe('StructureDeckPlates — the deck floor', () => {
  it('one Graphics per plate, on the one shared context, at its plate centre', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'plain');
    deck.sync(mirrorOf(1, [[0, 0], [1, 0], [0, 1]]));
    const gs = plateGraphics(ship);
    expect(gs.length).toBe(3);
    expect(deck.size).toBe(3);
    expect(ship.children.length).toBe(3); // nothing but the plates: one draw object each
    for (const g of gs) {
      expect(g.context).toBe(deckPlateContext());
      expect(g.children.length).toBe(0);
    }
    const c = plateCentreWorldInto(1, 0, { x: 0, y: 0 });
    expect(gs.some((g) => Math.abs(g.x - c.x) < 1e-6 && Math.abs(g.y + c.y) < 1e-6)).toBe(true); // Y-flip
  });

  it('sits at the bottom of the structure under band', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship);
    deck.sync(mirrorOf(1, [[2, -1]]));
    const g = plateGraphics(ship)[0]!;
    expect(g.zIndex).toBe(DECK_UNDER_Z);
    expect(DECK_UNDER_Z).toBeLessThan(RIG_UNDER_Z);
    expect(DECK_UNDER_Z).toBeGreaterThan(RIG_UNDER_Z - 1);
  });

  it('adds a plate on add, removes it on remove, keeps the rest', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship, 'plain');
    deck.sync(mirrorOf(1, [[0, 0]]));
    const first = plateGraphics(ship)[0]!;
    deck.sync(mirrorOf(2, [[0, 0], [1, 1]]));
    expect(deck.size).toBe(2);
    expect(plateGraphics(ship)).toContain(first); // the kept plate is not rebuilt
    deck.sync(mirrorOf(3, [[1, 1]]));
    expect(deck.size).toBe(1);
    expect(plateGraphics(ship)).not.toContain(first);
    expect(first.destroyed).toBe(true);
    expect(deckPlateContext().destroyed).toBe(false); // the shared context survives
    deck.sync(mirrorOf(4, [])); // deck flag off ⇒ count 0
    expect(ship.children.length).toBe(0);
    deck.sync(undefined);
    expect(ship.children.length).toBe(0);
  });

  it('an unchanged version builds nothing and touches no plate', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship);
    const m = mirrorOf(7, [[0, 0], [1, 0]]);
    deck.sync(m);
    const before = plateGraphics(ship);
    let added = 0, removed = 0;
    ship.on('childAdded', () => { added++; });
    ship.on('childRemoved', () => { removed++; });
    // A worker gets a fresh clone each frame: same version, new object.
    for (let f = 0; f < 50; f++) deck.sync(f % 2 === 0 ? m : mirrorOf(7, [[0, 0], [1, 0]]));
    expect(added).toBe(0);
    expect(removed).toBe(0);
    expect(plateGraphics(ship)).toEqual(before);
  });

  it('the same plate held by two owners draws once', () => {
    const ship = new Container();
    const deck = new StructureDeckPlates(ship);
    deck.sync(mirrorOf(1, [[0, 0], [0, 0]]));
    expect(deck.size).toBe(1);
  });
});
