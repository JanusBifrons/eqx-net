/**
 * The power/logistics grid (speed-dial-resource-structures plan, Phase 3).
 * Zone-pure, injected — mirrors eqx-peri's `GridManager`. Operates over an
 * abstract `GridNode` view of the structures plus the `Connection` adjacency
 * map, so it never reaches into the server's `StructureRegistry`.
 *
 * Two responsibilities:
 *   1. `canConnect` — the eqx-peri hub model: who may link to whom.
 *   2. The grid analysis the 1 Hz pulse reads: BFS connected components (power
 *      aggregation) + A* routing for the construction / hauling streams.
 *
 * **Dead-end rule (load-bearing, eqx-peri verbatim):** an UNCONSTRUCTED node is
 * a dead end — reachable as a transfer *destination* (so it can receive the
 * minerals that build it) but NOT traversable (you cannot relay power/resources
 * *through* a half-built node). This forces outward sequential expansion:
 * Capital → Connector (completes) → leaves behind it.
 *
 * Rebuild is O(V+E) and runs ONLY when topology changes (`topologyDirty`), never
 * per physics tick. The route cache is dropped on every rebuild.
 */
import { Connection, connectionLength } from './Connection.js';
import { CONNECTION_MAX_RANGE } from './structureGridConstants.js';

/** The grid's abstract view of a structure. The server projects each
 *  `StructureRecord` (+ its catalogue kind) into one of these. */
export interface GridNode {
  id: string;
  x: number;
  y: number;
  radius: number;
  /** Connector / Capital — at least one endpoint of every link must be a hub. */
  isHub: boolean;
  /** The grid root + storage source (the Capital). Drives `powered`. */
  isCapital: boolean;
  /** WS-5 (R2.10) — true for the Connector kind specifically. The Capital may
   *  ONLY link to a Connector (`capital-only` rule); `isHub && !isCapital` is
   *  NOT a sufficient test because Shield Pylons are also non-capital hubs, and
   *  the rule is Connectors-ONLY. Projected from the kind by each view. */
  isConnector: boolean;
  /** Per-kind connection cap (Connector 6, Capital 4, leaves 1). */
  maxConnections: number;
  /** WS-5 (R2.10) — per-kind max edge-to-edge connection range (world units).
   *  ABSENT ⇒ the global `CONNECTION_MAX_RANGE`. `canConnect` uses the `min` of
   *  the two endpoints' ranges (symmetric). Only the Capital sets it today. */
  connectionRange?: number;
  /** Inert (0) until built — the `isConstructed` gate is the caller's job to
   *  reflect here (a blueprint should project `powerOutput/Consumption = 0`). */
  powerOutput: number;
  powerConsumption: number;
  /** Blueprints are dead-ends in traversal (see file docstring). */
  isConstructed: boolean;
}

export type CanConnectReason =
  | 'self'
  | 'duplicate'
  | 'hub-required'
  | 'capital-only'
  | 'a-full'
  | 'b-full'
  | 'out-of-range'
  | 'blocked';

export type CanConnectResult = { ok: true } | { ok: false; reason: CanConnectReason };

export interface PowerSummary {
  netPower: number;
  powered: boolean;
}

/** A non-structure body that blocks a connection's line of sight (Item D —
 *  asteroids). Treated as a square AABB (half-extent = `radius`) so it reuses
 *  the same `segmentIntersectsAabb` test the structure-node LOS check uses.
 *  The server projects each swarm kind=0 record (pose from the SAB, radius from
 *  the registry) into one of these. */
export interface GridObstacle {
  x: number;
  y: number;
  radius: number;
}

/** Edge-to-edge distance between two nodes' square AABBs (half-extent =
 *  radius). Returns 0 when the boxes overlap or touch — eqx-peri's
 *  `edgeDistance`. */
export function edgeDistance(a: GridNode, b: GridNode): number {
  const dx = Math.max(0, Math.abs(a.x - b.x) - (a.radius + b.radius));
  const dy = Math.max(0, Math.abs(a.y - b.y) - (a.radius + b.radius));
  return Math.hypot(dx, dy);
}

/** Segment (x0,y0)-(x1,y1) vs AABB [minX,minY]-[maxX,maxY] (Liang–Barsky slab
 *  clip). */
export function segmentIntersectsAabb(
  x0: number, y0: number, x1: number, y1: number,
  minX: number, minY: number, maxX: number, maxY: number,
): boolean {
  const dx = x1 - x0;
  const dy = y1 - y0;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0; // parallel: inside iff q >= 0
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  if (!clip(-dx, x0 - minX)) return false;
  if (!clip(dx, maxX - x0)) return false;
  if (!clip(-dy, y0 - minY)) return false;
  if (!clip(dy, maxY - y0)) return false;
  return t0 <= t1;
}

/** True if the segment between two nodes' centres passes through any OTHER
 *  node's body, or (Item D) through any non-structure `obstacle` (asteroid).
 *  `obstacles` is OPTIONAL — omitting it is byte-identical to the structures-
 *  only behaviour, so existing callers/tests are unaffected. */
export function isConnectionLineBlocked(
  a: GridNode,
  b: GridNode,
  nodes: ReadonlyMap<string, GridNode>,
  obstacles?: readonly GridObstacle[],
): boolean {
  for (const n of nodes.values()) {
    if (n.id === a.id || n.id === b.id) continue;
    if (
      segmentIntersectsAabb(
        a.x, a.y, b.x, b.y,
        n.x - n.radius, n.y - n.radius, n.x + n.radius, n.y + n.radius,
      )
    ) {
      return true;
    }
  }
  if (obstacles) {
    for (const o of obstacles) {
      if (
        segmentIntersectsAabb(
          a.x, a.y, b.x, b.y,
          o.x - o.radius, o.y - o.radius, o.x + o.radius, o.y + o.radius,
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The hub model — who may connect to whom. Ports eqx-peri's rules exactly:
 * hub-required, per-kind connection cap, edge-to-edge range, no self / no
 * duplicate, line-of-sight.
 */
export function canConnect(
  a: GridNode,
  b: GridNode,
  adjacency: ReadonlyMap<string, readonly Connection[]>,
  nodes: ReadonlyMap<string, GridNode>,
  obstacles?: readonly GridObstacle[],
): CanConnectResult {
  if (a.id === b.id) return { ok: false, reason: 'self' };
  // Hub rule: at least one endpoint must be a Connector or the Capital. A leaf
  // can NEVER attach to another leaf.
  if (!a.isHub && !b.isHub) return { ok: false, reason: 'hub-required' };

  // WS-5 (R2.10) — capital-only-connectors: the Capital may ONLY link to a
  // Connector. Anything else attaching to it (a leaf, OR a non-connector hub
  // such as a Shield Pylon) is rejected — route through a Connector relay. This
  // is checked BEFORE the cap/duplicate gates so the reason is unambiguous (a
  // leaf at a full Capital reads `capital-only`, not `a-full`).
  if ((a.isCapital && !b.isConnector) || (b.isCapital && !a.isConnector)) {
    return { ok: false, reason: 'capital-only' };
  }

  const aConns = adjacency.get(a.id) ?? [];
  if (aConns.some((c) => c.getOtherNode(a.id) === b.id)) {
    return { ok: false, reason: 'duplicate' };
  }
  if (aConns.length >= a.maxConnections) return { ok: false, reason: 'a-full' };
  const bConns = adjacency.get(b.id) ?? [];
  if (bConns.length >= b.maxConnections) return { ok: false, reason: 'b-full' };

  // P3.2 — UNIFORM range: every kind uses the global CONNECTION_MAX_RANGE (the
  // R2.10 Capital short-reach was reverted, "everything has the same range").
  // `connectionRange` stays an optional per-kind override seam (the `min` of the
  // two endpoints, symmetric) but no kind sets it today, so this collapses to
  // the global for every pair.
  const maxRange = Math.min(
    a.connectionRange ?? CONNECTION_MAX_RANGE,
    b.connectionRange ?? CONNECTION_MAX_RANGE,
  );
  if (edgeDistance(a, b) > maxRange) return { ok: false, reason: 'out-of-range' };
  if (isConnectionLineBlocked(a, b, nodes, obstacles)) return { ok: false, reason: 'blocked' };
  return { ok: true };
}

interface ComponentInfo {
  netPower: number;
  hasCapital: boolean;
  members: number;
}

/** Shared empty member list so `componentMembers` never allocates on a miss. */
const NO_MEMBERS: readonly string[] = Object.freeze([]);

export class Grid {
  private nodes: ReadonlyMap<string, GridNode> = new Map();
  private adjacency: ReadonlyMap<string, readonly Connection[]> = new Map();
  private readonly componentOf = new Map<string, number>();
  private readonly componentInfo = new Map<number, ComponentInfo>();
  /** comp id → its member structure ids (for battery charge/discharge + the
   *  shield-wall drain, which both operate over a whole component). */
  private readonly componentMembersMap = new Map<number, string[]>();
  private readonly routeCache = new Map<string, readonly string[] | null>();

  /**
   * Recompute connected components over the BUILT subgraph (unbuilt nodes are
   * dead-ends and get no component). Drops the route cache. Call only when the
   * topology actually changed.
   */
  rebuild(
    nodes: ReadonlyMap<string, GridNode>,
    adjacency: ReadonlyMap<string, readonly Connection[]>,
  ): void {
    this.nodes = nodes;
    this.adjacency = adjacency;
    this.componentOf.clear();
    this.componentInfo.clear();
    this.componentMembersMap.clear();
    this.routeCache.clear();

    let nextComp = 0;
    for (const node of nodes.values()) {
      if (!node.isConstructed) continue;
      if (this.componentOf.has(node.id)) continue;
      const comp = nextComp++;
      const info: ComponentInfo = { netPower: 0, hasCapital: false, members: 0 };
      const memberIds: string[] = [];
      const queue: string[] = [node.id];
      this.componentOf.set(node.id, comp);
      while (queue.length > 0) {
        const cur = queue.pop()!;
        const cn = nodes.get(cur)!;
        info.members++;
        memberIds.push(cur);
        info.netPower += cn.powerOutput - cn.powerConsumption;
        if (cn.isCapital) info.hasCapital = true;
        for (const c of adjacency.get(cur) ?? []) {
          const other = c.getOtherNode(cur);
          if (other === null) continue;
          const on = nodes.get(other);
          // Dead-end rule: do NOT traverse THROUGH an unbuilt node.
          if (!on || !on.isConstructed) continue;
          if (this.componentOf.has(other)) continue;
          this.componentOf.set(other, comp);
          queue.push(other);
        }
      }
      this.componentInfo.set(comp, info);
      this.componentMembersMap.set(comp, memberIds);
    }
  }

  /** Power summary for a structure. Unbuilt / unknown → unpowered, 0 net.
   *  `powered` requires the component to contain a Capital (the grid root) AND
   *  net power ≥ 0 — so a lone generator with no path to a Capital is
   *  unpowered. */
  powerSummaryFor(id: string): PowerSummary {
    const comp = this.componentOf.get(id);
    if (comp === undefined) return { netPower: 0, powered: false };
    const info = this.componentInfo.get(comp)!;
    return { netPower: info.netPower, powered: info.hasCapital && info.netPower >= 0 };
  }

  /** Member structure ids of the component containing `id` (the shared frozen
   *  empty list when `id` is unbuilt / unknown). Read-only — do NOT mutate.
   *  Used by the battery charge/discharge pass and the shield-wall drain, which
   *  operate over a whole connected component. */
  componentMembers(id: string): readonly string[] {
    const comp = this.componentOf.get(id);
    if (comp === undefined) return NO_MEMBERS;
    return this.componentMembersMap.get(comp) ?? NO_MEMBERS;
  }

  /** Iterate each built component exactly once with its member ids + aggregate
   *  generation balance. The callback must not retain `members` past the call. */
  forEachComponent(
    cb: (members: readonly string[], netPower: number, hasCapital: boolean) => void,
  ): void {
    for (const [comp, info] of this.componentInfo) {
      cb(this.componentMembersMap.get(comp) ?? NO_MEMBERS, info.netPower, info.hasCapital);
    }
  }

  /** True if both structures are built and in the same component. */
  sameComponent(aId: string, bId: string): boolean {
    const ca = this.componentOf.get(aId);
    const cb = this.componentOf.get(bId);
    return ca !== undefined && ca === cb;
  }

  /**
   * A* path (inclusive of both endpoints) from `sourceId` to `targetId`,
   * traversable only THROUGH built nodes — `targetId` may be unbuilt (it's the
   * destination). Returns null if no such path. Cached until the next rebuild.
   */
  route(sourceId: string, targetId: string): readonly string[] | null {
    const key = `${sourceId}>${targetId}`;
    const cached = this.routeCache.get(key);
    if (cached !== undefined) return cached;
    const path = this.computeRoute(sourceId, targetId);
    this.routeCache.set(key, path);
    return path;
  }

  private computeRoute(sourceId: string, targetId: string): readonly string[] | null {
    const source = this.nodes.get(sourceId);
    const target = this.nodes.get(targetId);
    if (!source || !target) return null;
    if (sourceId === targetId) return [sourceId];
    // The source must be traversable (a built storage root).
    if (!source.isConstructed) return null;

    const heuristic = (id: string): number => {
      const n = this.nodes.get(id)!;
      return connectionLength(n, target) / CONNECTION_MAX_RANGE;
    };

    const gScore = new Map<string, number>([[sourceId, 0]]);
    const cameFrom = new Map<string, string>();
    const open = new Set<string>([sourceId]);

    while (open.size > 0) {
      // Pop the node with the lowest f = g + h (linear scan — grids are small).
      let cur: string | null = null;
      let bestF = Infinity;
      for (const id of open) {
        const f = (gScore.get(id) ?? Infinity) + heuristic(id);
        if (f < bestF) {
          bestF = f;
          cur = id;
        }
      }
      if (cur === null) break;
      if (cur === targetId) return reconstruct(cameFrom, cur);
      open.delete(cur);

      const curG = gScore.get(cur) ?? Infinity;
      for (const c of this.adjacency.get(cur) ?? []) {
        const next = c.getOtherNode(cur);
        if (next === null) continue;
        const nn = this.nodes.get(next);
        if (!nn) continue;
        // Can step onto `next` only if it's built OR it is the destination.
        if (!nn.isConstructed && next !== targetId) continue;
        const tentative = curG + 1;
        if (tentative < (gScore.get(next) ?? Infinity)) {
          cameFrom.set(next, cur);
          gScore.set(next, tentative);
          open.add(next);
        }
      }
    }
    return null;
  }
}

function reconstruct(cameFrom: ReadonlyMap<string, string>, current: string): string[] {
  const path = [current];
  let cur = current;
  for (;;) {
    const prev = cameFrom.get(cur);
    if (prev === undefined) break;
    path.unshift(prev);
    cur = prev;
  }
  return path;
}
