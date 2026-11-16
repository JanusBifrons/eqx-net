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
import { structureDraw } from '../../shared-types/structurePower.js';
import {
  getStructureKind,
  type StructureKindId,
  structureHalfExtents,
} from '../../shared-types/structureKinds.js';
import { effectiveStructureMaxConnections } from '../../core/leveling/structureLevel.js';
import { isShieldEmitterKind } from '../../core/structures/gateGeometry.js';
import { CONNECTION_MAX_RANGE } from '../../core/structures/structureGridConstants.js';
import { rockObstacleParts, type GridNode, type GridObstacle, type ObstacleBox } from '../../core/structures/Grid.js';
import type {
  StructureRenderState,
  SwarmRenderState,
} from '../../core/contracts/IRenderer.js';
import { generateAsteroidVertices } from '../../core/swarm/asteroidShape.js';
import type { FieldRockBody } from '../../core/terrain/chunkStreamer.js';

type ObstacleParts = NonNullable<GridObstacle['parts']>;

/** A field rock of a loaded chunk, at rest or at its moved pose (C5h). */
export interface RestingFieldRock { key: number; x: number; y: number; angle: number; radius: number }

/** Where a cut-field rock's body comes from (the renderer's `CutFieldLayer`,
 *  from its loaded chunks); null ⇒ not loaded here. */
export interface FieldRockBodySource {
  rockBody(key: number): FieldRockBody | null;
  /** C5h: the loaded rocks reaching into `box` (consumed skipped, moved at
   *  their pose) into the pooled `out`; returns the count. */
  restingRocksInBox?(box: ObstacleBox, out: RestingFieldRock[]): number;
  /** Changes whenever the loaded chunks do (the resting-rock cache key). */
  readonly version?: number;
}

/** Most rocks a shape cache holds before it starts over (bounds memory). */
const ROCK_SHAPE_CACHE_MAX = 4096;
/** The resting-rock box snaps outward to this grid, so a ghost nudged a few
 *  units reuses the last scan (a bigger box only adds real rocks off the
 *  links, which block nothing). */
export const RESTING_BOX_SNAP = 256;

/**
 * The client's rock shapes for the link preview's line of sight (C5c, #15):
 * per swarm asteroid, the `parts` the server's obstacle has, built once per
 * rock with the shared `rockObstacleParts` from what the client already holds
 * (an awake field rock's cut body by its `fieldKey`; an ordinary asteroid's
 * outline from `shapeSeed` + `radius`, as its predWorld body and sprite).
 * Cached by those keys, not the entry (the worker's mirror is a fresh clone
 * each frame), so the per-frame preview allocates only for a rock it has not
 * seen (#14).
 */
export class RockObstacleShapes {
  fieldRocks: FieldRockBodySource | null = null;
  private readonly field = new Map<number, ObstacleParts>();
  private readonly seeded = new Map<number, { radius: number; parts: ObstacleParts }>();
  /** C5h: field rock keys seen on the swarm wire this call (scratch). */
  readonly wireKeys = new Set<number>();
  /** C5h: the last resting-rock scan, for `restBox` at `restVersion`. */
  private readonly resting: RestingFieldRock[] = [];
  private restingN = 0;
  private readonly restBox: ObstacleBox = { x0: NaN, y0: NaN, x1: NaN, y1: NaN };
  private restVersion = -1;
  private restSource: FieldRockBodySource | null = null;

  partsFor(e: SwarmRenderState): ObstacleParts | undefined {
    return e.fieldKey !== undefined ? this.fieldParts(e.fieldKey) : this.seededParts(e);
  }

  /** A field rock's parts from its cut body, built once per rock (#15). */
  fieldParts(key: number): ObstacleParts | undefined {
    const hit = this.field.get(key);
    if (hit !== undefined) return hit;
    const body = this.fieldRocks?.rockBody(key) ?? null;
    if (body === null) return undefined; // not cut here yet: the box
    const parts = rockObstacleParts(body.verts, body.parts, true)!;
    if (this.field.size >= ROCK_SHAPE_CACHE_MAX) this.field.clear();
    this.field.set(key, parts);
    return parts;
  }

  /** The loaded field rocks reaching into `box` (snapped outward), rescanned
   *  only when the snapped box or the loaded chunks change (#14). Read them
   *  with `restingAt(i)`, i below the count returned. */
  restingInBox(box: ObstacleBox): number {
    const src = this.fieldRocks;
    if (!src?.restingRocksInBox) return 0;
    const x0 = Math.floor(box.x0 / RESTING_BOX_SNAP) * RESTING_BOX_SNAP;
    const y0 = Math.floor(box.y0 / RESTING_BOX_SNAP) * RESTING_BOX_SNAP;
    const x1 = Math.ceil(box.x1 / RESTING_BOX_SNAP) * RESTING_BOX_SNAP;
    const y1 = Math.ceil(box.y1 / RESTING_BOX_SNAP) * RESTING_BOX_SNAP;
    const b = this.restBox, v = src.version ?? 0;
    if (src === this.restSource && v === this.restVersion && x0 === b.x0 && y0 === b.y0 && x1 === b.x1 && y1 === b.y1) return this.restingN;
    b.x0 = x0; b.y0 = y0; b.x1 = x1; b.y1 = y1;
    this.restSource = src;
    this.restVersion = v;
    this.restingN = src.restingRocksInBox(b, this.resting);
    return this.restingN;
  }

  restingAt(i: number): RestingFieldRock { return this.resting[i]!; }

  private seededParts(e: SwarmRenderState): ObstacleParts | undefined {
    if (e.shapeSeed === undefined) return undefined;
    const hit = this.seeded.get(e.shapeSeed);
    if (hit !== undefined && hit.radius === e.radius) return hit.parts;
    const parts = rockObstacleParts(generateAsteroidVertices(e.shapeSeed, e.radius), undefined, false)!;
    if (this.seeded.size >= ROCK_SHAPE_CACHE_MAX) this.seeded.clear();
    this.seeded.set(e.shapeSeed, { radius: e.radius, parts });
    return parts;
  }
}

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
  // Phase V — the rotated footprint box (the structure's swarm angle carries
  // its quarter-turn rotation). Must match the server's structureToGridNode.
  const ext = structureHalfExtents(swarmEntry.shipKind, (swarmEntry.angle * 180) / Math.PI);
  out.halfW = ext.hw;
  out.halfH = ext.hh;
  out.isHub = kind.isHub;
  out.isCapital = swarmEntry.shipKind === 'capital';
  out.isConnector = swarmEntry.shipKind === 'connector';
  out.isShieldPylon = isShieldEmitterKind(swarmEntry.shipKind);
  // Leveled connection cap — an upgraded connector holds MORE links (Equinox
  // Phase-5 audit). Must match the server's `structureToGridNode` so the preview
  // + the live grid agree.
  out.maxConnections = effectiveStructureMaxConnections(kind.maxConnections, structureState.level);
  out.connectionRange = kind.connectionRange;
  // D1 — a Reactor with no fuel produces nothing (the server's same rule).
  out.powerOutput = structureState.built && structureState.noFuel !== true ? kind.powerOutput : 0;
  // Active power — the server's same rule (full while active, else idle trickle).
  out.powerConsumption = structureState.built ? structureDraw(kind.powerConsumption, structureState.drawFull === true) : 0;
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
  preview: { kind: string; x: number; y: number; angle?: number },
  out: GridNode,
): GridNode {
  const kind = getStructureKind(preview.kind as StructureKindId);
  out.id = GHOST_NODE_ID;
  out.x = preview.x;
  out.y = preview.y;
  out.radius = kind.radius;
  const ext = structureHalfExtents(preview.kind, ((preview.angle ?? 0) * 180) / Math.PI);
  out.halfW = ext.hw;
  out.halfH = ext.hh;
  out.isHub = kind.isHub;
  out.isCapital = preview.kind === 'capital';
  out.isConnector = preview.kind === 'connector';
  out.isShieldPylon = isShieldEmitterKind(preview.kind);
  out.maxConnections = kind.maxConnections;
  out.connectionRange = kind.connectionRange;
  // A blueprint is inert until built; the ghost isn't placed yet.
  out.powerOutput = 0;
  out.powerConsumption = 0;
  out.isConstructed = false;
  return out;
}

/**
 * The box every candidate link of `ghost` lies in, written into `out` (C5h,
 * the preview's twin of the server's `linkReachBox`): a partner's centre is
 * within `CONNECTION_MAX_RANGE` of the ghost's edge plus the partner's own
 * extent, `partnerExt` the widest partner's. Field rocks reaching into it
 * join the preview's obstacles, as the server's dormant rocks do.
 */
export function linkReachBoxOf(ghost: GridNode, partnerExt: number, out: ObstacleBox): ObstacleBox {
  const reach = CONNECTION_MAX_RANGE + Math.max(ghost.halfW ?? ghost.radius, ghost.halfH ?? ghost.radius) + partnerExt;
  out.x0 = ghost.x - reach; out.y0 = ghost.y - reach;
  out.x1 = ghost.x + reach; out.y1 = ghost.y + reach;
  return out;
}

/**
 * Fill `out` IN PLACE with one `GridObstacle` per asteroid (swarm `kind === 0`),
 * resetting its length first (invariant #14 — the renderer owns a module-scratch
 * array and reuses it every frame; never allocates). The obstacle objects
 * themselves are pooled in `out` across frames — only their fields are rewritten.
 *
 * Mirrors the server's asteroid → `GridObstacle` projection
 * (`SectorRoom.gatherStructureObstacles`): the square box as broad phase, and
 * with `shapes` the rock's convex `parts` at its `angle` (C5c), the same
 * `rockObstacleParts` the server builds. Without `shapes` (or a rock whose
 * shape this client lacks) the box alone: never a false green.
 *
 * With `box` (C5h, the server's `dormantObstacles` twin) it also adds the
 * cut-field rocks of the loaded chunks reaching into `box` that are not on
 * the swarm wire (sleeping in their chunk: drawn, but no swarm record), at
 * rest or at their moved pose, consumed ones skipped, with their parts from
 * the same cut body; a rock on the wire counts once, at its wire pose.
 * Returns the same `out` for chaining.
 */
export function asteroidObstaclesFromSwarm(
  swarm: ReadonlyMap<number, SwarmRenderState>,
  out: GridObstacle[],
  shapes?: RockObstacleShapes,
  box?: ObstacleBox,
): GridObstacle[] {
  let n = 0;
  const wire = box !== undefined ? shapes?.wireKeys : undefined;
  wire?.clear();
  for (const entry of swarm.values()) {
    if (entry.kind !== SWARM_KIND_ASTEROID) continue;
    if (wire !== undefined && entry.fieldKey !== undefined) wire.add(entry.fieldKey);
    let o = out[n];
    if (o === undefined) {
      o = { x: 0, y: 0, radius: 0 };
      out[n] = o;
    }
    o.x = entry.x;
    o.y = entry.y;
    o.radius = entry.radius;
    o.angle = entry.angle;
    o.parts = shapes?.partsFor(entry);
    n++;
  }
  if (box !== undefined && shapes !== undefined && wire !== undefined) {
    const k = shapes.restingInBox(box);
    for (let i = 0; i < k; i++) {
      const r = shapes.restingAt(i);
      if (wire.has(r.key)) continue;
      let o = out[n];
      if (o === undefined) {
        o = { x: 0, y: 0, radius: 0 };
        out[n] = o;
      }
      o.x = r.x;
      o.y = r.y;
      o.radius = r.radius;
      o.angle = r.angle;
      o.parts = shapes.fieldParts(r.key);
      n++;
    }
  }
  // Trim any stale obstacles from a previous (denser) frame without releasing
  // the backing store — keep the pooled objects, just shorten the view.
  out.length = n;
  return out;
}
