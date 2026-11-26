/**
 * Base platforms — "Roads can't go through a connector". A road tile paves its
 * whole deck hex out to the seams, past its 800 × 692 footprint box, so a
 * connector anywhere in that hex would sit under the carriageway. The shared
 * rule (`placementRejection`, ghost and server) refuses a road on a hex a
 * connector reaches into, and a connector reaching into a road's hex.
 */
import { describe, expect, it } from 'vitest';
import { structureHalfExtents } from '../../shared-types/structureKinds.js';
import { rhombusCentroidInto } from '../hex/deckSnap.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../hex/plates.js';
import { connectorOnRoadHex } from './deckGateRoad.js';
import { placementRejection, type PlacementFootprint } from './placementRules.js';

const at = (q: number, r: number): { x: number; y: number } => deckHexCentreInto(q, r, { x: 0, y: 0 });
const foot = (kind: string, x: number, y: number, rot = 0): PlacementFootprint => {
  const e = structureHalfExtents(kind, rot);
  return { x, y, radius: Math.hypot(e.hw, e.hh), halfW: e.hw, halfH: e.hh, kind, rot };
};
/** A point inside hex (1, 0), toward its corner at `deg`, past the road box. */
const nearCorner = (deg: number): { x: number; y: number } => {
  const c = at(1, 0), a = (deg * Math.PI) / 180, d = DECK_HEX_SIZE * 0.75;
  return { x: c.x + Math.cos(a) * d, y: c.y + Math.sin(a) * d };
};

describe('roads and connectors never share a hex', () => {
  const road = at(1, 0);
  // Pointy-top deck hex: corners at 30° + 60°·k.
  const CORNERS = [30, 90, 150, 210, 270, 330];

  for (const rot of [30, 90, 150]) {
    it(`a connector cannot go in a road's hex (road turned ${rot}°)`, () => {
      const roads = [foot('road', road.x, road.y, rot)];
      for (let k = 0; k < 3; k++) {
        const p = rhombusCentroidInto(road.x, road.y, k, { x: 0, y: 0 });
        expect(placementRejection('connector', p.x, p.y, roads, null, 0)).toBe('overlap-structure');
      }
      for (const deg of CORNERS) {
        const p = nearCorner(deg);
        expect(placementRejection('connector', p.x, p.y, roads, null, 0), `corner ${deg}°`).toBe('overlap-structure');
      }
    });

    it(`a road cannot go on a hex holding a connector (turned ${rot}°)`, () => {
      for (const deg of CORNERS) {
        const p = nearCorner(deg);
        expect(placementRejection('road', road.x, road.y, [foot('connector', p.x, p.y)], null, rot), `corner ${deg}°`).toBe('overlap-structure');
      }
      const p = rhombusCentroidInto(road.x, road.y, 1, { x: 0, y: 0 });
      expect(placementRejection('road', road.x, road.y, [foot('connector', p.x, p.y)], null, rot)).toBe('overlap-structure');
    });
  }

  it('a connector on the next hex is fine, either order', () => {
    const next = at(2, 0);
    for (let k = 0; k < 3; k++) {
      const p = rhombusCentroidInto(next.x, next.y, k, { x: 0, y: 0 });
      expect(placementRejection('connector', p.x, p.y, [foot('road', road.x, road.y, 30)], null, 0)).toBeNull();
      expect(placementRejection('road', road.x, road.y, [foot('connector', p.x, p.y)], null, 30)).toBeNull();
    }
  });

  it('other buildings keep the footprint rule (no hex rule for them)', () => {
    const p = nearCorner(30);
    expect(placementRejection('battery', p.x, p.y, [foot('road', road.x, road.y, 30)], null, 0)).toBeNull();
  });

  it('connectorOnRoadHex: a box poking over the seam counts', () => {
    const half = structureHalfExtents('connector', 0);
    const c = at(1, 0), n = at(2, 0);
    // On the seam's far side, half a connector past it: its near corners reach in.
    const mx = (c.x + n.x) / 2, my = (c.y + n.y) / 2;
    const ux = (n.x - c.x) / Math.hypot(n.x - c.x, n.y - c.y), uy = (n.y - c.y) / Math.hypot(n.x - c.x, n.y - c.y);
    expect(connectorOnRoadHex(mx + ux * half.hw * 0.5, my + uy * half.hw * 0.5, half.hw, half.hh, c.x, c.y)).toBe(true);
    expect(connectorOnRoadHex(mx + ux * half.hw * 3, my + uy * half.hw * 3, half.hw, half.hh, c.x, c.y)).toBe(false);
  });
});
