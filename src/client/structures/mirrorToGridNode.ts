/**
 * Client-side projection of the render mirror into the zone-pure `GridNode` /
 * `GridObstacle` view the core `Grid` consumes — the CLIENT twin of the
 * server's `src/server/structures/structureGridView.ts` (structures follow-up
 * Item C, plan: i-want-you-to-majestic-pie).
 *
 * This lets the connection-range PREVIEW (drawn while the player is positioning
 * a blueprint ghost) call the SAME obstacle-aware `canConnect` the server runs
 * on placement, so the preview matches what the server will actually do — no
 * re-derived blocking heuristic.
 *
 * Pure: no Pixi, no I/O. The radius / hub / cap facts come from the structure
 * catalogue exactly like the server's `structureToGridNode` (which reads
 * `kind.radius` etc.), so the two projections agree by construction.
 *
 * Invariant #14: `asteroidObstaclesFromSwarm` fills a CALLER-OWNED scratch array
 * in place (never allocates) and `structureMirrorToGridNode` / `ghostToGridNode`
 * write into a CALLER-OWNED `GridNode` (the renderer reuses one ghost node + a
 * small pool of structure nodes across frames).
 */
import {
  getStructureKind,
  type StructureKindId,
} from '../../shared-types/structureKinds.js';
import type { GridNode, GridObstacle } from '../../core/structures/Grid.js';
import type {
  StructureRenderState,
  SwarmRenderState,
} from '../../core/contracts/IRenderer.js';

/** 0 = asteroid in the swarm-channel `kind` byte (drone=1, structure=2). */
const SWARM_KIND_ASTEROID = 0;

/**
 * Project a placed structure (its grid slice + its swarm pose entry) into a
 * `GridNode`, writing into the caller-owned `out` (invariant #14 — the renderer
 * reuses a pooled node per structure). `id` is the stringified entityId (the
 * Grid keys nodes by string, matching the server's `rec.id`).
 *
 * Mirrors `server/structures/structureGridView.ts#structureToGridNode`:
 * isHub / maxConnections / radius come from the catalogue; the `isConstructed`
 * gate zeroes a blueprint's power (preview only reads topology, but we keep the
 * gate so the projection is faithful). Pose comes from the swarm entry (the
 * structure's authoritative position — structures are static).
 */
export function structureMirrorToGridNode(
  id: string,
  structureState: StructureRenderState,
  swarmEntry: SwarmRenderState,
  out: GridNode,
): GridNode {
  const kind = getStructureKind(swarmEntry.shipKind);
  out.id = id;
  out.x = swarmEntry.x;
  out.y = swarmEntry.y;
  out.radius = kind.radius;
  out.isHub = kind.isHub;
  out.isCapital = swarmEntry.shipKind === 'capital';
  out.isConnector = swarmEntry.shipKind === 'connector';
  out.maxConnections = kind.maxConnections;
  out.connectionRange = kind.connectionRange;
  out.powerOutput = structureState.built ? kind.powerOutput : 0;
  out.powerConsumption = structureState.built ? kind.powerConsumption : 0;
  out.isConstructed = structureState.built;
  return out;
}

/**
 * Project the placement ghost into a `GridNode`, writing into the caller-owned
 * `out` (invariant #14 — the renderer reuses ONE ghost node across frames). The
 * ghost is the "node `a`" passed to `canConnect`: it has no id collision with
 * any real structure (the reserved `__ghost__` id) and no adjacency, so it can
 * never be a duplicate of an existing link.
 *
 * radius / hub / cap / capital come from the catalogue — identical to how the
 * server projects a freshly-placed structure, so the preview's range + hub
 * eligibility match the post-placement `autoConnectStructure`.
 */
export const GHOST_NODE_ID = '__ghost__';

export function ghostToGridNode(
  preview: { kind: string; x: number; y: number },
  out: GridNode,
): GridNode {
  const kind = getStructureKind(preview.kind as StructureKindId);
  out.id = GHOST_NODE_ID;
  out.x = preview.x;
  out.y = preview.y;
  out.radius = kind.radius;
  out.isHub = kind.isHub;
  out.isCapital = preview.kind === 'capital';
  out.isConnector = preview.kind === 'connector';
  out.maxConnections = kind.maxConnections;
  out.connectionRange = kind.connectionRange;
  // A blueprint is inert until built; the ghost isn't placed yet.
  out.powerOutput = 0;
  out.powerConsumption = 0;
  out.isConstructed = false;
  return out;
}

/**
 * Fill `out` IN PLACE with one `GridObstacle` per asteroid (swarm `kind === 0`),
 * resetting its length first (invariant #14 — the renderer owns a module-scratch
 * array and reuses it every frame; never allocates). The obstacle objects
 * themselves are pooled in `out` across frames — only their fields are rewritten.
 *
 * Mirrors the server's asteroid → `GridObstacle` projection ({ x, y, radius }
 * square AABB) that `isConnectionLineBlocked` clips the connection segment
 * against. Returns the same `out` for chaining.
 */
export function asteroidObstaclesFromSwarm(
  swarm: ReadonlyMap<number, SwarmRenderState>,
  out: GridObstacle[],
): GridObstacle[] {
  let n = 0;
  for (const entry of swarm.values()) {
    if (entry.kind !== SWARM_KIND_ASTEROID) continue;
    let o = out[n];
    if (o === undefined) {
      o = { x: 0, y: 0, radius: 0 };
      out[n] = o;
    }
    o.x = entry.x;
    o.y = entry.y;
    o.radius = entry.radius;
    n++;
  }
  // Trim any stale obstacles from a previous (denser) frame without releasing
  // the backing store — keep the pooled objects, just shorten the view.
  out.length = n;
  return out;
}
