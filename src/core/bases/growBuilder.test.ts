/** The base generator's builder stores each link's cable sockets and keeps
 *  placements off the curved cable (structure-restyle 0d slice 5). */
import { describe, expect, it } from 'vitest';
import { Builder } from './growBuilder.js';
import { canConnect, segmentIntersectsAabb } from '../structures/Grid.js';
import {
  CABLE_CURVE_FLOATS, CABLE_CURVE_SEGMENTS, CABLE_NO_SOCKET, flattenLinkCable, makeCableBox, makeCableSocketPick,
} from '../structures/cableCurve.js';
import { structureHalfExtents } from '../../shared-types/structureKinds.js';

describe('Builder links (0d slice 5)', () => {
  it('stores the socket pair canConnect picked, on the edge and on the Connection', () => {
    const B = new Builder();
    const hub = B.tryPlace({ kind: 'connector', x: 0, y: 0 });
    const sol = B.tryPlace({ kind: 'solar', x: 200, y: 500 });
    const pick = makeCableSocketPick();
    expect(canConnect(B.nodes.get(`s${sol}`)!, B.nodes.get(`s${hub}`)!, B.adj, B.nodes, undefined, pick).ok).toBe(true);
    expect(B.tryLink(sol, hub)).toBe(true);
    expect(B.edgeSockets[0]).toEqual([pick.a, pick.b]);
    const c = B.adj.get(`s${sol}`)![0]!;
    expect([c.socketAt(`s${sol}`), c.socketAt(`s${hub}`)]).toEqual([pick.a, pick.b]);
    expect(pick.a).toBeGreaterThanOrEqual(0);
  });

  it('a fence link stores CABLE_NO_SOCKET', () => {
    const B = new Builder();
    const p1 = B.tryPlace({ kind: 'shield_pylon', x: 0, y: 0 });
    const p2 = B.tryPlace({ kind: 'shield_pylon', x: 300, y: 0 });
    expect(B.tryLink(p1, p2)).toBe(true);
    expect(B.edgeSockets[0]).toEqual([CABLE_NO_SOCKET, CABLE_NO_SOCKET]);
  });

  it('refuses a placement on the curved cable even off the straight centre line', () => {
    const B = new Builder();
    const hub = B.tryPlace({ kind: 'connector', x: 0, y: 0 });
    // (Off to the side, so the solar's bottom-edge socket bends the cable well
    // clear of the straight line; it has no corner sockets to angle from.)
    const sol = B.tryPlace({ kind: 'solar', x: 600, y: 450 });
    expect(B.tryLink(sol, hub)).toBe(true);
    const [sa, sb] = B.edgeSockets[0]!;
    const poly = new Float64Array(CABLE_CURVE_FLOATS);
    flattenLinkCable(B.nodes.get(`s${sol}`)!, sa, B.nodes.get(`s${hub}`)!, sb, poly, makeCableBox());
    const { hw, hh } = structureHalfExtents('connector', 0);
    // The curve point farthest from the straight centre line.
    let best = -1, bx = 0, by = 0;
    for (let i = 1; i < CABLE_CURVE_SEGMENTS; i++) {
      const x = poly[i * 2]!, y = poly[i * 2 + 1]!;
      const d = Math.abs(450 * x - 600 * y) / Math.hypot(600, 450);
      if (d > best) { best = d; bx = x; by = y; }
    }
    expect(segmentIntersectsAabb(0, 0, 600, 450, bx - hw, by - hh, bx + hw, by + hh), 'clear of the straight line').toBe(false);
    // Without the link the same spot is free, so the cable is what refuses it.
    const free = new Builder();
    free.tryPlace({ kind: 'connector', x: 0, y: 0 });
    free.tryPlace({ kind: 'solar', x: 600, y: 450 });
    expect(free.tryPlace({ kind: 'connector', x: bx, y: by })).toBeGreaterThanOrEqual(0);
    expect(B.tryPlace({ kind: 'connector', x: bx, y: by })).toBe(-1);
  });
});
