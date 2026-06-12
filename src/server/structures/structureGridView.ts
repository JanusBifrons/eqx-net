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
import { CONNECTION_THROUGHPUT } from '../../core/structures/structureGridConstants.js';
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

/**
 * Auto-connect a freshly-placed structure into its owner's grid: link it to the
 * NEAREST in-range hub (Connector / Capital) with a free slot that passes
 * `canConnect`. If none qualifies, the structure stays unconnected (renders
 * dimmed/unpowered) until the player drops a Connector to bridge it — exactly
 * The Space Game's relay workflow. Returns the connected neighbour id, or null.
 *
 * Only links structures owned by the SAME player (connections are per-owner,
 * intra-sector).
 *
 * `obstacles` (Item D) — non-structure bodies (asteroids) that block a
 * connection's line of sight. Optional: omitting it falls back to the
 * structures-only LOS check (byte-identical to pre-Item-D).
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

  let best: string | null = null;
  let bestDist = Infinity;
  for (const other of registry.all()) {
    if (other.id === newId) continue;
    if (other.owner !== newRec.owner) continue; // per-owner grid
    const otherNode = nodes.get(other.id)!;
    if (!canConnect(newNode, otherNode, adjacency, nodes, obstacles).ok) continue;
    const d = edgeDistance(newNode, otherNode);
    if (d < bestDist) {
      bestDist = d;
      best = other.id;
    }
  }
  if (best === null) return null;
  registry.addConnection(newId, best, CONNECTION_THROUGHPUT);
  return best;
}
