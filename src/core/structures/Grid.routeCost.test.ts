/**
 * Route cost lock (plan soft-leaping-truffle v2, A1). After a topology change
 * every route from the Capital must come from ONE shortest-hop search, not one
 * search per route: the old per-pair A* cost 0.94 ms per route at citadel
 * scale and re-ran for every damaged/blueprint structure. Counted, not timed.
 */
import { describe, expect, it } from 'vitest';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { Grid, type GridNode } from './Grid.js';
import { Connection } from './Connection.js';
import { buildStructureLattice } from './structureLattice.js';

describe('Grid.route — one search per source per topology change', () => {
  it('routing to all ~450 nodes from the Capital reads each adjacency list about once', () => {
    const lat = buildStructureLattice({ n: 400, seed: 7, fence: true });
    const nodes = new Map<string, GridNode>();
    lat.placements.forEach((p, i) => {
      const k = getStructureKind(p.kind);
      nodes.set('s' + i, {
        id: 's' + i, x: p.x, y: p.y, radius: k.radius, isHub: k.isHub,
        isCapital: p.kind === 'capital', isConnector: p.kind === 'connector', isShieldPylon: p.kind === 'shield_pylon',
        maxConnections: k.maxConnections, powerOutput: k.powerOutput, powerConsumption: k.powerConsumption, isConstructed: true,
      });
    });
    const adj = new Map<string, Connection[]>();
    let cid = 0;
    for (const [a, b] of lat.edges) {
      const c = new Connection(cid++, 's' + a, 's' + b, 1);
      (adj.get(c.aId) ?? adj.set(c.aId, []).get(c.aId)!).push(c);
      (adj.get(c.bId) ?? adj.set(c.bId, []).get(c.bId)!).push(c);
    }
    let reads = 0;
    const counted = new Proxy(adj, {
      get(t, prop) {
        if (prop === 'get') return (k: string) => { reads++; return t.get(k); };
        const v = Reflect.get(t, prop, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const grid = new Grid();
    grid.rebuild(nodes, counted);
    reads = 0;
    let routed = 0;
    for (const id of nodes.keys()) if (grid.route('s0', id)) routed++;
    expect(routed).toBe(nodes.size);
    // One BFS: ≤ one adjacency read per node (+ slack). The old per-route A*
    // read O(V) lists per route ⇒ O(V²) ≈ 200 000 here.
    expect(reads).toBeLessThanOrEqual(nodes.size * 1.1);
  });
});
