/**
 * Shared surface for the server-side Entity LEAF classes (Generic Entity
 * Pipeline B1 — the OOP identity layer).
 *
 * A leaf is a thin, per-kind adapter over today's live store (`ShipState` /
 * `WreckState` / `SwarmEntityRecord`). It OWNS its identity
 * (`entityKind`/`entityId`), knows how to read its own `pose()`, and
 * COMPOSES — holds as data — its damage capability (`HealthBinding` +
 * `PerHitEffect` + `DeathPolicy`) and its sync/render descriptors. This is the
 * "point at `ShipEntity` and see a ship's whole story in one file" OOP the
 * pipeline is built around: a new world-object type is a leaf + a registry row.
 *
 * Why composed-DATA, never a per-class virtual `receiveInteraction()` (HC#5):
 * the damage call site (`applyInteraction`, B2) stays MONOMORPHIC — one
 * concrete function reads `leaf.health` / `leaf.perHit` / `leaf.death`. There is
 * NO N-way virtual dispatch across the leaf classes on the per-hit hot path
 * (that would megamorphic-deopt under ramming/projectile load). The leaves are
 * objects for identity/sync/render (where polymorphism is cheap + clarifying);
 * the hot per-hit work is one function reading the composed strategy the leaf
 * holds. The damageable leaves declare their composed `health` / `perHit` /
 * `death` in a consistent order (directly in `ShipEntity` / `WreckEntity`, or
 * via the shared `DamageableSwarmLeaf` base), keeping the monomorphic reader's
 * inline cache stable.
 *
 * Flyweight: one leaf instance per kind. The resolver (B2) sets `target` to the
 * live store object immediately before reading the leaf, so resolution
 * allocates nothing (invariant #14). `apply()` is synchronous + single-threaded,
 * so the swapped `target` is race-free (mirrors the prior DamageRouter
 * `_target` scratch).
 *
 * Server zone: the perHit/death side-effects touch the Colyseus broadcast / bus
 * / worker seams, so the leaves live here, not in zone-pure `src/core`. They
 * implement the core `Entity` / `INetworkSynced` / `IRenderContributor`
 * abstractions (DI invariant #5), composing the core-pure `HealthBinding`.
 */

import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import type { Bus } from '../../../core/events/Bus.js';
import type { Entity } from '../../../core/entity/Entity.js';
import type { HealthBinding, InteractionResultMut } from '../../../core/contracts/IDamageable.js';
import type { INetworkSynced } from '../../../core/contracts/INetworkSynced.js';
import type { IRenderContributor } from '../../../core/contracts/IRenderContributor.js';
import type { ShipState } from '../../rooms/schema/SectorState.js';
import type { ShipPhysicsState } from '../../../core/physics/World.js';
import type { ShipKindId } from '../../../shared-types/shipKinds.js';
import type { DestroyEvent } from '../../../shared-types/messages.js';
import type { WorkerCmd } from '../../rooms/PhysicsWorkerProxy.js';

/**
 * Kind-specific effect on every APPLIED hit, AFTER the universal damage
 * broadcast and BEFORE any death. Server-local (touches bus / diag / AI
 * ledger). Identical shape to the former private `DamageRouter.PerHitEffect`
 * (B2 deletes that copy and routes through the leaf's instead).
 */
export interface PerHitEffect {
  onApplied(
    target: unknown,
    targetId: string,
    wireTargetId: string,
    sourceId: string,
    amount: number,
    out: Readonly<InteractionResultMut>,
    atTick: number,
  ): void;
}

/**
 * Kind-specific teardown when hull crosses 0. Holds the EXACT side-effects the
 * matching original DamageRouter branch performed (broadcast / bus / worker /
 * freelist / evict), so the collapse is behaviour-preserving (HC#1).
 */
export interface DeathPolicy {
  onDestroyed(
    target: unknown,
    targetId: string,
    wireTargetId: string,
    sourceId: string,
    atTick: number,
  ): void;
}

/**
 * The damageable leaf surface: a real `Entity` (identity + pose) that also
 * declares how it networks + renders, and COMPOSES its damage strategy as data.
 * `target` is the live store object, swapped in by the resolver per resolution
 * (flyweight). The hot fields are declared first + in a fixed order by every
 * implementor for hidden-class stability (HC#5).
 */
export interface DamageableLeaf extends Entity, INetworkSynced, IRenderContributor {
  /** Live store object this leaf currently adapts (set by the resolver). */
  target: unknown;
  /** Composed layered-damage accessor over the live store (HC#3: holds a
   *  reference to the real store, never a value copy). */
  readonly health: HealthBinding;
  /** Composed per-applied-hit side-effect, or null for kinds with none. */
  readonly perHit: PerHitEffect | null;
  /** Composed teardown-on-death side-effect. */
  readonly death: DeathPolicy;
}

/** A non-damageable leaf (projectile / missile): identity + pose + sync +
 *  render, but never a damage target in any of the four dispatch sites. Exists
 *  so the B4 sync-router + client factory handle every kind uniformly. */
export interface SyncedLeaf extends Entity, INetworkSynced, IRenderContributor {}

/** Narrow record shape the swarm leaves adapt over (a subset of
 *  `SwarmEntityRecord` — the fields the swarm damage strategy + pose read). */
export interface SwarmLeafTarget {
  id: string;
  entityId: number;
  slot: number;
  /** SwarmKind enum (0 = asteroid, 1 = drone, 2 = structure). */
  kind: number;
  shipKind?: string | null;
  shieldDown?: boolean;
}

/** Hostility-ledger surface for the markHostile flip on a swarm hit. */
export interface HostilityLedger {
  markHostile(droneId: string, playerId: string, tick: number): void;
}

/**
 * The side-effect seams the leaves' perHit/death policies need. A precise
 * subset of `DamageRouterDeps` (interface segregation, SOLID-I) — the resolver
 * owns the lookup deps (registry/pose-caches/SAB); the leaves own only the
 * orchestration seams their policies fire.
 */
export interface LeafDeps {
  /** Event bus — PLAYER_DAMAGED (per hit) + SHIP_DESTROYED (on death). */
  bus: Bus;
  /** Broadcast a destroy event to every client. */
  broadcastDestroy: (msg: DestroyEvent) => void;
  /** Wreck destruction (delegates to WreckLifecycleCoordinator). */
  destroyWreck: (shipInstanceId: string) => void;
  /** Pino logger for the lifecycle log line. */
  logger: Logger;
  /** Colyseus ships map — lingering-hull death deletes its entry. */
  shipsMap: MapSchema<ShipState>;
  /** Lingering-hull slot bookkeeping — death frees the slot + pose cache. */
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  /** Per-frame slot free-list — lingering-hull death pushes its slot back. */
  freeSlots: number[];
  /** Typed postMessage facade — DESPAWN on lingering-hull death. */
  postToWorker: (cmd: WorkerCmd) => void;
  /** Quiet despawn of a swarm entity on death. */
  evictSwarmEntity: (
    rec: SwarmLeafTarget,
    opts: { broadcast: boolean; emitDestroyed: boolean; shooterId?: string },
  ) => void;
  /** Hostility ledger — a swarm hit flips COMBAT + adds the shooter. */
  aiController: HostilityLedger;
  /** Diagnostic ring-buffer sink — `damage_applied` on swarm hits. */
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
  /** Wave-system Phase 4 — reactive faction escalation. Called when a DRONE
   *  (kind 1) is damaged, with the drone id + the damage source id. The room
   *  resolves whether the source belongs to a faction (player or owned
   *  structure) and, if so, flips that faction hostile to drones + records the
   *  peaceful-timer reset + marks the hit drone hostile to the whole faction.
   *  A drone-on-drone hit resolves to no faction (factionOf → null) ⇒ no
   *  escalation (req #5 gate). Optional ⇒ no escalation (e.g. test fixtures). */
  onDroneDamaged?: (droneId: string, sourceId: string, atTick: number) => void;
  /** Scrap-on-death (Phase 2b-ii) — called for a DRONE (kind 1) the instant
   *  before it's evicted on a hull 0-cross, so a COMPOSITE-kind drone (e.g.
   *  havok) breaks into floating scrap pieces. The room reads the dying drone's
   *  pose from the SAB via `rec.slot` and calls `ScrapSpawner.spawnFromDeath`.
   *  A polygon kind (fighter/scout/…) yields zero scrap. Optional ⇒ no scrap
   *  (e.g. test fixtures / engineering rooms without a ScrapSpawner). */
  spawnScrapFromDrone?: (rec: SwarmLeafTarget) => void;
  /** Scrap-on-death for a LINGERING hull (Equinox P6.3 — "lingering ships don't
   *  explode into scrap; only active ships do"). Called the instant BEFORE the
   *  lingering hull's slot + `lingeringPoseCache` entry are torn down (so the
   *  dying pose is still live), with the pose read from `lingeringPoseCache`.
   *  The room guards composite-vs-polygon (`shipScrapGroups`) + calls
   *  `ScrapSpawner.spawnFromDeath`, exactly like the active-hull `SHIP_DESTROYED`
   *  path. The active path can't serve a lingering hull: its slot/pose are gone
   *  by the time `SHIP_DESTROYED` fires (the death policy below tears them down
   *  first), and `getActiveShip(shipInstanceId)` returns undefined. Optional ⇒
   *  no scrap (test fixtures / engineering rooms without a ScrapSpawner). */
  spawnScrapFromLingeringHull?: (kind: ShipKindId, pose: ShipPhysicsState, shipInstanceId: string) => void;
}
