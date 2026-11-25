/**
 * Owner rule (2026-11-21): connector cables never cross each other. A new
 * link whose cable would cross an existing cable is refused (`crosses-cable`),
 * like a link blocked by a building or a rock. Cables that fan out from the
 * same structure share an end and never count as crossing. Shield-fence links
 * (emitter post to post) are walls, not cables: they neither block a cable
 * nor are blocked by one. Existing links are never touched.
 */
import { describe, it, expect } from 'vitest';
import { canConnect, type GridNode } from './Grid.js';
import { CABLE_CROSS_STATS, makeCableSocketPick } from './cableCurve.js';
import { Connection } from './Connection.js';
import { getStructureKind, isConnectorKind, structureHalfExtents } from '../../shared-types/structureKinds.js';

function real(id: string, kind: string, x: number, y: number): GridNode {
  const k = getStructureKind(kind);
  const { hw, hh } = structureHalfExtents(kind, 0);
  return {
    id, kind, x, y, rot: 0, radius: k.radius, halfW: hw, halfH: hh, isHub: k.isHub,
    isCapital: kind === 'capital', isConnector: isConnectorKind(kind),
    isShieldPylon: kind === 'shield_pylon' || kind === 'shield_gate' || kind === 'shield_airlock',
    maxConnections: 10, powerOutput: 0, powerConsumption: 0, isConstructed: true,
  };
}

const map = (...ns: GridNode[]): Map<string, GridNode> => new Map(ns.map((n) => [n.id, n]));
const pick = makeCableSocketPick();
let connId = 0;

/** Link `a`–`b` the way the server does (canConnect picks the sockets), into `adj`. */
function link(a: GridNode, b: GridNode, adj: Map<string, Connection[]>, nodes: Map<string, GridNode>): void {
  expect(canConnect(a, b, adj, nodes, undefined, pick)).toEqual({ ok: true });
  const c = new Connection(connId++, a.id, b.id, 1, pick.a, pick.b);
  (adj.get(a.id) ?? adj.set(a.id, []).get(a.id)!).push(c);
  (adj.get(b.id) ?? adj.set(b.id, []).get(b.id)!).push(c);
}

describe('cables never cross (crosses-cable)', () => {
  // An existing cable across the middle, west to east.
  const w = real('w', 'connector', -300, 0);
  const e = real('e', 'connector', 300, 0);

  it('a new link whose cable crosses an existing cable is refused', () => {
    const n = real('n', 'connector', 0, 250);
    const s = real('s', 'connector', 0, -250);
    const nodes = map(w, e, n, s);
    const adj = new Map<string, Connection[]>();
    // Without the existing cable the north-south link is fine.
    expect(canConnect(n, s, adj, nodes)).toEqual({ ok: true });
    link(w, e, adj, nodes);
    expect(canConnect(n, s, adj, nodes)).toEqual({ ok: false, reason: 'crosses-cable' });
    // Either argument order (the preview passes the ghost first).
    expect(canConnect(s, n, adj, nodes)).toEqual({ ok: false, reason: 'crosses-cable' });
  });

  it('links that fan out from the same structure are not crossings', () => {
    const n = real('n', 'connector', 0, 250);
    const s = real('s', 'connector', 0, -250);
    const nodes = map(w, e, n, s);
    const adj = new Map<string, Connection[]>();
    link(w, e, adj, nodes);
    // Both share an end with the w–e cable.
    expect(canConnect(w, n, adj, nodes)).toEqual({ ok: true });
    expect(canConnect(n, e, adj, nodes)).toEqual({ ok: true });
    link(w, n, adj, nodes);
    link(w, s, adj, nodes);
    expect(canConnect(e, n, adj, nodes)).toEqual({ ok: true });
  });

  it('a nearby link that does not cross is allowed', () => {
    const a = real('a', 'connector', -250, 200);
    const b = real('b', 'connector', 250, 200);
    const nodes = map(w, e, a, b);
    const adj = new Map<string, Connection[]>();
    link(w, e, adj, nodes);
    expect(canConnect(a, b, adj, nodes)).toEqual({ ok: true });
  });

  it('shield-fence links are walls, not cables: they neither block nor get blocked', () => {
    const p1 = real('p1', 'shield_pylon', 0, 250);
    const p2 = real('p2', 'shield_pylon', 0, -250);
    const nodes = map(w, e, p1, p2);
    const adj = new Map<string, Connection[]>();
    link(p1, p2, adj, nodes); // a fence across the middle
    // A cable across the fence is not refused for crossing it.
    expect(canConnect(w, e, adj, nodes)).toEqual({ ok: true });
    const adj2 = new Map<string, Connection[]>();
    link(w, e, adj2, nodes);
    // A new fence link across a cable is not refused either.
    expect(canConnect(p1, p2, adj2, nodes)).toEqual({ ok: true });
  });

  it('far links are skipped by the box broad phase (no segment tests)', () => {
    const n = real('n', 'connector', 0, 250);
    const s = real('s', 'connector', 0, -250);
    const fw = real('fw', 'connector', 5000, 0);
    const fe = real('fe', 'connector', 5500, 0);
    const nodes = map(n, s, fw, fe);
    const adj = new Map<string, Connection[]>();
    link(fw, fe, adj, nodes);
    CABLE_CROSS_STATS.links = 0;
    CABLE_CROSS_STATS.segTests = 0;
    expect(canConnect(n, s, adj, nodes)).toEqual({ ok: true });
    expect(CABLE_CROSS_STATS.links).toBe(0);
    expect(CABLE_CROSS_STATS.segTests).toBe(0);
  });
});
