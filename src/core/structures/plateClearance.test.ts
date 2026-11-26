import { describe, it, expect } from 'vitest';
import { hexOverlapsObstacle, plateOverlapsObstacle, plateReachBoxAdd } from './plateClearance.js';
import { DECK_HEX_FLAT, DECK_HEX_SIZE, PLATE_REACH, deckHexCentreInto, plateCentreWorldInto, plateHexes } from '../hex/plates.js';

describe('plateClearance', () => {
  it('a hex vs a circle: across a flat side it touches at apothem + radius', () => {
    const r = 100, a = DECK_HEX_FLAT / 2;
    expect(hexOverlapsObstacle(0, 0, { x: a + r - 1, y: 0, radius: r })).toBe(true);
    expect(hexOverlapsObstacle(0, 0, { x: a + r + 1, y: 0, radius: r })).toBe(false);
    // Past the top corner (pointy-top: corner at y = size).
    expect(hexOverlapsObstacle(0, 0, { x: 0, y: DECK_HEX_SIZE + r - 1, radius: r })).toBe(true);
    expect(hexOverlapsObstacle(0, 0, { x: 0, y: DECK_HEX_SIZE + r + 60, radius: r })).toBe(false);
  });

  it('a plate: a rock at any of its 7 hex centres touches it; one far off does not', () => {
    for (const h of plateHexes(2, -1)) {
      const p = deckHexCentreInto(h.q, h.r, { x: 0, y: 0 });
      expect(plateOverlapsObstacle(2, -1, { x: p.x, y: p.y, radius: 10 })).toBe(true);
    }
    const c = plateCentreWorldInto(2, -1, { x: 0, y: 0 });
    expect(plateOverlapsObstacle(2, -1, { x: c.x + PLATE_REACH + 50, y: c.y, radius: 40 })).toBe(false);
  });

  it('plateReachBoxAdd grows a box to cover the plate', () => {
    const box = { x0: 10, y0: 10, x1: 20, y1: 20 };
    plateReachBoxAdd(15, 15, box);
    expect(box).toEqual({ x0: 15 - PLATE_REACH, y0: 15 - PLATE_REACH, x1: 15 + PLATE_REACH, y1: 15 + PLATE_REACH });
  });
});
