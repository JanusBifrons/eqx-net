import { describe, it, expect } from 'vitest';
import { hexDistance } from './hex.js';
import {
  DECK_HEX_FLAT,
  DECK_HEX_SIZE,
  PLATE_DIRS,
  deckHexCentreInto,
  plateCentreHex,
  plateCentreWorldInto,
  plateHexes,
  plateNeighbours,
  plateOfHex,
  plateOfHexInto,
} from './plates.js';

describe('deck constants', () => {
  it('1300 u flat-to-flat, circumradius 1300/√3', () => {
    expect(DECK_HEX_FLAT).toBe(1300);
    expect(DECK_HEX_SIZE).toBeCloseTo(750.555, 2);
  });
});

describe('plate lattice', () => {
  it('centre hexes follow i·(2,1) + j·(−1,3)', () => {
    expect(plateCentreHex(0, 0)).toEqual({ q: 0, r: 0 });
    expect(plateCentreHex(1, 0)).toEqual({ q: 2, r: 1 });
    expect(plateCentreHex(0, 1)).toEqual({ q: -1, r: 3 });
    expect(plateCentreHex(-2, 3)).toEqual({ q: -7, r: 7 });
  });

  it('a plate is its centre hex + the 6 neighbours, and each maps back to the plate', () => {
    for (let i = -3; i <= 3; i++) {
      for (let j = -3; j <= 3; j++) {
        const hexes = plateHexes(i, j);
        const c = plateCentreHex(i, j);
        expect(hexes).toHaveLength(7);
        expect(hexes[0]).toEqual(c);
        for (const h of hexes) {
          expect(hexDistance(c.q, c.r, h.q, h.r)).toBeLessThanOrEqual(1);
          const got = plateOfHex(h);
          expect(got.plate).toEqual({ i, j });
          expect(got.centre).toEqual(c);
        }
      }
    }
  });

  it('every hex in a range maps to exactly one plate, plates cover it without overlap', () => {
    const R = 20;
    const owner = new Map<string, string>();
    // Plates whose centres could reach the range.
    for (let i = -15; i <= 15; i++) {
      for (let j = -15; j <= 15; j++) {
        for (const h of plateHexes(i, j)) {
          const k = `${h.q},${h.r}`;
          expect(owner.has(k), `hex ${k} in two plates`).toBe(false);
          owner.set(k, `${i},${j}`);
        }
      }
    }
    const p = { i: 0, j: 0 };
    const c = { q: 0, r: 0 };
    for (let q = -R; q <= R; q++) {
      for (let r = -R; r <= R; r++) {
        const k = `${q},${r}`;
        expect(owner.get(k), `hex ${k} uncovered`).toBeDefined();
        plateOfHexInto(q, r, p, c);
        expect(Number.isInteger(p.i) && Number.isInteger(p.j)).toBe(true);
        expect(`${p.i},${p.j}`).toBe(owner.get(k));
        expect(hexDistance(c.q, c.r, q, r)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('never yields -0 for plate indices', () => {
    const p = plateOfHexInto(0, -1, { i: 0, j: 0 });
    expect(Object.is(p.i, -0) || Object.is(p.j, -0)).toBe(false);
  });

  it('the 6 neighbouring plates sit 3 hex steps away and ~3440 u apart at 1300', () => {
    const ns = plateNeighbours(2, -1);
    expect(ns).toHaveLength(6);
    expect(new Set(ns.map((n) => `${n.i},${n.j}`)).size).toBe(6);
    const c = plateCentreHex(2, -1);
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    plateCentreWorldInto(2, -1, a);
    for (const n of ns) {
      const nc = plateCentreHex(n.i, n.j);
      expect(hexDistance(c.q, c.r, nc.q, nc.r)).toBe(3);
      plateCentreWorldInto(n.i, n.j, b);
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      expect(d).toBeCloseTo(DECK_HEX_FLAT * Math.sqrt(7), 6);
      expect(Math.abs(d - 3440)).toBeLessThan(1);
    }
    expect(PLATE_DIRS).toHaveLength(6);
  });

  it('neighbouring plates share an edge (some hex of each is adjacent)', () => {
    for (const d of PLATE_DIRS) {
      const mine = plateHexes(0, 0);
      const theirs = plateHexes(d.i, d.j);
      const touching = mine.some((m) => theirs.some((t) => hexDistance(m.q, m.r, t.q, t.r) === 1));
      expect(touching).toBe(true);
    }
  });

  it('deck hex centre and plate centre agree', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    const c = plateCentreHex(-1, 2);
    deckHexCentreInto(c.q, c.r, a);
    plateCentreWorldInto(-1, 2, b);
    expect(a).toEqual(b);
  });
});
