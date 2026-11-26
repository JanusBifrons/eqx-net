/**
 * Base platforms slice 34 — a road takes no cable at all (owner ruling). Its
 * kind has `maxConnections` 0, and `canConnect` refuses a flat deck tile at
 * any level, on a deck (the plate anchor's on-plate link) or off it, from a
 * connector or a fence post, whichever end it is.
 */
import { describe, expect, it } from 'vitest';
import { canConnect, type GridNode } from './Grid.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { plateCentreHex, plateCentreWorldInto, deckHexCentreInto } from '../hex/plates.js';
import { HEX_DIRS } from '../hex/hex.js';
import { DECK_LINK_ON_PLATE, deckLinkKind } from './deckLinks.js';

function node(id: string, kind: string, x: number, y: number, maxConnections = getStructureKind(kind).maxConnections): GridNode {
  const k = getStructureKind(kind);
  return {
    id, kind, x, y, rot: 0, radius: k.radius, halfW: k.footprint.w / 2, halfH: k.footprint.h / 2,
    isHub: k.isHub, isCapital: false, isConnector: kind === 'connector', isShieldPylon: kind === 'shield_pylon',
    maxConnections, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}

describe('a road takes no cable (base platforms 34)', () => {
  const at = plateCentreWorldInto(0, 0, { x: 0, y: 0 });
  const c = plateCentreHex(0, 0), d = HEX_DIRS[0]!;
  const hex = deckHexCentreInto(c.q + d.q, c.r + d.r, { x: 0, y: 0 });

  it('the road kind has no link slot', () => {
    expect(getStructureKind('road').maxConnections).toBe(0);
  });

  it('a plate anchor cannot link the road on its plate, either order', () => {
    const anchor = node('a', 'connector', at.x, at.y);
    const road = node('r', 'road', hex.x, hex.y);
    expect(deckLinkKind(anchor, road), 'the on-plate rule would allow it').toBe(DECK_LINK_ON_PLATE);
    const nodes = new Map([['a', anchor], ['r', road]]);
    expect(canConnect(anchor, road, new Map(), nodes, undefined, undefined, undefined, true)).toEqual({ ok: false, reason: 'b-full' });
    expect(canConnect(road, anchor, new Map(), nodes, undefined, undefined, undefined, true)).toEqual({ ok: false, reason: 'a-full' });
  });

  it('a leveled road (a raised cap) still takes no cable, off a deck too', () => {
    const conn = node('c', 'connector', hex.x + 700, hex.y);
    const road = node('r', 'road', hex.x, hex.y, 4);
    const nodes = new Map([['c', conn], ['r', road]]);
    expect(canConnect(conn, road, new Map(), nodes).ok).toBe(false);
    expect(canConnect(road, conn, new Map(), nodes).ok).toBe(false);
  });
});
