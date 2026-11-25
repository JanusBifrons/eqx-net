/**
 * Base platforms slice 19 — the plain fence tile: on a deck a shield pylon
 * snaps to the nearest hex corner, and two pylons on the two ends of ONE hex
 * edge (a seam) link past `CONNECTION_MAX_RANGE` (`DECK_LINK_SEAM_FENCE`), so
 * the shield wall runs along the seam. Deck pylons pair only along seams
 * (`'off-seam'`); off-deck pylons keep the normal range rule.
 */
import { describe, it, expect } from 'vitest';
import { canConnect, type GridNode } from './Grid.js';
import type { Connection } from './Connection.js';
import { DECK_LINK_NONE, DECK_LINK_SEAM_FENCE, deckLinkKind } from './deckLinks.js';
import { snapPlacementToDeck } from './deckPlacement.js';
import { hexCornerInto, type HexPoint } from '../hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../hex/plates.js';
import { isDeckSeam, isOnDeckCorner, nearestDeckCornerInto } from '../hex/deckCorners.js';
import { deckSlotOutline, type DeckSnap } from '../hex/deckSnap.js';
import { getStructureKind, structureHalfExtents } from '../../shared-types/structureKinds.js';

function pylon(id: string, x: number, y: number): GridNode {
  const k = getStructureKind('shield_pylon');
  const { hw, hh } = structureHalfExtents('shield_pylon', 0);
  return {
    id, kind: 'shield_pylon', x, y, rot: 0, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: false, isConnector: false, isShieldPylon: true,
    maxConnections: k.maxConnections, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}

/** Corner `i` of deck hex (q, r). */
function corner(q: number, r: number, i: number): HexPoint {
  const c = deckHexCentreInto(q, r, { x: 0, y: 0 });
  return hexCornerInto(c.x, c.y, DECK_HEX_SIZE, i, { x: 0, y: 0 });
}

const NONE = new Map<string, Connection[]>();
function link(a: HexPoint, b: HexPoint, deck: boolean) {
  const na = pylon('a', a.x, a.y), nb = pylon('b', b.x, b.y);
  return canConnect(na, nb, NONE, new Map([['a', na], ['b', nb]]), undefined, undefined, undefined, deck);
}
const snap = (): DeckSnap => ({ x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'hex' });

describe('deck fence: a shield pylon snaps to the nearest hex corner', () => {
  it('a point near a corner snaps exactly onto it, and the snap is idempotent', () => {
    const c = corner(2, -1, 4);
    const out = snapPlacementToDeck('shield_pylon', c.x + 90, c.y - 60, snap());
    expect(out.slot).toBe('corner');
    expect(out.x).toBeCloseTo(c.x, 6);
    expect(out.y).toBeCloseTo(c.y, 6);
    const again = snapPlacementToDeck('shield_pylon', out.x, out.y, snap());
    expect(again.x).toBeCloseTo(c.x, 6);
    expect(again.y).toBeCloseTo(c.y, 6);
  });

  it('every corner of a hex is reachable: a point just inside it snaps to it', () => {
    const centre = deckHexCentreInto(0, 0, { x: 0, y: 0 });
    for (let i = 0; i < 6; i++) {
      const c = corner(0, 0, i);
      const p = nearestDeckCornerInto(centre.x + (c.x - centre.x) * 0.8, centre.y + (c.y - centre.y) * 0.8, { x: 0, y: 0 });
      expect(Math.hypot(p.x - c.x, p.y - c.y)).toBeLessThan(1e-6);
      expect(isOnDeckCorner(c.x, c.y)).toBe(true);
    }
    expect(isOnDeckCorner(centre.x, centre.y)).toBe(false);
  });

  it('other kinds keep their own slot; the corner slot has a ghost outline', () => {
    expect(snapPlacementToDeck('solar', 10, 10, snap()).slot).toBe('hex');
    expect(deckSlotOutline('corner')).toHaveLength(1);
  });
});

describe('deck fence: pylons pair along hex seams', () => {
  it('the two ends of one hex edge are a seam', () => {
    const a = corner(0, 0, 0), b = corner(0, 0, 1);
    expect(isDeckSeam(a.x, a.y, b.x, b.y)).toBe(true);
    expect(deckLinkKind(pylon('a', a.x, a.y), pylon('b', b.x, b.y))).toBe(DECK_LINK_SEAM_FENCE);
    expect(link(a, b, true)).toEqual({ ok: true });
  });

  it('every edge of a neighbouring hex is a seam too (shared corners)', () => {
    for (let i = 0; i < 6; i++) expect(link(corner(1, 0, i), corner(1, 0, (i + 1) % 6), true).ok).toBe(true);
  });

  it('opposite corners and the short diagonal of a hex do NOT pair on a deck', () => {
    expect(link(corner(0, 0, 0), corner(0, 0, 3), true)).toEqual({ ok: false, reason: 'off-seam' });
    expect(link(corner(0, 0, 0), corner(0, 0, 2), true)).toEqual({ ok: false, reason: 'off-seam' });
  });

  it('on a deck, close pylons off the corners do not pair by range', () => {
    const c = deckHexCentreInto(0, 0, { x: 0, y: 0 });
    const a = { x: c.x, y: c.y }, b = { x: c.x + 200, y: c.y };
    expect(link(a, b, false)).toEqual({ ok: true });
    expect(link(a, b, true)).toEqual({ ok: false, reason: 'off-seam' });
    expect(deckLinkKind(pylon('a', a.x, a.y), pylon('b', b.x, b.y))).toBe(DECK_LINK_NONE);
  });

  it('off a deck there is no seam rule: the normal range rule decides', () => {
    expect(link(corner(0, 0, 0), corner(0, 0, 1), false)).toEqual({ ok: true });
    expect(link(corner(0, 0, 0), corner(0, 0, 3), false)).toEqual({ ok: false, reason: 'out-of-range' });
  });

  it('a seam pair links past the normal link range', () => {
    // The deck rule ignores range entirely (Infinity); seams are what limit it.
    const a = corner(0, 0, 0), b = corner(0, 0, 1);
    const na = pylon('a', a.x, a.y), nb = pylon('b', b.x, b.y);
    na.connectionRange = 1; nb.connectionRange = 1; // a tiny per-kind range
    const nodes = new Map([['a', na], ['b', nb]]);
    expect(canConnect(na, nb, NONE, nodes, undefined, undefined, undefined, false)).toEqual({ ok: false, reason: 'out-of-range' });
    expect(canConnect(na, nb, NONE, nodes, undefined, undefined, undefined, true)).toEqual({ ok: true });
  });
});
