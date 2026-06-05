/**
 * EntityResolver — turns a damage `targetId` into the live `Entity` LEAF it
 * names (Generic Entity Pipeline B2). This is the OOP replacement for
 * `DamageRouter`'s former `resolve(targetId) → DamageKind` + `strategies[kind]`
 * table: instead of a kind string keyed into a side table, it returns a real
 * leaf object that COMPOSES its own `{ health, perHit, death }` strategy. The
 * router then runs ONE monomorphic `applyInteraction` over the leaf.
 *
 * The ORDERED, shape-based lookup is preserved verbatim from the old if-tree
 * (HC#1 — the branch order + each branch's side-effects are load-bearing): wreck
 * prefix → lingering (`!isActive` schema) → active player ship → swarm registry.
 * A swarm record routes by its `kind` byte: drone (1) / structure (2) are
 * damageable leaves; an asteroid (0) is NON-damageable, so the resolver returns
 * `null` (immune — no event), byte-identical to the old swarm branch's
 * `applied:false` short-circuit.
 *
 * Flyweights: one leaf instance per kind, built once in the constructor (zero
 * per-hit allocation, invariant #14). `resolve()` sets the chosen leaf's
 * `target` to the live store object and fills the reused `wireTargetId` /
 * `poseX` / `poseY` scratch; `apply()` is synchronous + single-threaded, so the
 * swapped target is race-free (mirrors the old `_target` scratch).
 *
 * Behaviour is locked byte-identical by `DamageRouter.dispatch.test.ts` (the
 * golden-master, written before the collapse).
 */

import type { MapSchema } from '@colyseus/schema';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import type { ShipState, WreckState } from '../rooms/schema/SectorState.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShieldHullRouter } from '../rooms/ShieldHullRouter.js';
import {
  createActiveShipEntity,
  createLingeringHullEntity,
  createWreckEntity,
  ShipEntity,
  WreckEntity,
  DroneEntity,
  StructureEntity,
  type DamageableLeaf,
  type DamageableSwarmLeaf,
  type LeafDeps,
  type SwarmLeafTarget,
} from './leaves/index.js';

/** Narrow swarm-registry view the resolver reads (a `SwarmDmgRecord` shape). */
export interface ResolverSwarmSource {
  get(id: string): SwarmLeafTarget | null | undefined;
}

/**
 * The deps the resolver needs: the leaf-construction + side-effect seams
 * (`LeafDeps`) plus the per-kind LOOKUP surfaces (registry / pose caches / SAB)
 * the old `resolve()` read. A superset of `LeafDeps`; `DamageRouterDeps`
 * satisfies it structurally, so `DamageRouter` constructs the resolver from its
 * own deps with no extra wiring.
 */
export interface EntityResolverDeps extends LeafDeps {
  /** Layered shield/hull maths the damageable leaves bind to. */
  shieldHullRouter: ShieldHullRouter;
  /** Per-tick pose mirrors (hit-pos fallback for the damage event). */
  shipPoseCache: Map<string, ShipPhysicsState>;
  wreckPoseCache: Map<string, ShipPhysicsState>;
  /** SAB Float32 view — swarm hit-pos fallback. */
  sabF32: Float32Array;
  /** Colyseus wrecks map (branch 1 lookup). */
  wrecksMap: MapSchema<WreckState>;
  /** Active-ship resolver — playerId → ShipState (branch 3). */
  getActiveShip: (playerId: string) => ShipState | undefined;
  /** Swarm registry lookup (branch 4). */
  swarmRegistry: ResolverSwarmSource;
}

export class EntityResolver {
  // The damageable leaf flyweights (asteroid is non-damageable → never returned).
  private readonly activeShip: ShipEntity;
  private readonly lingering: ShipEntity;
  private readonly wreck: WreckEntity;
  private readonly drone: DroneEntity;
  private readonly structure: StructureEntity;

  /** Reused resolution scratch (apply is synchronous + single-threaded). The
   *  wire id used on the damage/destroy events; the pose is the hit-pos fallback
   *  (undefined when the entity has no cached pose — preserves the old
   *  `hitX ?? poseX` semantics, never 0-filled). */
  wireTargetId = '';
  poseX: number | undefined = undefined;
  poseY: number | undefined = undefined;

  constructor(private readonly deps: EntityResolverDeps) {
    const d = deps;
    this.activeShip = createActiveShipEntity(d.shieldHullRouter, d, d.shipPoseCache);
    this.lingering = createLingeringHullEntity(d.shieldHullRouter, d, d.lingeringPoseCache);
    this.wreck = createWreckEntity(d, d.wreckPoseCache);
    this.drone = new DroneEntity(d.shieldHullRouter, d, d.sabF32);
    this.structure = new StructureEntity(d.shieldHullRouter, d, d.sabF32);
  }

  /**
   * Resolve `targetId` to the live leaf it names, filling the reused
   * `wireTargetId` / `poseX` / `poseY` scratch. Returns `null` for an unknown /
   * dead / not-yet-active / immune target (no damage applied). The ordered
   * branch selection + the pending-join diag are verbatim from the old
   * `DamageRouter.resolve` (HC#1).
   */
  resolve(targetId: string, sourceId: string, amount: number): DamageableLeaf | null {
    const d = this.deps;

    // 1. Wrecks (wire id prefix).
    if (targetId.startsWith('wreck-')) {
      const shipInstanceId = targetId.slice('wreck-'.length);
      const wreck = d.wrecksMap.get(shipInstanceId);
      if (!wreck) return null;
      this.wreck.target = wreck;
      this.wireTargetId = targetId;
      const pose = d.wreckPoseCache.get(shipInstanceId);
      this.poseX = pose?.x;
      this.poseY = pose?.y;
      return this.wreck;
    }

    // 2. Lingering hulls (schema entry with isActive=false).
    const directLingering = d.shipsMap.get(targetId);
    if (directLingering && !directLingering.isActive) {
      if (!directLingering.alive) return null;
      this.lingering.target = directLingering;
      this.wireTargetId = targetId;
      const pose = d.lingeringPoseCache.get(targetId);
      this.poseX = pose?.x;
      this.poseY = pose?.y;
      return this.lingering;
    }

    // 3. Active player ship (targetId = playerId).
    const ship = d.getActiveShip(targetId);
    if (ship) {
      if (!ship.alive) return null;
      if (!ship.isActive) {
        // Defence-in-depth for the spawn-handshake pending-join window — a
        // stray damage event for a not-yet-active ship is dropped here.
        d.serverLogEvent('damage_skipped_pending_join', { targetId, shooterId: sourceId, damage: amount });
        return null;
      }
      this.activeShip.target = ship;
      this.wireTargetId = targetId; // playerId == worker body id == wire id
      const pose = d.shipPoseCache.get(targetId);
      this.poseX = pose?.x;
      this.poseY = pose?.y;
      return this.activeShip;
    }

    // 4. Swarm registry id (drone / structure damageable; asteroid immune).
    const rec = d.swarmRegistry.get(targetId);
    if (!rec) return null;
    let leaf: DamageableSwarmLeaf;
    if (rec.kind === 1) {
      leaf = this.drone;
    } else if (rec.kind === 2) {
      leaf = this.structure;
    } else {
      // Asteroid (kind 0) — non-damageable; immune, no event (matches the old
      // swarm branch's `applied:false` short-circuit).
      return null;
    }
    leaf.target = rec;
    this.wireTargetId = `swarm-${rec.entityId}`;
    const b = slotBase(rec.slot);
    this.poseX = d.sabF32[b + SLOT_X_OFF];
    this.poseY = d.sabF32[b + SLOT_Y_OFF];
    return leaf;
  }
}
