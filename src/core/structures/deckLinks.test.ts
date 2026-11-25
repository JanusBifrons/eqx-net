/**
 * Base platforms slices 10/11 — on a deck room a plate-anchor connector links to
 * any structure on its plate, past `CONNECTION_MAX_RANGE` and past its own
 * link cap (`canConnect`'s `deck` flag, `deckLinks.ts`). Deck off is today's
 * rule.
 */
import { describe, it, expect } from 'vitest';
import { canConnect, type GridNode } from './Grid.js';
import { Connection } from './Connection.js';
import { CABLE_NO_SOCKET, makeCableSocketPick } from './cableCurve.js';
import { CONNECTION_MAX_RANGE } from './structureGridConstants.js';
import { DECK_LINK_NEIGHBOUR, DECK_LINK_NONE, DECK_LINK_ON_PLATE, deckCapLinkCount, deckLinkKind } from './deckLinks.js';
import { HEX_DIRS, type HexPoint } from '../hex/hex.js';
import { PLATE_DIRS, deckHexCentreInto, plateCentreHexInto, plateCentreWorldInto } from '../hex/plates.js';
import { getStructureKind, isConnectorKind, structureHalfExtents } from '../../shared-types/structureKinds.js';

function real(id: string, kind: string, x: number, y: number, over: Partial<GridNode> = {}): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, 0);
  return {
    id, kind, x, y, rot: 0, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: isConnectorKind(kind), isShieldPylon: false,
    maxConnections: k.maxConnections, powerOutput: 0, powerConsumption: 0, isConstructed: true, ...over,
  };
}

/** World centre of plate (i, j)'s ring hex `k` (k = -1: its centre hex). */
function hexOf(i: number, j: number, k: number): HexPoint {
  const c = plateCentreHexInto(i, j, { q: 0, r: 0 });
  const d = k < 0 ? { q: 0, r: 0 } : HEX_DIRS[k]!;
  return deckHexCentreInto(c.q + d.q, c.r + d.r, { x: 0, y: 0 });
}

const map = (...ns: GridNode[]): Map<string, GridNode> => new Map(ns.map((n) => [n.id, n]));
const NONE = new Map<string, Connection[]>();
let nextId = 1;

describe('deck link rule: a plate connector and its plate (base platforms slice 10)', () => {
  const con = real('c', 'connector', 0, 0);

  it('links to a hex building on its plate ~1300 u away, past CONNECTION_MAX_RANGE', () => {
    const p = hexOf(0, 0, 0);
    const solar = real('s', 'solar', p.x, p.y);
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(1300, 0);
    expect(deckLinkKind(con, solar)).toBe(DECK_LINK_ON_PLATE);
    expect(canConnect(solar, con, NONE, map(con, solar), undefined, undefined, undefined, true)).toEqual({ ok: true });
    expect(canConnect(con, solar, NONE, map(con, solar), undefined, undefined, undefined, true)).toEqual({ ok: true });
  });

  it('deck off keeps today’s rule: the same pair is out of range', () => {
    const p = hexOf(0, 0, 0);
    const solar = real('s', 'solar', p.x, p.y);
    expect(canConnect(solar, con, NONE, map(con, solar))).toEqual({ ok: false, reason: 'out-of-range' });
    expect(canConnect(solar, con, NONE, map(con, solar), undefined, undefined, undefined, false)).toEqual({ ok: false, reason: 'out-of-range' });
  });

  it('does not link to a building on another plate', () => {
    const p = hexOf(1, 0, 3); // plate (1,0)'s ring hex nearest the origin side
    const solar = real('s', 'solar', p.x, p.y);
    expect(deckLinkKind(con, solar)).toBe(DECK_LINK_NONE);
    expect(canConnect(solar, con, NONE, map(con, solar), undefined, undefined, undefined, true)).toEqual({ ok: false, reason: 'out-of-range' });
  });

  it('a connector off its plate centre is no anchor: ordinary range applies', () => {
    const off = real('c', 'connector', 200, 0);
    const p = hexOf(0, 0, 0);
    const solar = real('s', 'solar', p.x, p.y);
    expect(deckLinkKind(off, solar)).toBe(DECK_LINK_NONE);
    expect(canConnect(solar, off, NONE, map(off, solar), undefined, undefined, undefined, true).ok).toBe(false);
  });

  it('the anchor’s cap neither blocks nor counts its deck links', () => {
    // Six ordinary links fill the anchor's cap (partners off the plate).
    const far = [0, 1, 2, 3, 4, 5].map((k) => real(`f${k}`, 'battery', 9000 + k * 400, 0));
    const p = hexOf(0, 0, 0);
    const solar = real('s', 'solar', p.x, p.y);
    const adj = new Map<string, Connection[]>([['c', far.map((f) => new Connection(nextId++, 'c', f.id, 1))]]);
    const nodes = map(con, solar, ...far);
    expect(deckCapLinkCount(con, adj.get('c')!, nodes, true)).toBe(6);
    expect(canConnect(solar, con, adj, nodes, undefined, undefined, undefined, true)).toEqual({ ok: true });
    expect(canConnect(solar, con, adj, nodes)).toEqual({ ok: false, reason: 'b-full' });
    // Deck links don't fill it: six of them leave room for an ordinary link.
    const deckAdj = new Map<string, Connection[]>([['c', [0, 1, 2, 3, 4, 5].map((k) => new Connection(nextId++, 'c', `d${k}`, 1))]]);
    const deckNodes = map(con, ...[0, 1, 2, 3, 4, 5].map((k) => { const h = hexOf(0, 0, k); return real(`d${k}`, 'solar', h.x, h.y); }));
    expect(deckCapLinkCount(con, deckAdj.get('c')!, deckNodes, true)).toBe(0);
    expect(deckCapLinkCount(con, deckAdj.get('c')!, deckNodes, false)).toBe(6);
  });

  it('eight buildings on one plate all link past range and the cap (seam cables skip the crossing refusal, slice 12)', () => {
    const pick = makeCableSocketPick();
    // Six hex buildings on the ring, two small ones between them.
    const parts: GridNode[] = [0, 1, 2, 3, 4, 5].map((k) => { const h = hexOf(0, 0, k); return real(`s${k}`, 'solar', h.x, h.y); });
    for (const k of [0, 3]) {
      const a = hexOf(0, 0, k), b = hexOf(0, 0, (k + 1) % 6);
      parts.push(real(`b${k}`, 'battery', (a.x + b.x) / 2 * 0.62, (a.y + b.y) / 2 * 0.62));
    }
    const nodes = map(con, ...parts);
    const adj = new Map<string, Connection[]>();
    const verdicts: string[] = [];
    for (const n of parts) {
      const r = canConnect(n, con, adj, nodes, undefined, pick, undefined, true);
      verdicts.push(r.ok ? 'ok' : r.reason);
      if (!r.ok) continue;
      const link = new Connection(nextId++, n.id, 'c', 1, pick.a, pick.b);
      adj.set(n.id, [...(adj.get(n.id) ?? []), link]);
      adj.set('c', [...(adj.get('c') ?? []), link]);
    }
    expect(verdicts).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    // Deck cables take no socket: the connector's studs stay free for ordinary links.
    expect(adj.get('c')!.every((l) => l.socketA === CABLE_NO_SOCKET && l.socketB === CABLE_NO_SOCKET)).toBe(true);
  });

  it('a deck link takes no socket (CABLE_NO_SOCKET), even with studs free', () => {
    const pick = makeCableSocketPick();
    const p = hexOf(0, 0, 0);
    const solar = real('s', 'solar', p.x, p.y);
    // Every connector socket already holds a (phantom) cable.
    const conFull = real('c', 'connector', 0, 0, { usedSockets: 0b111111 });
    const r = canConnect(solar, conFull, NONE, map(conFull, solar), undefined, pick, undefined, true);
    expect(r).toEqual({ ok: true });
    expect(pick.a).toBe(CABLE_NO_SOCKET);
    expect(pick.b).toBe(CABLE_NO_SOCKET);
  });

  it('sanity: plate (1,0) is far beyond ordinary range', () => {
    const c = plateCentreWorldInto(1, 0, { x: 0, y: 0 });
    expect(Math.hypot(c.x, c.y)).toBeGreaterThan(CONNECTION_MAX_RANGE * 5);
  });
});

describe('deck link rule: neighbouring plate connectors (base platforms slice 11)', () => {
  const con = real('c', 'connector', 0, 0);
  const at = (i: number, j: number, id: string): GridNode => { const p = plateCentreWorldInto(i, j, { x: 0, y: 0 }); return real(id, 'connector', p.x, p.y); };

  it('every neighbouring plate connector (~3440 u) links, past range', () => {
    for (const d of PLATE_DIRS) {
      const n = at(d.i, d.j, 'n');
      expect(Math.hypot(n.x, n.y)).toBeGreaterThan(3400);
      expect(Math.hypot(n.x, n.y)).toBeLessThan(3480);
      expect(deckLinkKind(con, n)).toBe(DECK_LINK_NEIGHBOUR);
      expect(canConnect(con, n, NONE, map(con, n), undefined, undefined, undefined, true)).toEqual({ ok: true });
      expect(canConnect(n, con, NONE, map(con, n), undefined, undefined, undefined, true)).toEqual({ ok: true });
    }
  });

  it('deck off: the same pair is out of range', () => {
    const n = at(1, 0, 'n');
    expect(canConnect(con, n, NONE, map(con, n))).toEqual({ ok: false, reason: 'out-of-range' });
  });

  it('connectors two plates away do not link', () => {
    for (const [i, j] of [[2, 0], [0, 2], [1, 1], [-2, 2]] as const) {
      const n = at(i, j, 'n');
      expect(deckLinkKind(con, n)).toBe(DECK_LINK_NONE);
      expect(canConnect(con, n, NONE, map(con, n), undefined, undefined, undefined, true)).toEqual({ ok: false, reason: 'out-of-range' });
    }
  });

  it('a non-connector on the neighbouring plate is no neighbour link', () => {
    const p = plateCentreWorldInto(1, 0, { x: 0, y: 0 });
    const solar = real('s', 'solar', p.x, p.y);
    expect(deckLinkKind(con, solar)).toBe(DECK_LINK_NONE);
  });

  it('neither end’s cap blocks or counts a neighbour link', () => {
    const n = at(1, 0, 'n');
    const far = (pre: string) => [0, 1, 2, 3, 4, 5].map((k) => real(`${pre}${k}`, 'battery', -9000 - k * 400, 9000));
    const fa = far('fa'), fb = far('fb');
    const adj = new Map<string, Connection[]>([
      ['c', fa.map((f) => new Connection(nextId++, 'c', f.id, 1))],
      ['n', fb.map((f) => new Connection(nextId++, 'n', f.id, 1))],
    ]);
    const nodes = map(con, n, ...fa, ...fb);
    expect(canConnect(con, n, adj, nodes, undefined, undefined, undefined, true)).toEqual({ ok: true });
    expect(canConnect(con, n, adj, nodes).ok).toBe(false);
    const link = [new Connection(nextId++, 'c', 'n', 1)];
    expect(deckCapLinkCount(con, link, map(con, n), true)).toBe(0);
    expect(deckCapLinkCount(n, link, map(con, n), true)).toBe(0);
  });
});
