/**
 * Client-side Entity leaf contract — the OOP peer of the server-side leaves in
 * `src/server/entity/leaves/` (Generic Entity Pipeline B4). A leaf owns the
 * CLIENT construction of one pose-core kind: how its predWorld body is built
 * (collider shape, mass, lock), whether it registers a client-side AI hostility
 * ledger entry, and how it swaps its shield collider — reading the SIDE-NEUTRAL
 * facts (transport / interpolated / poseCoreKind) from the SHARED core
 * `EntityKindRegistry`, so a kind is defined once (the vocabulary lives in core)
 * and each zone composes only its own behaviour.
 *
 * Replaces the old `swarmKindProfile.ts` data table: `staticBody` now DERIVES
 * from `!descriptor.sync.interpolated` (in the base); the `hasAiBehaviour` /
 * `hasShield` booleans are RELOCATED into the drone leaf's methods (ledger
 * registration + collider swap are irreducibly client-construction).
 *
 * Zone: client (touches predWorld + the AI ledger). A leaf implements no damage
 * — the server is authoritative; the client only constructs + predicts.
 */
import type { PhysicsWorld } from '@core/physics/World';
import type { AiController } from '@core/ai/AiController';
import type { SwarmRenderState } from '@core/contracts/IRenderer';

/** The exact predWorld surface a leaf touches — a structural subset of
 *  `PhysicsWorld`, so the real world satisfies it and a unit-test fake can
 *  record calls without a Rapier world. */
export type PredWorldHandle = Pick<
  PhysicsWorld,
  'hasShip' | 'spawnObstacle' | 'lockBody' | 'setHullExposed' | 'setShipState'
>;

/** The hostility-ledger surface a drone leaf touches (register / unregister). */
export type AiLedgerHandle = Pick<AiController, 'register' | 'unregister'>;

/**
 * Reused per-entity construction context — ONE instance, mutated in place before
 * each leaf call (invariant #14: no per-entity / per-frame allocation). The
 * caller (`ColyseusClient`) owns the context AND the body / AI caches; the leaf
 * only reads ctx and calls predWorld / aiController.
 */
export interface ClientSpawnCtx {
  /** predWorld for this client (non-null — the caller guards before filling). */
  predWorld: PredWorldHandle;
  /** Hostility ledger (the drone leaf registers + sets `registeredAiId`). */
  aiController: AiLedgerHandle;
  /** Numeric wire entityId. */
  entityId: number;
  /** Pre-cached `swarm-${entityId}` predWorld body key. */
  key: string;
  /** The live render-mirror swarm entry (pose + kind + shipKind + shieldDown). */
  entry: SwarmRenderState;
  /** OUT: a leaf that registers an AI ledger entry sets this to its entityId;
   *  the caller folds it into its `_aiRegisteredIds` set (single ownership of
   *  the cache stays with `ColyseusClient`). */
  registeredAiId: number | null;
}

/** Per-sync view — the same object shape as {@link ClientSpawnCtx}. */
export type ClientSyncCtx = ClientSpawnCtx;

export interface IClientEntityLeaf {
  /** The pose-core kind byte this leaf constructs (== descriptor.sync.poseCoreKind). */
  readonly poseCoreKind: number;
  /**
   * Build the predWorld body for this entity (called ONCE, on first spawn).
   * May register an AI ledger entry and set `ctx.registeredAiId`. This is the
   * low-frequency spawn seam — polymorphism is cheap here (the per-hit damage
   * path stays monomorphic server-side, HC#5; this is construction, not a hot
   * loop).
   */
  spawnBody(ctx: ClientSpawnCtx): void;
  /**
   * Idempotent per-sync upkeep. Static kinds (asteroid / structure) re-pose
   * their locked body from the raw packet pose; the drone swaps its shield
   * collider. Drones are NEVER re-posed here — the `updateMirror` kinematic
   * follower is the single per-frame pose writer (the one-pose-per-frame rule).
   */
  onSync(ctx: ClientSyncCtx): void;
}
