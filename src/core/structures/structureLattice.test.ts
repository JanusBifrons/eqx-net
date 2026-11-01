/**
 * The scale lattice must be buildable under the REAL rules — the same
 * `placementRejection` + `canConnect` the server enforces — or the A0
 * measurements would measure an impossible base.
 */
import { describe, expect, it } from 'vitest';
import { getStructureKind, structureHalfExtents } from '../../shared-types/structureKinds.js';
import { canConnect, type GridNode } from './Grid.js';
import { Connection } from './Connection.js';
import { placementRejection } from './placementRules.js';
import { buildStructureLattice } from './structureLattice.js';

function node(id: string, kind: string, x: number, y: number): GridNode {
  const k = getStructureKind(kind);
  return {
    id, x, y, radius: k.radius,
    halfW: structureHalfExtents(kind).hw,
    halfH: structureHalfExtents(kind).hh,
    isHub: k.isHub,
    isCapital: kind === 'capital',
    isConnector: kind === 'connector',
    isShieldPylon: kind === 'shield_pylon',
    maxConnections: k.maxConnections,
    connectionRange: k.connectionRange,
    powerOutput: k.powerOutput,
    powerConsumption: k.powerConsumption,
    isConstructed: true,
  };
}

function check(n: number, fence: boolean): { total: number; reached: number; net: number; pylons: number } {
  const lat = buildStructureLattice({ n, seed: 7, fence });
  const nodes = new Map<string, GridNode>();
  const placed: Array<{ x: number; y: number; radius: number; halfW: number; halfH: number }> = [];
  lat.placements.forEach((p, i) => {
    expect(placementRejection(p.kind, p.x, p.y, placed), `placement ${i} ${p.kind} @${p.x},${p.y}`).toBeNull();
    const nd = node('s' + i, p.kind, p.x, p.y);
    placed.push({ x: p.x, y: p.y, radius: nd.radius, halfW: nd.halfW!, halfH: nd.halfH! });
    nodes.set(nd.id, nd);
  });
  const adj = new Map<string, Connection[]>();
  let cid = 0;
  for (const [a, b] of lat.edges) {
    const na = nodes.get('s' + a)!, nb = nodes.get('s' + b)!;
    const r = canConnect(na, nb, adj, nodes);
    expect(r, `edge ${a}(${lat.placements[a]!.kind})-${b}(${lat.placements[b]!.kind})`).toEqual({ ok: true });
    const c = new Connection(cid++, na.id, nb.id, 1);
    (adj.get(na.id) ?? adj.set(na.id, []).get(na.id)!).push(c);
    (adj.get(nb.id) ?? adj.set(nb.id, []).get(nb.id)!).push(c);
  }
  // Every structure reachable from the Capital.
  const seen = new Set(['s0']);
  const q = ['s0'];
  while (q.length) {
    const id = q.pop()!;
    for (const c of adj.get(id) ?? []) {
      const o = c.getOtherNode(id)!;
      if (!seen.has(o)) { seen.add(o); q.push(o); }
    }
  }
  let net = 0;
  for (const nd of nodes.values()) net += nd.powerOutput - nd.powerConsumption;
  return { total: lat.placements.length, reached: seen.size, net, pylons: lat.fencePylons };
}

describe('buildStructureLattice — valid under the real building rules', () => {
  it.each([1, 2, 30, 100, 400, 800])('n=%i: every placement + edge legal, all connected', (n) => {
    const r = check(n, false);
    expect(r.total).toBe(n);
    expect(r.reached).toBe(n);
    expect(r.net).toBeGreaterThanOrEqual(0);
  });

  it.each([30, 100, 400, 800])('n=%i with a fence: closed pylon ring, tapped, powered', (n) => {
    const r = check(n, true);
    expect(r.pylons).toBeGreaterThan(8);
    expect(r.total).toBe(n + r.pylons);
    expect(r.reached).toBe(r.total);
    expect(r.net).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic per (n, seed)', () => {
    const a = buildStructureLattice({ n: 200, seed: 3, fence: true });
    const b = buildStructureLattice({ n: 200, seed: 3, fence: true });
    expect(a).toEqual(b);
  });
});
