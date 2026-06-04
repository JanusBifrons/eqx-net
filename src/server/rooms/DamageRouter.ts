/**
 * Routes incoming damage to the right target kind.
 *
 * Generic Entity Pipeline Phase 2: the original 4-branch if-tree (dispatched
 * by targetId SHAPE) is collapsed into a uniform, TABLE-DRIVEN orchestration:
 *
 *   resolve(targetId) → DamageKind (centralised id-shape selection)
 *   strategies[kind]  → { health, perHit?, death }  (per-kind, built once)
 *   apply()           → applyLayered → broadcast DamageEvent → perHit → death
 *
 * The four original kinds map 1:1 onto strategies:
 *   1. `wreck-<id>`        → 'wreck'         (flat hull; destroyWreck on 0)
 *   2. lingering hull      → 'lingering-hull' (layered; free slot + DESPAWN
 *                            (`!isActive` schema)  linger-<id> on 0)
 *   3. active player ship  → 'active-ship'    (layered; PLAYER_DAMAGED per hit;
 *                                              SHIP_DESTROYED on 0)
 *   4. swarm registry id   → 'swarm'          (layered; asteroid immune; wire
 *                                              id `swarm-<entityId>`; markHostile
 *                                              + `damage_applied` diag per hit;
 *                                              evictSwarmEntity on 0)
 *
 * Why table-driven: a NEW pose-core entity type (P4 structure) is a
 * swarm-registry record, so it routes through 'swarm' with ZERO new dispatch
 * branch here and ZERO change to ProjectilePipeline / MissileSimulation /
 * ShieldHullRouter (the "for free" proof). The HealthBinding strategies are the
 * zone-pure src/core contract; the PerHitEffect / DeathPolicy hold this server's
 * wire/bus/worker side-effects verbatim. Behaviour is byte-identical to the old
 * if-tree — locked by `DamageRouter.dispatch.test.ts` (golden-master written
 * before the collapse). Allocation-free: strategies built once in the ctor,
 * resolution + result use reused instance scratch (invariant #14).
 *
 * Composes ShieldHullRouter (layered + regen), WreckLifecycleCoordinator
 * (destroyWreck), and the room's evictSwarmEntity for the swarm tail.
 *
 * Extracted from SectorRoom (commit 21 partial).
 */

import type { Logger } from 'pino';
import type { Bus } from '../../core/events/Bus.js';
import type { MapSchema } from '@colyseus/schema';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import type { ShipPhysicsState } from '../../core/physics/World.js';
import type { DamageEvent, DestroyEvent } from '../../shared-types/messages.js';
import type { ShipState, WreckState } from './schema/SectorState.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { ShieldHullRouter } from './ShieldHullRouter.js';
import {
  resetInteractionResult,
  type HealthBinding,
  type InteractionResultMut,
} from '../../core/contracts/IDamageable.js';
import {
  activeShipHealthBinding,
  lingeringHealthBinding,
  wreckHealthBinding,
  swarmHealthBinding,
} from '../entity/healthBindings.js';

/** Subset of SwarmEntityRecord the swarm branch needs. */
export interface SwarmDmgRecord {
  id: string;
  slot: number;
  entityId: number;
  /** SwarmKind enum (0 = asteroid, 1 = drone). Surfaced into the
   *  `damage_applied` diag entry so a capture can distinguish drone
   *  hits from the (now-impossible) asteroid hits. */
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
  wrecksMap: MapSchema<WreckState>;
  /** Per-tick cached player poses. */
  shipPoseCache: Map<string, ShipPhysicsState>;
  /** Phase 6b lingering hulls. */
  lingeringSlots: Map<string, number>;
  lingeringPoseCache: Map<string, ShipPhysicsState>;
  /** Wreck pose mirror — read for damage-event hit-pos fallback. */
  wreckPoseCache: Map<string, ShipPhysicsState>;
  /** Wreck destruction (delegates to WreckLifecycleCoordinator). */
  destroyWreck: (shipInstanceId: string) => void;
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
  /** Event bus — emits PLAYER_DAMAGED + SHIP_DESTROYED. */
  bus: Bus;
  /** Broadcast a damage / destroy event to every client. */
  broadcastDamage: (msg: DamageEvent) => void;
  broadcastDestroy: (msg: DestroyEvent) => void;
  /** Typed postMessage facade — used for DESPAWN on lingering death. */
  postToWorker: (cmd: WorkerCmd) => void;
  /** Pino logger for the lifecycle log line. */
  logger: Logger;
  /** Diagnostic ring-buffer sink — emits `damage_applied` on swarm
   *  hits. */
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
}

/** Resolved damage kind — selects the per-kind strategy. */
type DamageKind = 'wreck' | 'lingering-hull' | 'active-ship' | 'swarm';

/** Kind-specific effect run on every APPLIED hit, AFTER the universal damage
 *  broadcast and BEFORE any death. Server-local (touches bus / diag / AI). */
interface PerHitEffect {
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

/** Kind-specific teardown when hull crosses 0. Holds the EXACT side-effects the
 *  matching original branch performed. */
interface DeathPolicy {
  onDestroyed(target: unknown, targetId: string, wireTargetId: string, sourceId: string, atTick: number): void;
}

interface Strategy {
  readonly health: HealthBinding;
  readonly perHit: PerHitEffect | null;
  readonly death: DeathPolicy;
}

export class DamageRouter {
  /** Per-kind strategy table, built once (no per-hit allocation). */
  private readonly strategies: Record<DamageKind, Strategy>;
  // Reused resolution scratch — apply() is synchronous + single-threaded.
  private _target: unknown = null;
  private _wireTargetId = '';
  private _poseX: number | undefined = undefined;
  private _poseY: number | undefined = undefined;
  private readonly _out: InteractionResultMut = {
    applied: false, newHealth: 0, newShield: 0, shieldMax: 0, hullMax: 0, hitLayer: 'hull', destroyed: false,
  };

  constructor(private readonly deps: DamageRouterDeps) {
    const d = deps;
    this.strategies = {
      wreck: {
        health: wreckHealthBinding(),
        perHit: null,
        death: {
          onDestroyed(target, _targetId, wireTargetId, sourceId) {
            const wreck = target as WreckState;
            d.broadcastDestroy({ type: 'destroy', targetId: wireTargetId, shooterId: sourceId });
            d.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId: wireTargetId, shooterId: sourceId });
            d.destroyWreck(wreck.shipInstanceId);
            d.logger.info({ shipInstanceId: wreck.shipInstanceId, shooterId: sourceId }, 'wreck destroyed');
          },
        },
      },
      'lingering-hull': {
        health: lingeringHealthBinding(d.shieldHullRouter),
        perHit: null,
        death: {
          onDestroyed(target, targetId, _wireTargetId, sourceId) {
            const ship = target as ShipState;
            ship.alive = false;
            d.broadcastDestroy({ type: 'destroy', targetId, shooterId: sourceId });
            const slot = d.lingeringSlots.get(targetId);
            if (slot !== undefined) {
              d.lingeringSlots.delete(targetId);
              d.lingeringPoseCache.delete(targetId);
              d.freeSlots.push(slot);
              // The worker body for a displaced lingering hull is keyed
              // `linger-${shipInstanceId}`, NOT playerId. Despawn that body.
              d.postToWorker({ type: 'DESPAWN', slot, playerId: `linger-${targetId}` });
            }
            d.shipsMap.delete(targetId);
            d.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId: sourceId });
            d.logger.info({ shipInstanceId: targetId, shooterId: sourceId }, 'lingering hull destroyed');
          },
        },
      },
      'active-ship': {
        health: activeShipHealthBinding(d.shieldHullRouter),
        perHit: {
          onApplied(_target, targetId, _wireTargetId, _sourceId, amount, out) {
            d.bus.emit('PLAYER_DAMAGED', { type: 'PLAYER_DAMAGED', targetId, damage: amount, newHealth: out.newHealth });
          },
        },
        death: {
          onDestroyed(target, targetId, _wireTargetId, sourceId) {
            const ship = target as ShipState;
            ship.alive = false;
            d.broadcastDestroy({ type: 'destroy', targetId, shooterId: sourceId });
            d.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId: sourceId });
            d.logger.info({ targetId, shooterId: sourceId }, 'ship destroyed');
          },
        },
      },
      swarm: {
        health: swarmHealthBinding(d.shieldHullRouter),
        perHit: {
          onApplied(target, _targetId, wireTargetId, sourceId, amount, out, atTick) {
            const rec = target as SwarmDmgRecord;
            // Diag — emits ONLY for swarm hits (the missile-vs-drone smoke
            // class polls `/dev/events` for this tag with `kind === 'swarm'`).
            d.serverLogEvent('damage_applied', {
              targetId: rec.id,
              wireTargetId,
              shooterId: sourceId,
              damage: amount,
              newHealth: out.newHealth,
              newShield: out.newShield,
              hitLayer: out.hitLayer,
              kind: 'swarm',
              swarmKind: rec.kind,
            });
            // A hit flips the drone to COMBAT + adds the shooter; the client
            // mirrors this from its damage-event handler (no wire bump).
            if (sourceId) {
              d.aiController.markHostile(rec.id, sourceId, atTick);
            }
          },
        },
        death: {
          onDestroyed(target, _targetId, _wireTargetId, sourceId) {
            d.evictSwarmEntity(target as SwarmDmgRecord, { broadcast: true, emitDestroyed: true, shooterId: sourceId });
          },
        },
      },
    };
  }

  /**
   * Centralised id-shape selection (the former if-tree's branch choice). Fills
   * the reused scratch (`_target` / `_wireTargetId` / `_poseX` / `_poseY`) and
   * returns the kind, or `null` for an unknown / dead target. A not-yet-active
   * ship is dropped with the `damage_skipped_pending_join` diag (matching the
   * spawn-handshake defence-in-depth). Allocation-free.
   */
  private resolve(targetId: string, sourceId: string, amount: number): DamageKind | null {
    const d = this.deps;

    // 1. Wrecks (wire id prefix).
    if (targetId.startsWith('wreck-')) {
      const shipInstanceId = targetId.slice('wreck-'.length);
      const wreck = d.wrecksMap.get(shipInstanceId);
      if (!wreck) return null;
      this._target = wreck;
      this._wireTargetId = targetId;
      const pose = d.wreckPoseCache.get(shipInstanceId);
      this._poseX = pose?.x;
      this._poseY = pose?.y;
      return 'wreck';
    }

    // 2. Lingering hulls (schema entry with isActive=false).
    const directLingering = d.shipsMap.get(targetId);
    if (directLingering && !directLingering.isActive) {
      if (!directLingering.alive) return null;
      this._target = directLingering;
      this._wireTargetId = targetId;
      const pose = d.lingeringPoseCache.get(targetId);
      this._poseX = pose?.x;
      this._poseY = pose?.y;
      return 'lingering-hull';
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
      this._target = ship;
      this._wireTargetId = targetId; // playerId == worker body id == wire id
      const pose = d.shipPoseCache.get(targetId);
      this._poseX = pose?.x;
      this._poseY = pose?.y;
      return 'active-ship';
    }

    // 4. Swarm registry id (drone / asteroid / future pose-core kind).
    const rec = d.swarmRegistry.get(targetId);
    if (!rec) return null;
    this._target = rec;
    this._wireTargetId = `swarm-${rec.entityId}`;
    const b = slotBase(rec.slot);
    this._poseX = d.sabF32[b + SLOT_X_OFF];
    this._poseY = d.sabF32[b + SLOT_Y_OFF];
    return 'swarm';
  }

  /** Dispatch a confirmed hit. Uniform across kinds: resolve → applyLayered →
   *  broadcast → perHit → death. Behaviour byte-identical to the old if-tree. */
  apply(targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number): void {
    const kind = this.resolve(targetId, shooterId, damage);
    if (kind === null) return;
    const strat = this.strategies[kind];
    const out = this._out;
    resetInteractionResult(out);
    const tick = this.deps.serverTick();

    strat.health.applyLayered(this._target, damage, tick, out);
    if (!out.applied) return; // immune (asteroid)

    const dmgEvent: DamageEvent = {
      type: 'damage',
      targetId: this._wireTargetId,
      damage,
      newHealth: out.newHealth,
      shooterId,
      hitX: hitX ?? this._poseX,
      hitY: hitY ?? this._poseY,
      newShield: out.newShield,
      shieldMax: out.shieldMax,
      hullMax: out.hullMax,
      hitLayer: out.hitLayer,
    };
    this.deps.broadcastDamage(dmgEvent);

    strat.perHit?.onApplied(this._target, targetId, this._wireTargetId, shooterId, damage, out, tick);

    if (out.destroyed) {
      strat.death.onDestroyed(this._target, targetId, this._wireTargetId, shooterId, tick);
    }
  }
}
