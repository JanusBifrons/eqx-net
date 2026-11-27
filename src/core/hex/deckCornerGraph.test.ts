import { describe, expect, it } from 'vitest';
import { DeckCornerGraph, deckCornerPathInto } from './deckCornerGraph.js';
import { isDeckSeam } from './deckCorners.js';
import { hexCornerInto, pixelToAxialInto, type AxialHex, type HexPoint } from './hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateCentreHexInto, plateOfHexInto, type PlateIndex } from './plates.js';

/** Corner `k` of plate (i, j)'s middle hex. */
function corner(i: number, j: number, k: number): HexPoint {
  const h: AxialHex = { q: 0, r: 0 };
  plateCentreHexInto(i, j, h);
  const c = deckHexCentreInto(h.q, h.r, { x: 0, y: 0 });
  return hexCornerInto(c.x, c.y, DECK_HEX_SIZE, k, { x: 0, y: 0 });
}

function onPlates(plates: number[], x: number, y: number): boolean {
  const h = pixelToAxialInto(x, y, DECK_HEX_SIZE, { q: 0, r: 0 });
  const p: PlateIndex = plateOfHexInto(h.q, h.r, { i: 0, j: 0 });
  for (let n = 0; n + 1 < plates.length; n += 2) if (plates[n] === p.i && plates[n + 1] === p.j) return true;
  return false;
}

/** Every step is one seam with deck on at least one side. */
function expectPlatedSeams(plates: number[], path: number[]): void {
  for (let n = 0; n + 3 < path.length; n += 2) {
    const ax = path[n]!, ay = path[n + 1]!, bx = path[n + 2]!, by = path[n + 3]!;
    expect(isDeckSeam(ax, ay, bx, by)).toBe(true);
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    // Nudge off the seam to each side along its normal.
    const nx = -(by - ay) / DECK_HEX_SIZE * 20, ny = (bx - ax) / DECK_HEX_SIZE * 20;
    expect(onPlates(plates, mx + nx, my + ny) || onPlates(plates, mx - nx, my - ny)).toBe(true);
  }
}

const SEVEN = [0, 0, 1, 0, 0, 1, -1, 1, -1, 0, 0, -1, 1, -1];

describe('DeckCornerGraph (fence run corner path)', () => {
  it('joins two adjacent corners with one edge', () => {
    const g = new DeckCornerGraph().build([0, 0]);
    const a = corner(0, 0, 0), b = corner(0, 0, 1);
    const out: number[] = [];
    expect(deckCornerPathInto(g, a.x, a.y, b.x, b.y, out)).toBe(true);
    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(a.x); expect(out[1]).toBeCloseTo(a.y);
    expect(out[2]).toBeCloseTo(b.x); expect(out[3]).toBeCloseTo(b.y);
  });

  it('fills the corner between two corners two edges apart', () => {
    const g = new DeckCornerGraph().build([0, 0]);
    const a = corner(0, 0, 0), mid = corner(0, 0, 1), b = corner(0, 0, 2);
    const out: number[] = [];
    expect(deckCornerPathInto(g, a.x, a.y, b.x, b.y, out)).toBe(true);
    expect(out.length).toBe(6);
    expect(out[2]).toBeCloseTo(mid.x); expect(out[3]).toBeCloseTo(mid.y);
    expectPlatedSeams([0, 0], out);
  });

  it('snaps near points to their corners', () => {
    const g = new DeckCornerGraph().build([0, 0]);
    const a = corner(0, 0, 0), b = corner(0, 0, 3);
    const out: number[] = [];
    expect(deckCornerPathInto(g, a.x + 3, a.y - 2, b.x - 1, b.y + 2, out)).toBe(true);
    expect(out[0]).toBeCloseTo(a.x);
    expect(out[out.length - 1]).toBeCloseTo(b.y);
    // Across the middle hex: three edges either way round it.
    expect(out.length / 2 - 1).toBe(3);
  });

  it('goes round a missing plate, on plated edges only', () => {
    const a = corner(1, 0, 0), b = corner(-1, 0, 3);
    const full: number[] = [];
    const ring: number[] = [];
    expect(deckCornerPathInto(new DeckCornerGraph().build(SEVEN), a.x, a.y, b.x, b.y, full)).toBe(true);
    const holed = SEVEN.slice(2); // the ring without the middle plate
    expect(deckCornerPathInto(new DeckCornerGraph().build(holed), a.x, a.y, b.x, b.y, ring)).toBe(true);
    expect(ring.length).toBeGreaterThanOrEqual(full.length);
    // The full deck's path crosses the middle plate; the ring's never does.
    expect(() => expectPlatedSeams(holed, full)).toThrow();
    expectPlatedSeams(SEVEN, full);
    expectPlatedSeams(holed, ring);
  });

  it('allows inner edges (both sides deck)', () => {
    const g = new DeckCornerGraph().build([0, 0]);
    // The middle hex's corners are all inner: every one is a node.
    for (let k = 0; k < 6; k++) {
      const c = corner(0, 0, k);
      expect(g.nodeAt(c.x, c.y)).toBeGreaterThanOrEqual(0);
    }
    expect(g.nodeCount).toBe(24); // 7 hexes: 6 + 6·3 shared … = 24 corners
  });

  it('refuses a corner off the plates or plates that do not touch', () => {
    const g = new DeckCornerGraph().build([0, 0, 3, 0]);
    const out: number[] = [];
    const off = corner(-3, 0, 0);
    const a = corner(0, 0, 0);
    expect(deckCornerPathInto(g, a.x, a.y, off.x, off.y, out)).toBe(false);
    const far = corner(3, 0, 0);
    expect(deckCornerPathInto(g, a.x, a.y, far.x, far.y, out)).toBe(false);
    expect(out.length).toBe(0);
  });
});
