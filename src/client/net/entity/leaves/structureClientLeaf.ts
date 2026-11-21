/**
 * Structure (pose-core kind 2): a static, damageable world object. Client-side
 * it is asteroid-like — a POLYGON (convexHull) collider built from the SAME
 * `structureHullPoints` the renderer draws (unified-hull plan), LOCKED in
 * predWorld and posed from the packet, so the client collision hull matches the
 * rendered silhouette AND the server collider (which is built from the same
 * points). No AI, no client shield layer. Damage is server-authoritative
 * through the existing swarm path (EntityResolver → StructureEntity), so there
 * is nothing damage-specific here — the "structure for free" payoff (B5).
 *
 * Hologram pass-through (base loop 3F2): a blueprint's body is a ghost
 * (`BLUEPRINT_COLLISION_GROUPS`, no rig) exactly while the server's is, read
 * from the room-state row (`ghostBody`) through the shared
 * `isStructureBodySolid`. Ghost → solid runs the server's `solidifyStructure`
 * steps (default groups, then the rig).
 */
import { ClientEntityLeafBase } from '../ClientEntityLeafBase.js';
import type { ClientSpawnCtx, ClientSyncCtx } from '../IClientEntityLeaf.js';
import { structureHullPoints } from '../../../../shared-types/structureKinds.js';
import { gateColliderPolygons } from '../../../../core/structures/gateGeometry.js';
import { rigForStructureKind } from '../../../../core/articulation/rigCatalogue.js';
import { isStructureBodySolid } from '../../../../core/structures/structureBody.js';
import { BLUEPRINT_COLLISION_GROUPS, DEFAULT_COLLISION_GROUPS } from '../../../../core/physics/collisionGroups.js';

/** Structure predWorld mass — matches the pre-refactor hardcoded `3` for any
 *  non-drone kind. */
const STRUCTURE_MASS = 3;

/** Is `ctx`'s structure body solid? The room-state row decides; no row yet
 *  (or no structure state at all) ⇒ the wire default, solid. */
function bodySolid(ctx: ClientSpawnCtx): boolean {
  const row = ctx.structures?.get(ctx.entityId);
  return row === undefined || isStructureBodySolid(row);
}

/** Is `ctx`'s structure placed mirrored (build mirror)? The room-state row
 *  decides; no row yet ⇒ unmirrored (rebuilt once when the row says so). */
function bodyMirrored(ctx: ClientSpawnCtx): boolean {
  return ctx.structures?.get(ctx.entityId)?.mirror === true;
}

export class StructureClientLeaf extends ClientEntityLeafBase {
  /** predWorld keys whose body is currently a ghost (set on spawn, so a
   *  re-streamed body starts clean). */
  private readonly ghostKeys = new Set<string>();
  /** predWorld keys whose body was built mirrored (set on spawn). */
  private readonly mirroredKeys = new Set<string>();

  constructor() {
    super('structure');
  }

  spawnBody(ctx: ClientSpawnCtx): void {
    this.forgetPose(ctx.key);
    const solid = bodySolid(ctx);
    const mirror = bodyMirrored(ctx);
    if (mirror) this.mirroredKeys.add(ctx.key);
    else this.mirroredKeys.delete(ctx.key);
    // Polygon hull from the single hull-points source — a convexHull collider
    // matching the silhouette (and the server collider built from the same
    // points), replacing the old circular collider.
    const vertices = structureHullPoints(ctx.entry.shipKind, ctx.entry.radius);
    // Gates: the posts (and airlock walls) as separate parts, matching the
    // server body, so the local ship can fly through the gap (#15). Flipped
    // with the build mirror exactly as `SwarmSpawner.spawnStructure` does
    // (the Shipyard's parts are lopsided).
    const parts = gateColliderPolygons(ctx.entry.shipKind, mirror) ?? undefined;
    ctx.predWorld.spawnObstacle(
      ctx.key,
      ctx.entry.x,
      ctx.entry.y,
      ctx.entry.radius,
      STRUCTURE_MASS,
      vertices,
      0,
      solid ? undefined : BLUEPRINT_COLLISION_GROUPS,
      parts,
    );
    ctx.predWorld.lockBody(ctx.key); // static server-side
    if (solid) {
      this.ghostKeys.delete(ctx.key);
      this.attachRig(ctx);
    } else {
      this.ghostKeys.add(ctx.key); // a hologram has no solid rig parts
    }
  }

  onSync(ctx: ClientSyncCtx): void {
    const solid = bodySolid(ctx);
    if (bodyMirrored(ctx) !== this.mirroredKeys.has(ctx.key)) {
      // The swarm entry spawned the body before its row said mirrored (or the
      // flag changed): rebuild ONCE with the flipped parts. spawnBody also
      // re-reads the ghost state, so this covers a ghost change too.
      ctx.predWorld.despawnShip(ctx.key);
      this.spawnBody(ctx);
    } else if (solid === this.ghostKeys.has(ctx.key)) {
      if (solid) {
        // The server's `solidifyStructure`: default groups, then the rig.
        this.ghostKeys.delete(ctx.key);
        ctx.predWorld.setCollisionGroups(ctx.key, DEFAULT_COLLISION_GROUPS);
        this.attachRig(ctx);
      } else {
        // Spawned solid before its row said ghost: rebuild it as a ghost
        // (drops the rig parts with the body).
        ctx.predWorld.despawnShip(ctx.key);
        this.spawnBody(ctx);
      }
    }
    // An unchanged packet pose writes nothing: a big base is re-synced on
    // every swarm packet, and its locked bodies never move on their own.
    this.reposeIfMoved(ctx);
  }

  /** Rig solid parts (structure-restyle 2d): the same `attachRig` the server
   *  worker runs on RIG_ATTACH, so predWorld has the same kinematic bodies
   *  (#15). They rest until a clip is set (slice 2e wires the clip record). */
  private attachRig(ctx: ClientSpawnCtx): void {
    const rig = ctx.entry.shipKind ? rigForStructureKind(ctx.entry.shipKind) : null;
    if (rig) ctx.predWorld.attachRig(ctx.key, rig);
  }
}
