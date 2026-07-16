/**
 * Routes incoming damage to the right target LEAF and applies it.
 *
 * Generic Entity Pipeline B2: the former 4-branch id-shape if-tree — and the
 * data-driven `strategies[kind]` table that briefly replaced it — are collapsed
 * into the OOP pipeline:
 *
 *   resolver.resolve(targetId) → Entity LEAF  (a real object that COMPOSES its
 *                                              own { health, perHit, death })
 *   applyInteraction(leaf, …)  → applyLayered → broadcast → perHit → death
 *
 * The leaf is a `ShipEntity` / `DroneEntity` / `StructureEntity`
 * (`src/server/entity/leaves/`); a NEW damageable type is a leaf + a registry
 * row, with ZERO new dispatch branch here (the "structure for free" proof). The
 * ordered, shape-based selection lives in `EntityResolver` (HC#1 — branch order
 * + per-branch side-effects are load-bearing). Behaviour is byte-identical to
 * the old if-tree — locked by `DamageRouter.dispatch.test.ts` (the golden-master).
 *
 * HC#5 (megamorphism guard): `applyInteraction` is ONE concrete function reading
 * the leaf's composed `health` / `perHit` / `death` DATA. It must NEVER become a
 * per-class virtual `leaf.receiveInteraction()` dispatched across the N leaf
 * classes — under ramming/projectile load that megamorphic-deopts in V8. The
 * leaves are objects for identity/sync/render; the per-hit work stays one
 * monomorphic call site. (Bench: `benchmarks/damageDispatch.bench.ts`.)
 *
 * Allocation-free: the resolver builds the leaf flyweights once; resolution +
 * result use reused instance scratch (invariant #14).
 *
 * Composes ShieldHullRouter (layered + regen, via the leaves' health bindings)
 * and the room's evictSwarmEntity.
 *
 * Extracted from SectorRoom (commit 21 partial).
 */

import type { Logger } from 'pino';
import type { Bus } from '../../core/events/Bus.js';
import type { MapSchema } from '@colyseus/schema';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { ShipKindId } from '../../shared-types/shipKinds.js';
import type { DamageEvent, DestroyEvent } from '../../shared-types/messages.js';
import type { ShipState } from './schema/SectorState.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { ShieldHullRouter } from './ShieldHullRouter.js';
import {
  resetInteractionResult,
  type InteractionResultMut,
} from '../../core/contracts/IDamageable.js';
import { EntityResolver } from '../entity/EntityResolver.js';
import type { DamageableLeaf } from '../entity/leaves/index.js';

/** Subset of SwarmEntityRecord the swarm branch needs. */
export interface SwarmDmgRecord {
  id: string;
  slot: number;
  entityId: number;
  /** SwarmKind enum (0 = asteroid, 1 = drone, 2 = structure). Surfaced into the
   *  `damage_applied` diag entry so a capture can distinguish drone hits from
   *  the (immune) asteroid hits. */
  kind: number;
  shipKind?: string | null;
  shieldDown?: boolean;
}

/** Narrow view of swarmRegistry — the swarm-damage branch reads it. */
export interface SwarmDmgSource {
  get(id: string): SwarmDmgRecord | null | undefined;
}

/** Hostility ledger surface for the markHostile flip on a drone hit. */
export interface HostilityLedger {
  markHostile(droneId: string, playerId: string, tick: number): void;
}

export interface DamageRouterDeps {
  /** Current authoritative server tick. */
  serverTick: () => number;
  /** Colyseus schema maps. */
  shipsMap: MapSchema<ShipState>;
  /** Per-tick cached player poses. */
  shipPoseCache: Map<string, ShipPhysicsState>;
  /** Phase 6b lingering hulls. */
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  /** Per-frame slot free-list — lingering hull death pushes its slot back. */
  freeSlots: number[];
  /** Shield/hull layered damage helpers. */
  shieldHullRouter: ShieldHullRouter;
  /** Active-ship resolver — playerId → ShipState (active branch). */
  getActiveShip: (playerId: string) => ShipState | undefined;
  /** SAB Float32 view — swarm hit-pos fallback. */
  sabF32: Float32Array;
  /** Swarm registry lookup. */
  swarmRegistry: SwarmDmgSource;
  /** Quiet despawn of a drone (`{ broadcast:true, emitDestroyed:true }`). */
  evictSwarmEntity: (rec: SwarmDmgRecord, opts: { broadcast: boolean; emitDestroyed: boolean; shooterId?: string }) => void;
  /** Hostility ledger — drone hits flip COMBAT + add shooter. */
  aiController: HostilityLedger;
  /** Wave-system reactive faction escalation — invoked on an applied DRONE hit
   *  with `(droneId, sourceId, atTick)`. Optional (test fixtures omit it). */
  onDroneDamaged?: (droneId: string, sourceId: string, atTick: number) => void;
  /** Scrap-on-death (Phase 2b-ii) — invoked for a DRONE just before it's
   *  evicted on death, so a composite-kind drone breaks into scrap. Optional
   *  (test fixtures / engineering rooms without a ScrapSpawner omit it). */
  spawnScrapFromDrone?: (rec: SwarmDmgRecord) => void;
  /** Scrap-on-death for a LINGERING hull (Equinox P6.3) — invoked from the
   *  lingering death policy just before it tears down the slot + pose, so a
   *  composite-kind lingering hull breaks into scrap like an active ship. Pose
   *  is read from lingeringPoseCache before deletion. Optional (test fixtures /
   *  engineering rooms without a ScrapSpawner omit it). */
  spawnScrapFromLingeringHull?: (kind: ShipKindId, pose: ShipPhysicsState, shipInstanceId: string) => void;
  /** Event bus — emits PLAYER_DAMAGED + SHIP_DESTROYED. */
  bus: Bus;
  /** Broadcast a damage / destroy event to every client. */
  broadcastDamage: (msg: DamageEvent) => void;
  broadcastDestroy: (msg: DestroyEvent) => void;
  /** Typed postMessage facade — used for DESPAWN on lingering death. */
  postToWorker: (cmd: WorkerCmd) => void;
  /** Pino logger for the lifecycle log line. */
  logger: Logger;
  /** Diagnostic ring-buffer sink — emits `damage_applied` on swarm hits. */
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
}

export class DamageRouter {
  /** Owns the leaf flyweights + the ordered shape-based lookup. */
  private readonly resolver: EntityResolver;
  // Reused result scratch — apply() is synchronous + single-threaded.
  private readonly _out: InteractionResultMut = {
    applied: false, newHealth: 0, newShield: 0, shieldMax: 0, hullMax: 0, hitLayer: 'hull', destroyed: false,
  };

  constructor(private readonly deps: DamageRouterDeps) {
    // DamageRouterDeps structurally satisfies EntityResolverDeps (LeafDeps +
    // the lookup surfaces), so the resolver wires from the same deps bag.
    this.resolver = new EntityResolver(deps);
  }

  /** Dispatch a confirmed hit: resolve the target leaf, then apply the
   *  interaction. Behaviour byte-identical to the old if-tree (golden-master). */
  apply(targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number): void {
    const leaf = this.resolver.resolve(targetId, shooterId, damage);
    if (leaf === null) return;
    this.applyInteraction(leaf, targetId, shooterId, damage, hitX, hitY);
  }

  /**
   * The single, MONOMORPHIC per-hit call site (HC#5). Reads the leaf's composed
   * `health` / `perHit` / `death` DATA — NOT a per-class virtual method. The
   * order (layered damage → universal broadcast → perHit → death) + the
   * `!applied` early-out are verbatim from the old uniform tail, so the collapse
   * is behaviour-preserving.
   *
   * DO NOT replace this with `leaf.receiveInteraction(...)`: a virtual call
   * across the N leaf classes megamorphic-deopts under ramming/projectile load.
   * Keep dispatch monomorphic; vary per-kind behaviour by the composed data.
   */
  private applyInteraction(
    leaf: DamageableLeaf,
    targetId: string,
    shooterId: string,
    damage: number,
    hitX?: number,
    hitY?: number,
  ): void {
    const out = this._out;
    resetInteractionResult(out);
    const tick = this.deps.serverTick();
    const wireTargetId = this.resolver.wireTargetId;

    leaf.health.applyLayered(leaf.target, damage, tick, out);
    if (!out.applied) return; // immune target — no event

    // Campaign 1.2 (invariant #15 — the ram path's P3.3 rounds-before-emit,
    // applied at the ONE wire emit site so missile splash / mining chips are
    // covered too): the wire reports INTEGER damage, and an event whose
    // rounded damage is 0 is FX-noise the client would render as a "0"
    // number + sparks — skip the broadcast UNLESS it carries a state edge
    // the client keys off this event for: a shield 0-cross (collider swap)
    // or a destruction. Internal application above stays FRACTIONAL, so
    // sub-1 chip damage (mining DPS) keeps accumulating server-side.
    const wireDamage = Math.round(damage);
    const shieldBroke = out.hitLayer === 'shield' && out.newShield <= 0;
    if (wireDamage > 0 || shieldBroke || out.destroyed) {
      const dmgEvent: DamageEvent = {
        type: 'damage',
        targetId: wireTargetId,
        damage: wireDamage,
        newHealth: out.newHealth,
        shooterId,
        hitX: hitX ?? this.resolver.poseX,
        hitY: hitY ?? this.resolver.poseY,
        newShield: out.newShield,
        shieldMax: out.shieldMax,
        hullMax: out.hullMax,
        hitLayer: out.hitLayer,
      };
      this.deps.broadcastDamage(dmgEvent);
    }

    leaf.perHit?.onApplied(leaf.target, targetId, wireTargetId, shooterId, damage, out, tick);

    if (out.destroyed) {
      leaf.death.onDestroyed(leaf.target, targetId, wireTargetId, shooterId, tick);
    }
  }
}
