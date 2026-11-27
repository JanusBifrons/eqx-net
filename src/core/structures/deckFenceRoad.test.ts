/**
 * Edge placement slice 3 — a fence across a road is allowed and blocks it
 * (owner). A fence post stands on a corner of a road hex, and the post-post
 * link on the seam between two road hexes (the road's own path) forms, with
 * the road tiles in the grid. Locks the rule the fence run relies on.
 */
import { describe, expect, it } from 'vitest';
import { canConnect, type GridNode } from './Grid.js';
import { placementRejection, type PlacementFootprint } from './placementRules.js';
import { DECK_LINK_SEAM_FENCE, deckLinkKind } from './deckLinks.js';
import { getStructureKind, structureHalfExtents } from '../../shared-types/structureKinds.js';
import { HEX_DIRS, hexCornerInto, type HexPoint } from '../hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../hex/plates.js';

function node(id: string, kind: string, x: number, y: number): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, 0);
  return {
    id, kind, x, y, rot: 0, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: false, isConnector: false, isShieldPylon: kind === 'shield_pylon',
    maxConnections: k.maxConnections, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}

function footprint(n: GridNode): PlacementFootprint {
  return { x: n.x, y: n.y, radius: n.radius, halfW: n.halfW, halfH: n.halfH, kind: n.kind, rot: 0 };
}

const ALL_DECK = { plates: { plateAtWorld: () => true, plateCount: () => 1 }, owner: 'me' };

describe('a fence across a road (edge placement slice 3)', () => {
  // Two road hexes side by side: (0, 0) and its neighbour across edge 0.
  const h0 = deckHexCentreInto(0, 0, { x: 0, y: 0 });
  const d = HEX_DIRS[0]!;
  const h1 = deckHexCentreInto(d.q, d.r, { x: 0, y: 0 });
  const road0 = node('r0', 'road', h0.x, h0.y);
  const road1 = node('r1', 'road', h1.x, h1.y);
  // The seam between them: corners 0 and 1 of hex (0, 0) (edge 0).
  const a: HexPoint = hexCornerInto(h0.x, h0.y, DECK_HEX_SIZE, 0, { x: 0, y: 0 });
  const b: HexPoint = hexCornerInto(h0.x, h0.y, DECK_HEX_SIZE, 1, { x: 0, y: 0 });

  it('a fence post may stand on a road hex corner', () => {
    const roads = [footprint(road0), footprint(road1)];
    expect(placementRejection('shield_pylon', a.x, a.y, roads, null, 0, false, ALL_DECK)).toBeNull();
    expect(placementRejection('shield_pylon', b.x, b.y, roads, null, 0, false, ALL_DECK)).toBeNull();
  });

  it('two posts link along the seam across the road', () => {
    const pa = node('a', 'shield_pylon', a.x, a.y);
    const pb = node('b', 'shield_pylon', b.x, b.y);
    expect(deckLinkKind(pa, pb)).toBe(DECK_LINK_SEAM_FENCE);
    const nodes = new Map([['a', pa], ['b', pb], ['r0', road0], ['r1', road1]]);
    expect(canConnect(pa, pb, new Map(), nodes, undefined, undefined, undefined, true)).toEqual({ ok: true });
  });
});
