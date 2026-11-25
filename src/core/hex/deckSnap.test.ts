import { describe, it, expect } from 'vitest';
import { snapToDeckSlot, rhombusOf, rhombusCentroidInto, deckSlotOutline, type DeckSlot, type DeckSnap } from './deckSnap.js';
import { pixelToAxial, hexCornerInto, type HexPoint } from './hex.js';
import { DECK_HEX_SIZE, DECK_HEX_FLAT, deckHexCentreInto, plateOfHex } from './plates.js';

const snap = (): DeckSnap => ({ x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 });
const SLOTS: DeckSlot[] = ['small', 'hex', 'plate'];

/** A deterministic spread of sample points over several plates. */
function samples(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = 12345;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < 400; i++) out.push([(rnd() - 0.5) * 12000, (rnd() - 0.5) * 12000]);
  return out;
}

/** Point-in-convex-polygon (either winding). */
function inside(px: number, py: number, poly: number[]): boolean {
  let sign = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = poly[2 * i]!, ay = poly[2 * i + 1]!;
    const bx = poly[(2 * i + 2) % poly.length]!, by = poly[(2 * i + 3) % poly.length]!;
    const c = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (Math.abs(c) < 1e-6) continue;
    const sg = Math.sign(c);
    if (sign === 0) sign = sg; else if (sg !== sign) return false;
  }
  return true;
}

describe('snapToDeckSlot', () => {
  it('hex: snaps to the centre of the hex containing the point', () => {
    const c: HexPoint = { x: 0, y: 0 };
    for (const [x, y] of samples()) {
      const o = snapToDeckSlot('hex', x, y, snap());
      const h = pixelToAxial(x, y, DECK_HEX_SIZE);
      deckHexCentreInto(h.q, h.r, c);
      expect([o.q, o.r]).toEqual([h.q, h.r]);
      expect(o.x).toBeCloseTo(c.x, 6);
      expect(o.y).toBeCloseTo(c.y, 6);
      expect(o.rhombus).toBe(-1);
      expect(Math.hypot(x - o.x, y - o.y)).toBeLessThanOrEqual(DECK_HEX_SIZE + 1e-6);
    }
  });

  it('small: snaps to the centroid of the rhombus containing the point, inside that rhombus', () => {
    for (const [x, y] of samples()) {
      const o = snapToDeckSlot('small', x, y, snap());
      expect(o.rhombus).toBeGreaterThanOrEqual(0);
      expect(o.rhombus).toBeLessThanOrEqual(2);
      // The rhombus outline (relative to the centroid) holds both the point and the centroid.
      const poly = deckSlotOutline('small', o.rhombus)[0]!;
      expect(inside(x - o.x, y - o.y, poly)).toBe(true);
      expect(inside(0, 0, poly)).toBe(true);
      // Same hex as the point.
      const h = pixelToAxial(x, y, DECK_HEX_SIZE);
      expect([o.q, o.r]).toEqual([h.q, h.r]);
    }
  });

  it('plate: snaps to the world centre of the plate middle hex', () => {
    const c: HexPoint = { x: 0, y: 0 };
    for (const [x, y] of samples()) {
      const o = snapToDeckSlot('plate', x, y, snap());
      const { centre } = plateOfHex(pixelToAxial(x, y, DECK_HEX_SIZE));
      deckHexCentreInto(centre.q, centre.r, c);
      expect([o.q, o.r]).toEqual([centre.q, centre.r]);
      expect(o.x).toBeCloseTo(c.x, 6);
      expect(o.y).toBeCloseTo(c.y, 6);
      // Within the 7-hex leaf: at most one hex step + a circumradius away.
      expect(Math.hypot(x - o.x, y - o.y)).toBeLessThanOrEqual(DECK_HEX_FLAT + DECK_HEX_SIZE + 1e-6);
    }
  });

  it('snapping a snapped point is a no-op (every slot)', () => {
    for (const slot of SLOTS) {
      for (const [x, y] of samples()) {
        const a = snapToDeckSlot(slot, x, y, snap());
        const b = snapToDeckSlot(slot, a.x, a.y, snap());
        expect(b).toEqual(a);
      }
    }
  });

  it('allocates nothing: writes into and returns `out`', () => {
    const o = snap();
    expect(snapToDeckSlot('small', 100, 200, o)).toBe(o);
  });
});

describe('rhombi of a hex', () => {
  it('the three centroids are distinct, inside the hex, and each in its own rhombus', () => {
    const hex: number[] = [];
    const p: HexPoint = { x: 0, y: 0 };
    for (let i = 0; i < 6; i++) { hexCornerInto(0, 0, DECK_HEX_SIZE, i, p); hex.push(p.x, p.y); }
    const cs: HexPoint[] = [0, 1, 2].map((k) => rhombusCentroidInto(0, 0, k, { x: 0, y: 0 }));
    for (let k = 0; k < 3; k++) {
      const c = cs[k]!;
      expect(inside(c.x, c.y, hex)).toBe(true);
      expect(rhombusOf(c.x, c.y)).toBe(k);
      expect(Math.hypot(c.x, c.y)).toBeCloseTo(DECK_HEX_SIZE / 2, 6);
      for (let j = k + 1; j < 3; j++) expect(Math.hypot(c.x - cs[j]!.x, c.y - cs[j]!.y)).toBeGreaterThan(DECK_HEX_SIZE / 2);
    }
  });

  it('the separators run to corners 0, 2, 4 (30°, 150°, 270°)', () => {
    const p: HexPoint = { x: 0, y: 0 };
    // Just either side of corner 0's spoke the rhombus changes; across corner 1's it does not.
    hexCornerInto(0, 0, DECK_HEX_SIZE, 0, p);
    const ang = Math.atan2(p.y, p.x);
    const at = (a: number) => rhombusOf(Math.cos(a) * 300, Math.sin(a) * 300);
    expect(at(ang + 0.01)).not.toBe(at(ang - 0.01));
    hexCornerInto(0, 0, DECK_HEX_SIZE, 1, p);
    const ang1 = Math.atan2(p.y, p.x);
    expect(at(ang1 + 0.01)).toBe(at(ang1 - 0.01));
  });

  it('outlines: one hex, one 4-corner rhombus, seven plate hexes', () => {
    expect(deckSlotOutline('hex')).toHaveLength(1);
    expect(deckSlotOutline('hex')[0]).toHaveLength(12);
    expect(deckSlotOutline('small', 1)[0]).toHaveLength(8);
    expect(deckSlotOutline('plate')).toHaveLength(7);
  });
});
