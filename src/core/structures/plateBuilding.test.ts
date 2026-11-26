/**
 * Base platforms slice 22 — plate buildings. A Large Teleporter on a plate
 * centre builds the plate's connector in: it IS a connector-kind
 * (`isConnectorKind`, the one predicate), so it anchors the plate, seam-links
 * to neighbouring plate anchors and links the buildings on its plate past its
 * own `maxConnections: 1` (deck links never count). The Ancients' gate (also
 * a plate-slot kind) never joins a network and anchors nothing.
 */
import { describe, it, expect } from 'vitest';
import { canConnect, type GridNode } from './Grid.js';
import { Connection } from './Connection.js';
import { snapPlacementToDeck } from './deckPlacement.js';
import { placementRejection, type PlacementDeck } from './placementRules.js';
import { DECK_LINK_NEIGHBOUR, DECK_LINK_ON_PLATE, deckCapLinkCount, deckLinkKind } from './deckLinks.js';
import { CONNECTION_MAX_RANGE } from './structureGridConstants.js';
import { PlateSet, isPlateAnchor } from '../hex/plateSet.js';
import type { DeckSnap } from '../hex/deckSnap.js';
import { DECK_HEX_SIZE, deckHexCentreInto, plateCentreWorldInto, plateHexes } from '../hex/plates.js';
import { getStructureKind, isConnectorKind, structureHalfExtents } from '../../shared-types/structureKinds.js';
import { PAD_SPECS } from '../../shared-types/teleport.js';

const TP = 'teleporter_large';
const centre = (i: number, j: number): { x: number; y: number } => plateCentreWorldInto(i, j, { x: 0, y: 0 });
const ringHex = (i: number, j: number, k: number): { x: number; y: number } => {
  const h = plateHexes(i, j)[k]!;
  return deckHexCentreInto(h.q, h.r, { x: 0, y: 0 });
};

function node(id: string, kind: string, x: number, y: number): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, 0);
  return {
    id, kind, x, y, rot: 0, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: isConnectorKind(kind), isShieldPylon: false,
    maxConnections: k.maxConnections, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}
const map = (...ns: GridNode[]): Map<string, GridNode> => new Map(ns.map((n) => [n.id, n]));

describe('plate buildings: the Large Teleporter builds the connector in (slice 22)', () => {
  it('the one connector predicate covers the Large Teleporter, not the Ancients\' gate', () => {
    expect(isConnectorKind('connector')).toBe(true);
    expect(isConnectorKind(TP)).toBe(true);
    expect(isConnectorKind('alien_gate')).toBe(false);
    expect(isConnectorKind('teleporter')).toBe(false);
    expect(getStructureKind(TP).deckSlot).toBe('plate');
    expect(getStructureKind('alien_gate').deckSlot).toBe('plate');
  });

  it('a Large Teleporter on a plate centre makes the plate; an alien gate there does not', () => {
    const ps = new PlateSet<string>();
    const c = centre(-1, 0);
    ps.upsert('tp', 'alice', TP, c.x, c.y);
    expect(ps.hasPlate('alice', -1, 0)).toBe(true);
    expect(isPlateAnchor(TP, c.x, c.y)).toBe(true);
    ps.upsert('gate', 'bob', 'alien_gate', c.x, c.y);
    expect(ps.plateCount('bob')).toBe(0);
    expect(isPlateAnchor('alien_gate', c.x, c.y)).toBe(false);
    ps.remove('tp');
    expect(ps.hasPlate('alice', -1, 0)).toBe(false);
  });

  it('the player snap puts it on the plate centre', () => {
    for (const [i, j] of [[0, 0], [-1, 0], [2, -3]] as const) {
      const c = centre(i, j);
      for (const [dx, dy] of [[0, 0], [300, -200], [-500, 350]] as const) {
        const s: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'small', rot: -1 };
        snapPlacementToDeck(TP, c.x + dx, c.y + dy, s);
        expect(s.slot).toBe('plate');
        expect(s.x).toBeCloseTo(c.x, 6);
        expect(s.y).toBeCloseTo(c.y, 6);
      }
    }
  });

  describe('placement on a deck', () => {
    const deck = (): PlacementDeck => {
      const ps = new PlateSet<string>();
      const a = centre(0, 0);
      ps.upsert('alice-plate', 'alice', 'connector', a.x, a.y);
      return { plates: ps, owner: 'alice' };
    };

    it('lays a new plate on the centre of a plate bordering the deck', () => {
      const c = centre(-1, 0);
      expect(placementRejection(TP, c.x, c.y, [], null, 0, false, deck())).toBeNull();
    });

    it('on a plate centre that already has a connector: refused (overlap-structure), never replaced', () => {
      const c = centre(0, 0);
      const fp = { x: c.x, y: c.y, radius: getStructureKind('connector').radius, kind: 'connector', rot: 0 };
      expect(placementRejection(TP, c.x, c.y, [fp], null, 0, false, deck())).toBe('overlap-structure');
    });
  });

  describe('deck links', () => {
    const c0 = centre(0, 0), c1 = centre(-1, 0);
    const tp = node('tp', TP, c1.x, c1.y);
    const con = node('con', 'connector', c0.x, c0.y);
    const p = ringHex(-1, 0, 2);
    const solar = node('sol', 'solar', p.x, p.y);
    const all = map(tp, con, solar);

    it('links a building on its plate ~1300 u away, past CONNECTION_MAX_RANGE', () => {
      expect(Math.hypot(p.x - c1.x, p.y - c1.y)).toBeGreaterThan(CONNECTION_MAX_RANGE);
      expect(deckLinkKind(tp, solar)).toBe(DECK_LINK_ON_PLATE);
      expect(canConnect(solar, tp, new Map(), all, undefined, undefined, undefined, true)).toEqual({ ok: true });
    });

    it('seam-links to the neighbouring plate connector', () => {
      expect(deckLinkKind(tp, con)).toBe(DECK_LINK_NEIGHBOUR);
      expect(canConnect(tp, con, new Map(), all, undefined, undefined, undefined, true)).toEqual({ ok: true });
    });

    it('its maxConnections 1 never limits deck links (they do not count)', () => {
      expect(getStructureKind(TP).maxConnections).toBe(1);
      const held = new Connection(1, 'tp', 'con', 1);
      const adj = new Map<string, Connection[]>([['tp', [held]], ['con', [held]]]);
      expect(deckCapLinkCount(tp, [held], all, true)).toBe(0);
      expect(canConnect(solar, tp, adj, all, undefined, undefined, undefined, true)).toEqual({ ok: true });
      // Deck off: the one link fills it.
      expect(deckCapLinkCount(tp, [held], all, false)).toBe(1);
    });
  });

  it('footprint and pad fit the 7-hex plate (plan: "pad radius 900 vs a plate yard")', () => {
    // The plate's nearest boundary points are its 6 inner notches, two hex
    // circumradii from the centre (≈ 1501 u at 1300 flat).
    const inscribed = 2 * DECK_HEX_SIZE;
    const { w, h } = getStructureKind(TP).footprint;
    expect(PAD_SPECS[TP].padRadius).toBeLessThan(inscribed - 130); // pad: ~601 u room
    // The 2120 box's corners (≈ 1499 u out) sit between the notches; the
    // deckSlot fit test measures 240 u room to the leaf edge.
    expect(Math.hypot(w / 2, h / 2)).toBeLessThan(inscribed);
  });
});
