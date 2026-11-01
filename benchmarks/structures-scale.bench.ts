/**
 * A0 — core structure-grid cost at base scale (plan soft-leaping-truffle v2).
 *
 * Runs the zone-pure Grid over the rule-valid scale lattice (citadel-size
 * ≈ 448 structures, sector-max ≈ 864) to measure the parts of the 1 Hz grid
 * pulse that scale with N:
 *  - `Grid.rebuild` (connected components; runs on every topology change);
 *  - an UNCACHED `Grid.route` capital → farthest node (A* with the linear
 *    open-set scan; the cache is wiped by every topology change);
 *  - a placement legality sweep: `canConnect` of one new node against all N
 *    (what `autoConnectStructure` does on every player placement).
 * The room-level costs (pulse, turret tick, slice rebuild, wire bytes) are
 * measured on a real SectorRoom by tests/integration/sectorRoom/
 * structureScale.measure.test.ts.
 *
 * Module-level setup only (vitest 2.1 bench skips beforeAll — README).
 */
import { bench, describe } from 'vitest';
import { getStructureKind } from '../src/shared-types/structureKinds.js';
import { Grid, canConnect, type GridNode } from '../src/core/structures/Grid.js';
import { Connection } from '../src/core/structures/Connection.js';
import { buildStructureLattice } from '../src/core/structures/structureLattice.js';

interface Built {
  nodes: Map<string, GridNode>;
  adj: Map<string, Connection[]>;
  far: string;
}

function build(n: number): Built {
  const lat = buildStructureLattice({ n, seed: 7, fence: true });
  const nodes = new Map<string, GridNode>();
  lat.placements.forEach((p, i) => {
    const k = getStructureKind(p.kind);
    nodes.set('s' + i, {
      id: 's' + i, x: p.x, y: p.y, radius: k.radius, isHub: k.isHub,
      isCapital: p.kind === 'capital', isConnector: p.kind === 'connector', isShieldPylon: p.kind === 'shield_pylon',
      maxConnections: k.maxConnections, connectionRange: k.connectionRange,
      powerOutput: k.powerOutput, powerConsumption: k.powerConsumption, isConstructed: true,
    });
  });
  const adj = new Map<string, Connection[]>();
  let cid = 0;
  for (const [a, b] of lat.edges) {
    const c = new Connection(cid++, 's' + a, 's' + b, 1);
    (adj.get(c.aId) ?? adj.set(c.aId, []).get(c.aId)!).push(c);
    (adj.get(c.bId) ?? adj.set(c.bId, []).get(c.bId)!).push(c);
  }
  // Farthest node from the capital (route worst case).
  let far = 's0', best = 0;
  for (const nd of nodes.values()) {
    const d = Math.hypot(nd.x, nd.y);
    if (d > best) { best = d; far = nd.id; }
  }
  return { nodes, adj, far };
}

const citadel = build(400);
const sectorMax = build(800);

function suite(label: string, b: Built): void {
  describe(`structure grid — ${label} (${b.nodes.size} structures)`, () => {
    const grid = new Grid();
    grid.rebuild(b.nodes, b.adj);
    bench('Grid.rebuild (components)', () => {
      grid.rebuild(b.nodes, b.adj);
    });
    bench('Grid.route capital → farthest, uncached', () => {
      grid.rebuild(b.nodes, b.adj); // wipes the route cache, as a topology change does
      grid.route('s0', b.far);
    });
    const probe: GridNode = { ...b.nodes.get('s1')!, id: 'probe', x: 30, y: 210 };
    bench('placement sweep: canConnect(new, all N)', () => {
      let ok = 0;
      for (const other of b.nodes.values()) if (canConnect(probe, other, b.adj, b.nodes).ok) ok++;
      if (ok < 0) throw new Error('unreachable');
    });
  });
}

suite('citadel', citadel);
suite('sector max', sectorMax);

// A1 — turret targeting, old vs new in the SAME run (relative numbers cancel
// host load). The citadel has 44 turrets; the sector holds ~750 swarm entities
// (448 structures + 300 drones). Old: each turret scans every entity. New:
// one grid rebuild over the targetable drones, then a local query per turret.
import { NearestPointGrid } from '../src/core/spatial/NearestPointGrid.js';

const ENT = 750;
const ex = new Float64Array(ENT), ey = new Float64Array(ENT), ekind = new Uint8Array(ENT);
for (let i = 0; i < ENT; i++) {
  ex[i] = ((i * 7919) % 12_000) - 6000;
  ey[i] = ((i * 104_729) % 12_000) - 6000;
  ekind[i] = i < 300 ? 1 : 2; // 300 drones, the rest structures
}
const turrets: Array<[number, number]> = [];
for (let t = 0; t < 44; t++) turrets.push([((t * 331) % 4600) - 2300, ((t * 577) % 4600) - 2300]);
const tgrid = new NearestPointGrid(512, 10_000, 1024);

describe('turret targeting — 44 turrets, 750 entities (300 drones)', () => {
  bench('old: linear scan per turret', () => {
    let sink = 0;
    for (const [tx, ty] of turrets) {
      let best = -1, bestD2 = 900 * 900;
      for (let i = 0; i < ENT; i++) {
        if (ekind[i] !== 1) continue;
        const dx = ex[i]! - tx, dy = ey[i]! - ty, d2 = dx * dx + dy * dy;
        if (d2 <= bestD2) { bestD2 = d2; best = i; }
      }
      sink += best;
    }
    if (sink === -1e9) throw new Error('unreachable');
  });
  bench('new: grid rebuild + query per turret', () => {
    tgrid.reset();
    for (let i = 0; i < ENT; i++) if (ekind[i] === 1) tgrid.add(ex[i]!, ey[i]!);
    tgrid.build();
    let sink = 0;
    for (const [tx, ty] of turrets) sink += tgrid.nearest(tx, ty, 900);
    if (sink === -1e9) throw new Error('unreachable');
  });
});
