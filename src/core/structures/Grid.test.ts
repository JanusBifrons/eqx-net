import { describe, it, expect } from 'vitest';
import {
  Grid,
  canConnect,
  edgeDistance,
  segmentIntersectsAabb,
  isConnectionLineBlocked,
  type GridNode,
  type GridObstacle,
} from './Grid.js';
import { Connection } from './Connection.js';
import {
  CONNECTION_MAX_RANGE,
  CONNECTION_THROUGHPUT,
} from './structureGridConstants.js';

// ── Test node factory ──────────────────────────────────────────────────────
function node(id: string, opts: Partial<GridNode> = {}): GridNode {
  return {
    id,
    x: opts.x ?? 0,
    y: opts.y ?? 0,
    radius: opts.radius ?? 24,
    isHub: opts.isHub ?? false,
    isCapital: opts.isCapital ?? false,
    isConnector: opts.isConnector ?? false,
    maxConnections: opts.maxConnections ?? 1,
    powerOutput: opts.powerOutput ?? 0,
    powerConsumption: opts.powerConsumption ?? 0,
    isConstructed: opts.isConstructed ?? true,
    ...(opts.connectionRange !== undefined ? { connectionRange: opts.connectionRange } : {}),
    ...(opts.isShieldPylon !== undefined ? { isShieldPylon: opts.isShieldPylon } : {}),
  };
}
const capital = (id: string, x: number, y: number, built = true): GridNode =>
  node(id, { x, y, radius: 80, isHub: true, isCapital: true, maxConnections: 4, powerOutput: 50, isConstructed: built });
const connector = (id: string, x: number, y: number, built = true): GridNode =>
  node(id, { x, y, radius: 10, isHub: true, isConnector: true, maxConnections: 6, isConstructed: built });
const solar = (id: string, x: number, y: number, built = true): GridNode =>
  node(id, { x, y, radius: 40, maxConnections: 1, powerOutput: 30, isConstructed: built });
const pylon = (id: string, x: number, y: number, built = true): GridNode =>
  node(id, { x, y, radius: 12, isHub: true, isShieldPylon: true, maxConnections: 3, isConstructed: built });

/** Build an adjacency map from a flat connection list. */
function adjacencyFrom(conns: Connection[]): Map<string, Connection[]> {
  const adj = new Map<string, Connection[]>();
  for (const c of conns) {
    (adj.get(c.aId) ?? adj.set(c.aId, []).get(c.aId)!).push(c);
    (adj.get(c.bId) ?? adj.set(c.bId, []).get(c.bId)!).push(c);
  }
  return adj;
}

describe('geometry helpers', () => {
  it('edgeDistance is edge-to-edge (0 when AABBs overlap)', () => {
    const a = node('a', { x: 0, y: 0, radius: 50 });
    const b = node('b', { x: 200, y: 0, radius: 50 });
    expect(edgeDistance(a, b)).toBeCloseTo(100, 6); // 200 - (50+50)
    const overlapping = node('c', { x: 60, y: 0, radius: 50 });
    expect(edgeDistance(a, overlapping)).toBe(0);
  });

  it('segmentIntersectsAabb detects crossing + misses', () => {
    // Box [-10,-10]..[10,10]; horizontal segment through it.
    expect(segmentIntersectsAabb(-50, 0, 50, 0, -10, -10, 10, 10)).toBe(true);
    // Segment passing above the box.
    expect(segmentIntersectsAabb(-50, 50, 50, 50, -10, -10, 10, 10)).toBe(false);
  });

  it('isConnectionLineBlocked rejects a segment through a third body', () => {
    const a = node('a', { x: -300, y: 0 });
    const b = node('b', { x: 300, y: 0 });
    const blocker = node('mid', { x: 0, y: 0, radius: 50 });
    const clear = node('off', { x: 0, y: 400, radius: 50 });
    expect(isConnectionLineBlocked(a, b, new Map([['mid', blocker]]))).toBe(true);
    expect(isConnectionLineBlocked(a, b, new Map([['off', clear]]))).toBe(false);
  });
});

describe('canConnect — the hub model (eqx-peri rules)', () => {
  const cap = capital('cap', 0, 0);
  const con = connector('con', 200, 0);
  const sol = solar('sol', 200, 200);

  it('REJECTS leaf ↔ leaf (hub required)', () => {
    const s1 = solar('s1', 0, 0);
    const s2 = solar('s2', 150, 0);
    const r = canConnect(s1, s2, new Map(), new Map([['s1', s1], ['s2', s2]]));
    expect(r).toEqual({ ok: false, reason: 'hub-required' });
  });

  it('ACCEPTS leaf ↔ connector (the relay path)', () => {
    expect(canConnect(sol, con, new Map(), new Map([['sol', sol], ['con', con]])).ok).toBe(true);
  });

  it('REJECTS leaf ↔ capital (WS-5 capital-only-connectors, R2.10)', () => {
    // A solar 120 u from the Capital connected fine pre-WS-5; the Capital now
    // accepts ONLY Connectors, so a leaf must route through a relay. This is the
    // deliberate golden FLIP (was `{ ok: true }` before WS-5).
    const solNearCap = solar('sol2', 120, 0);
    expect(canConnect(solNearCap, cap, new Map(), new Map([['sol2', solNearCap], ['cap', cap]])))
      .toEqual({ ok: false, reason: 'capital-only' });
    // Symmetric — Capital as arg `a` rejects the leaf the same way.
    expect(canConnect(cap, solNearCap, new Map(), new Map([['sol2', solNearCap], ['cap', cap]])))
      .toEqual({ ok: false, reason: 'capital-only' });
  });

  it('ACCEPTS hub ↔ hub (connector ↔ capital) — the relay IS allowed on the Capital', () => {
    expect(canConnect(con, cap, new Map(), new Map([['con', con], ['cap', cap]])).ok).toBe(true);
  });

  it('rejects self and duplicate', () => {
    expect(canConnect(cap, cap, new Map(), new Map())).toEqual({ ok: false, reason: 'self' });
    const existing = new Connection(1, 'con', 'cap', CONNECTION_THROUGHPUT);
    const adj = adjacencyFrom([existing]);
    const r = canConnect(con, cap, adj, new Map([['con', con], ['cap', cap]]));
    expect(r).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('enforces maxConnections: a leaf rejects its 2nd link', () => {
    const leaf = solar('leaf', 200, 0); // maxConnections 1
    const hub1 = connector('h1', 100, 0);
    const adj = adjacencyFrom([new Connection(1, 'leaf', 'h1', CONNECTION_THROUGHPUT)]);
    const hub2 = connector('h2', 300, 0);
    const r = canConnect(leaf, hub2, adj, new Map([['leaf', leaf], ['h1', hub1], ['h2', hub2]]));
    expect(r).toEqual({ ok: false, reason: 'a-full' });
  });

  it('enforces maxConnections: a connector rejects its 7th link', () => {
    const hub = connector('hub', 0, 0); // maxConnections 6
    const conns: Connection[] = [];
    for (let i = 0; i < 6; i++) conns.push(new Connection(i, 'hub', `leaf${i}`, CONNECTION_THROUGHPUT));
    const adj = adjacencyFrom(conns);
    const newLeaf = solar('leafX', 100, 0);
    const r = canConnect(hub, newLeaf, adj, new Map([['hub', hub], ['leafX', newLeaf]]));
    expect(r).toEqual({ ok: false, reason: 'a-full' }); // the connector (arg a) is full
  });

  it('enforces the edge-to-edge range gate', () => {
    const far = connector('far', CONNECTION_MAX_RANGE + 500, 0);
    const r = canConnect(cap, far, new Map(), new Map([['cap', cap], ['far', far]]));
    expect(r).toEqual({ ok: false, reason: 'out-of-range' });
  });

  it('the Capital uses the UNIFORM global range — no per-kind shortening (P3.2)', () => {
    // P3.2 reverted the R2.10 Capital short-reach: every kind now uses the
    // global 600 u. A Connector 450 u edge-distance from the Capital — OUTSIDE
    // the old 300 u reach (rejected pre-P3.2) — is now LEGAL. Capital r80 +
    // connector r10 = 90 centre-to-edge slack, so centre x = 90 + 450.
    const conFar = connector('conFar', 90 + 450, 0);
    expect(edgeDistance(cap, conFar)).toBeCloseTo(450, 6);
    expect(canConnect(cap, conFar, new Map(), new Map([['cap', cap], ['conFar', conFar]])).ok).toBe(true);
    // The global 600 u still bounds it: a Connector beyond 600 u edge is out of
    // range for the Capital, exactly as for any other pair.
    const conBeyond = connector('conBeyond', 90 + CONNECTION_MAX_RANGE + 50, 0);
    expect(canConnect(cap, conBeyond, new Map(), new Map([['cap', cap], ['conBeyond', conBeyond]])))
      .toEqual({ ok: false, reason: 'out-of-range' });
  });

  it('rejects a line-of-sight-blocked link', () => {
    // Within range so the LOS rule, not the range gate, is what rejects.
    // Two Connectors (not the Capital) so the global 600 u range applies — at
    // 580 u edge (600 centre − 2·r10) they're in range, so the LOS/obstacle
    // rule is what rejects, not the Capital's shorter 300 u reach (WS-5).
    const a = connector('a', -300, 0);
    const b = connector('b', 300, 0);
    const blocker = connector('blk', 0, 0, true);
    const nodes = new Map([['a', a], ['b', b], ['blk', blocker]]);
    expect(canConnect(a, b, new Map(), nodes)).toEqual({ ok: false, reason: 'blocked' });
  });
});

// ── Phase 5 — shield-pylon dual-cap ("shield pylons broke") ─────────────────
// Spec: a shield pylon connects to a MAX of 1 connector AND up to 3 OTHER shield
// pylons — TWO DISCRETE budgets (so a pylon can hold 1 connector + 3 pylons = 4,
// which the old single `maxConnections: 3` cap wrongly blocked). A pylon links
// ONLY to connectors + pylons (never a leaf; the Capital is already capital-only).
describe('canConnect — shield-pylon dual-cap (Phase 5)', () => {
  const link = (a: string, b: string): Connection =>
    new Connection(0, a, b, CONNECTION_THROUGHPUT);
  const nodeMap = (...ns: GridNode[]): Map<string, GridNode> => {
    const m = new Map<string, GridNode>();
    for (const n of ns) m.set(n.id, n);
    return m;
  };

  it('a pylon links to a connector AND to other pylons (its two valid targets)', () => {
    const p = pylon('p', 0, 0);
    const c = connector('c', 0, 40);
    const p2 = pylon('p2', 40, 0);
    const nodes = nodeMap(p, c, p2);
    expect(canConnect(p, c, new Map(), nodes).ok).toBe(true);
    expect(canConnect(p, p2, new Map(), nodes).ok).toBe(true);
  });

  it('rejects a SECOND connector on a pylon (max 1 connector)', () => {
    const p = pylon('p', 0, 0);
    const c1 = connector('c1', 0, 40);
    const c2 = connector('c2', 0, -40);
    const adj = new Map<string, Connection[]>([['p', [link('p', 'c1')]], ['c1', [link('p', 'c1')]]]);
    expect(canConnect(p, c2, adj, nodeMap(p, c1, c2))).toEqual({ ok: false, reason: 'pylon-rule' });
  });

  it('rejects a FOURTH pylon on a pylon (max 3 other pylons)', () => {
    const p = pylon('p', 0, 0);
    const a = pylon('a', 30, 0), b = pylon('b', 60, 0), c = pylon('c', 90, 0);
    const p4 = pylon('p4', 0, 30);
    const adj = new Map<string, Connection[]>([['p', [link('p', 'a'), link('p', 'b'), link('p', 'c')]]]);
    expect(canConnect(p, p4, adj, nodeMap(p, a, b, c, p4))).toEqual({ ok: false, reason: 'pylon-rule' });
  });

  it('DUAL budget — a pylon with 3 pylons can STILL add 1 connector (old single cap blocked this)', () => {
    const p = pylon('p', 0, 0);
    const a = pylon('a', 30, 0), b = pylon('b', 60, 0), c = pylon('c', 90, 0);
    const conn = connector('conn', 0, 30);
    const adj = new Map<string, Connection[]>([['p', [link('p', 'a'), link('p', 'b'), link('p', 'c')]]]);
    expect(canConnect(p, conn, adj, nodeMap(p, a, b, c, conn)).ok).toBe(true);
  });

  it('a pylon does NOT link to a leaf (solar) — pylons link only to connectors + pylons', () => {
    const p = pylon('p', 0, 0);
    const s = solar('s', 0, 40);
    expect(canConnect(p, s, new Map(), nodeMap(p, s))).toEqual({ ok: false, reason: 'pylon-rule' });
  });
});

// ── Item D — obstacle-aware connection blocking (asteroids) ────────────────
describe('canConnect / isConnectionLineBlocked — obstacle blocking (Item D)', () => {
  it('isConnectionLineBlocked: an obstacle ON the segment blocks; OFF does not', () => {
    const a = node('a', { x: -300, y: 0 });
    const b = node('b', { x: 300, y: 0 });
    const onSegment: GridObstacle = { x: 0, y: 0, radius: 50 };
    const offSegment: GridObstacle = { x: 0, y: 400, radius: 50 };
    // No OTHER structure nodes; only the asteroid sits between a and b.
    const nodes = new Map([['a', a], ['b', b]]);
    expect(isConnectionLineBlocked(a, b, nodes, [onSegment])).toBe(true);
    expect(isConnectionLineBlocked(a, b, nodes, [offSegment])).toBe(false);
    // Omitted obstacles param ⇒ current (structures-only) behaviour: not blocked.
    expect(isConnectionLineBlocked(a, b, nodes)).toBe(false);
  });

  it('canConnect: an asteroid on the connecting segment ⇒ blocked', () => {
    // Two in-range hubs (edge dist 580 = 600 − 2·r10 ≤ CONNECTION_MAX_RANGE),
    // nothing between them in the nodes map — only the asteroid blocks LOS.
    // Two Connectors (not the Capital) so the global 600 u range applies — at
    // 580 u edge they're in range, so the LOS/obstacle rule is what rejects,
    // not the Capital's shorter 300 u reach (WS-5).
    const a = connector('a', -300, 0);
    const b = connector('b', 300, 0);
    const nodes = new Map([['a', a], ['b', b]]);
    const asteroid: GridObstacle = { x: 0, y: 0, radius: 60 };
    expect(canConnect(a, b, new Map(), nodes, [asteroid])).toEqual({
      ok: false,
      reason: 'blocked',
    });
  });

  it('canConnect: an asteroid off the connecting segment ⇒ ok', () => {
    // Two Connectors (not the Capital) so the global 600 u range applies — at
    // 552 u edge they're in range, so the LOS/obstacle rule is what rejects,
    // not the Capital's shorter 300 u reach (WS-5).
    const a = connector('a', -300, 0);
    const b = connector('b', 300, 0);
    const nodes = new Map([['a', a], ['b', b]]);
    const asteroid: GridObstacle = { x: 0, y: 500, radius: 60 };
    expect(canConnect(a, b, new Map(), nodes, [asteroid])).toEqual({ ok: true });
  });

  it('canConnect: omitting obstacles is byte-identical to the pre-Item-D call', () => {
    // Same two hubs, an asteroid that WOULD block — but the obstacles param is
    // omitted, so the call must behave exactly as today (connect ok).
    // Two Connectors (not the Capital) so the global 600 u range applies — at
    // 552 u edge they're in range, so the LOS/obstacle rule is what rejects,
    // not the Capital's shorter 300 u reach (WS-5).
    const a = connector('a', -300, 0);
    const b = connector('b', 300, 0);
    const nodes = new Map([['a', a], ['b', b]]);
    expect(canConnect(a, b, new Map(), nodes)).toEqual({ ok: true });
  });
});

describe('Grid — components, power, routing, dead-end', () => {
  it('built capital→connector→solar form one powered component with summed power', () => {
    const cap = capital('cap', 0, 0);
    const con = connector('con', 300, 0);
    const sol = solar('sol', 600, 0);
    const nodes = new Map([['cap', cap], ['con', con], ['sol', sol]]);
    const adj = adjacencyFrom([
      new Connection(1, 'cap', 'con', CONNECTION_THROUGHPUT),
      new Connection(2, 'con', 'sol', CONNECTION_THROUGHPUT),
    ]);
    const grid = new Grid();
    grid.rebuild(nodes, adj);
    const summary = grid.powerSummaryFor('sol');
    expect(summary.powered).toBe(true);
    expect(summary.netPower).toBe(80); // capital 50 + solar 30
    expect(grid.sameComponent('cap', 'sol')).toBe(true);
  });

  it('componentMembers + forEachComponent expose each built component once', () => {
    const cap = capital('cap', 0, 0);
    const con = connector('con', 300, 0);
    const sol = solar('sol', 600, 0);
    const lone = solar('lone', 5000, 0); // separate island (no link)
    const nodes = new Map([['cap', cap], ['con', con], ['sol', sol], ['lone', lone]]);
    const adj = adjacencyFrom([
      new Connection(1, 'cap', 'con', CONNECTION_THROUGHPUT),
      new Connection(2, 'con', 'sol', CONNECTION_THROUGHPUT),
    ]);
    const grid = new Grid();
    grid.rebuild(nodes, adj);

    // Every member of the cap→con→sol component sees the same membership set.
    expect([...grid.componentMembers('sol')].sort()).toEqual(['cap', 'con', 'sol']);
    expect([...grid.componentMembers('cap')].sort()).toEqual(['cap', 'con', 'sol']);
    expect(grid.componentMembers('lone')).toEqual(['lone']);
    expect(grid.componentMembers('missing')).toEqual([]); // frozen empty on a miss

    // forEachComponent visits both components once, with the right balances.
    const seen: Array<{ size: number; netPower: number; hasCapital: boolean }> = [];
    grid.forEachComponent((members, netPower, hasCapital) =>
      seen.push({ size: members.length, netPower, hasCapital }));
    expect(seen).toHaveLength(2);
    expect(seen).toContainEqual({ size: 3, netPower: 80, hasCapital: true });
    expect(seen).toContainEqual({ size: 1, netPower: 30, hasCapital: false });
  });

  it('a lone built solar (no capital reachable) is unpowered', () => {
    const sol = solar('lone', 0, 0);
    const grid = new Grid();
    grid.rebuild(new Map([['lone', sol]]), new Map());
    const s = grid.powerSummaryFor('lone');
    expect(s.powered).toBe(false);
    expect(s.netPower).toBe(30);
  });

  it('dead-end: an unbuilt connector isolates the leaf behind it', () => {
    const cap = capital('cap', 0, 0);
    const con = connector('con', 300, 0, /*built*/ false); // blueprint
    const sol = solar('sol', 600, 0);
    const nodes = new Map([['cap', cap], ['con', con], ['sol', sol]]);
    const adj = adjacencyFrom([
      new Connection(1, 'cap', 'con', CONNECTION_THROUGHPUT),
      new Connection(2, 'con', 'sol', CONNECTION_THROUGHPUT),
    ]);
    const grid = new Grid();
    grid.rebuild(nodes, adj);
    // Capital is its own component; solar can't be reached THROUGH the unbuilt
    // connector, so it's unpowered.
    expect(grid.powerSummaryFor('sol').powered).toBe(false);
    expect(grid.sameComponent('cap', 'sol')).toBe(false);
  });

  it('route reaches an unbuilt blueprint as a destination (but not through it)', () => {
    const cap = capital('cap', 0, 0);
    const con = connector('con', 300, 0, /*built*/ false); // blueprint, destination
    const grid = new Grid();
    const adj = adjacencyFrom([new Connection(1, 'cap', 'con', CONNECTION_THROUGHPUT)]);
    grid.rebuild(new Map([['cap', cap], ['con', con]]), adj);
    expect(grid.route('cap', 'con')).toEqual(['cap', 'con']);

    // A leaf behind the unbuilt connector is NOT routable yet (can't pass
    // through the blueprint).
    const sol = solar('sol', 600, 0);
    const adj2 = adjacencyFrom([
      new Connection(1, 'cap', 'con', CONNECTION_THROUGHPUT),
      new Connection(2, 'con', 'sol', CONNECTION_THROUGHPUT),
    ]);
    grid.rebuild(new Map([['cap', cap], ['con', con], ['sol', sol]]), adj2);
    expect(grid.route('cap', 'sol')).toBeNull();
  });

  it('route traverses through a BUILT connector to the leaf', () => {
    const cap = capital('cap', 0, 0);
    const con = connector('con', 300, 0, true);
    const sol = solar('sol', 600, 0);
    const adj = adjacencyFrom([
      new Connection(1, 'cap', 'con', CONNECTION_THROUGHPUT),
      new Connection(2, 'con', 'sol', CONNECTION_THROUGHPUT),
    ]);
    const grid = new Grid();
    grid.rebuild(new Map([['cap', cap], ['con', con], ['sol', sol]]), adj);
    expect(grid.route('cap', 'sol')).toEqual(['cap', 'con', 'sol']);
  });

  it('rebuild drops the route cache (severed link → no route)', () => {
    const cap = capital('cap', 0, 0);
    const con = connector('con', 300, 0, true);
    const linked = adjacencyFrom([new Connection(1, 'cap', 'con', CONNECTION_THROUGHPUT)]);
    const grid = new Grid();
    grid.rebuild(new Map([['cap', cap], ['con', con]]), linked);
    expect(grid.route('cap', 'con')).toEqual(['cap', 'con']);
    // Sever: rebuild with no connections.
    grid.rebuild(new Map([['cap', cap], ['con', con]]), new Map());
    expect(grid.route('cap', 'con')).toBeNull();
  });
});
