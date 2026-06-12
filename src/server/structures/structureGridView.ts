/**
 * Projects the server-side `StructureRegistry` into the zone-pure `GridNode`
 * view the core `Grid` consumes, and the auto-connect-on-place helper
 * (speed-dial-resource-structures plan, Phase 3).
 *
 * The `isConstructed` gate lives here: a blueprint projects `powerOutput /
 * powerConsumption = 0` (inert until built), so the grid never counts a
 * half-built node's power.
 */
import { getStructureKind } from '../../shared-types/structureKinds.js';
import {
  canConnect,
  edgeDistance,
  type GridNode,
  type GridObstacle,
} from '../../core/structures/Grid.js';
import {
  CONNECTION_THROUGHPUT,
  PLACEMENT_MAX_CONNECTIONS,
} from '../../core/structures/structureGridConstants.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';

export function structureToGridNode(rec: StructureRecord): GridNode {
  const kind = getStructureKind(rec.kind);
  return {
    id: rec.id,
    x: rec.x,
    y: rec.y,
    radius: rec.radius,
    isHub: kind.isHub,
    isCapital: rec.kind === 'capital',
    isConnector: rec.kind === 'connector',
    maxConnections: kind.maxConnections,
    connectionRange: kind.connectionRange,
    // The isConstructed gate: a blueprint is inert (0 power) until built.
    powerOutput: rec.isConstructed ? kind.powerOutput : 0,
    powerConsumption: rec.isConstructed ? kind.powerConsumption : 0,
    isConstructed: rec.isConstructed,
  };
}

/** Build the full `Map<id, GridNode>` from the registry. */
export function buildGridNodes(registry: StructureRegistry): Map<string, GridNode> {
  const nodes = new Map<string, GridNode>();
  for (const rec of registry.all()) nodes.set(rec.id, structureToGridNode(rec));
  return nodes;
}

/** One auto-connect candidate: an in-range, legal hub the new structure may link
 *  to, with its edge-distance for the deterministic (distance, id) ordering. */
interface ConnectCandidate {
  id: string;
  dist: number;
}

/**
 * Auto-connect a freshly-placed structure into its owner's grid (WS-5 / R2.17 —
 * MULTI-connect). Link it to EVERY in-range hub (Connector / Capital) with a free
 * slot that passes `canConnect`, in deterministic (distance, id) order, until the
 * new structure's own `maxConnections` OR the global `PLACEMENT_MAX_CONNECTIONS`
 * cap is reached. A leaf (cap 1) therefore still connects to exactly the nearest
 * hub — the multi-connect only widens hubs (a Connector fans out to up to 6).
 * If none qualifies, the structure stays unconnected (renders dimmed/unpowered)
 * until the player drops a Connector to bridge it — The Space Game's relay
 * workflow. Returns the NEAREST connected neighbour id (backward-compatible with
 * the old single-id return), or null.
 *
 * Only links structures owned by the SAME player (connections are per-owner,
 * intra-sector).
 *
 * `obstacles` (Item D) — non-structure bodies (asteroids) that block a
 * connection's line of sight. Optional: omitting it falls back to the
 * structures-only LOS check (byte-identical to pre-Item-D).
 *
 * Placement is a low-frequency wire event (not a 60 Hz tick) and grids are small
 * (cap ≤ 6), so the gather + sort + per-iteration `canConnect` re-check is not a
 * hot-loop allocation concern (invariant #14). The per-iteration re-check is
 * load-bearing: each `addConnection` mutates the LIVE `adjacency` view, so a hub
 * that was free may fill AND the new node's own slot count rises as it connects.
 */
export function autoConnectStructure(
  registry: StructureRegistry,
  newId: string,
  obstacles?: readonly GridObstacle[],
): string | null {
  const newRec = registry.get(newId);
  if (!newRec) return null;
  const nodes = buildGridNodes(registry);
  const adjacency = registry.adjacencyMap();
  const newNode = nodes.get(newId)!;

  // Gather every legal, in-range hub the new structure could link to right now.
  const candidates: ConnectCandidate[] = [];
  for (const other of registry.all()) {
    if (other.id === newId) continue;
    if (other.owner !== newRec.owner) continue; // per-owner grid
    const otherNode = nodes.get(other.id)!;
    if (!canConnect(newNode, otherNode, adjacency, nodes, obstacles).ok) continue;
    candidates.push({ id: other.id, dist: edgeDistance(newNode, otherNode) });
  }
  if (candidates.length === 0) return null;
  // Deterministic order: nearest first, ties broken by id (no Map-iteration
  // flake — placement must be reproducible across runs).
  candidates.sort((p, q) => p.dist - q.dist || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));

  let firstConnected: string | null = null;
  let made = 0;
  for (const cand of candidates) {
    if (made >= PLACEMENT_MAX_CONNECTIONS) break;
    const otherNode = nodes.get(cand.id)!;
    // Re-check against the live adjacency: an earlier addition may have filled
    // this hub or the new node's own slots.
    if (!canConnect(newNode, otherNode, adjacency, nodes, obstacles).ok) continue;
    registry.addConnection(newId, cand.id, CONNECTION_THROUGHPUT);
    made++;
    if (firstConnected === null) firstConnected = cand.id;
  }
  return firstConnected;
}
