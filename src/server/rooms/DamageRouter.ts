/**
 * Routes incoming damage to the right target kind.
 *
 * Four branches, dispatched by targetId shape:
 *   1. `wreck-${shipInstanceId}` — Colyseus wrecks schema; tear down +
 *      destroy bus event on health 0.
 *   2. shipInstanceId where `state.ships.get(id).isActive === false` —
 *      lingering hull; layered shield/hull damage; on 0 broadcast
 *      destroy + free the lingering slot + DESPAWN the linger-prefixed
 *      worker body.
 *   3. playerId (active ship resolved via the indirection map) —
 *      layered damage + PLAYER_DAMAGED bus event; on 0 mark dead +
 *      destroy broadcast + SHIP_DESTROYED bus event.
 *   4. swarm registry id — drone path: layered damage; asteroids
 *      immune (null layered result); on 0 evictSwarmEntity. Damage
 *      events use the WIRE id (`swarm-<entityId>`) so client sprite
 *      keying works.
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

/** Subset of SwarmEntityRecord the swarm branch needs. */
export interface SwarmDmgRecord {
  id: string;
  slot: number;
  entityId: number;
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
}

export class DamageRouter {
  constructor(private readonly deps: DamageRouterDeps) {}

  /** Dispatch a confirmed hit to the appropriate damage branch. */
  apply(targetId: string, shooterId: string, damage: number, hitX?: number, hitY?: number): void {
    const d = this.deps;

    // 1. Wrecks (wire id prefix).
    if (targetId.startsWith('wreck-')) {
      const shipInstanceId = targetId.slice('wreck-'.length);
      const wreck = d.wrecksMap.get(shipInstanceId);
      if (!wreck) return;
      wreck.health = Math.max(0, wreck.health - damage);
      const pose = d.wreckPoseCache.get(shipInstanceId);
      d.broadcastDamage({
        type: 'damage',
        targetId,
        damage,
        newHealth: wreck.health,
        shooterId,
        hitX: hitX ?? pose?.x,
        hitY: hitY ?? pose?.y,
        newShield: 0,
        shieldMax: 0,
        hullMax: wreck.maxHealth,
        hitLayer: 'hull',
      });
      if (wreck.health <= 0) {
        d.broadcastDestroy({ type: 'destroy', targetId, shooterId });
        d.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId });
        d.destroyWreck(shipInstanceId);
        d.logger.info({ shipInstanceId, shooterId }, 'wreck destroyed');
      }
      return;
    }

    // 2. Lingering hulls (Phase 6b — schema entry with isActive=false).
    const directLingering = d.shipsMap.get(targetId);
    if (directLingering && !directLingering.isActive) {
      if (!directLingering.alive) return;
      const f = d.shieldHullRouter.damageShipLayered(directLingering, damage, null);
      const pose = d.lingeringPoseCache.get(targetId);
      const dmgEvent: DamageEvent = {
        type: 'damage',
        targetId,
        damage,
        newHealth: directLingering.health,
        shooterId,
        hitX: hitX ?? pose?.x,
        hitY: hitY ?? pose?.y,
        newShield: f.newShield,
        shieldMax: f.shieldMax,
        hullMax: f.hullMax,
        hitLayer: f.hitLayer,
      };
      d.broadcastDamage(dmgEvent);
      if (directLingering.health <= 0) {
        directLingering.alive = false;
        d.broadcastDestroy({ type: 'destroy', targetId, shooterId });
        const slot = d.lingeringSlots.get(targetId);
        if (slot !== undefined) {
          d.lingeringSlots.delete(targetId);
          d.lingeringPoseCache.delete(targetId);
          d.freeSlots.push(slot);
          // After the fresh-spawn-displaces rekey, the worker's body
          // for this hull is keyed by `linger-${shipInstanceId}`,
          // NOT by playerId (which now points at the player's active
          // ship). Despawn the correct body.
          d.postToWorker({ type: 'DESPAWN', slot, playerId: `linger-${targetId}` });
        }
        d.shipsMap.delete(targetId);
        d.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId });
        d.logger.info({ shipInstanceId: targetId, shooterId }, 'lingering hull destroyed');
      }
      return;
    }

    // 3. Active player ship (targetId = playerId).
    const ship = d.getActiveShip(targetId);
    if (ship) {
      if (!ship.alive) return;
      // Active branch: targetId is the playerId, which is also the
      // worker body id for the player ship (SPAWN used playerId).
      const f = d.shieldHullRouter.damageShipLayered(ship, damage, targetId);
      const pose = d.shipPoseCache.get(targetId);
      const dmgEvent: DamageEvent = {
        type: 'damage',
        targetId,
        damage,
        newHealth: ship.health,
        shooterId,
        hitX: hitX ?? pose?.x,
        hitY: hitY ?? pose?.y,
        newShield: f.newShield,
        shieldMax: f.shieldMax,
        hullMax: f.hullMax,
        hitLayer: f.hitLayer,
      };
      d.broadcastDamage(dmgEvent);
      d.bus.emit('PLAYER_DAMAGED', { type: 'PLAYER_DAMAGED', targetId, damage, newHealth: ship.health });

      if (ship.health <= 0) {
        ship.alive = false;
        d.broadcastDestroy({ type: 'destroy', targetId, shooterId });
        d.bus.emit('SHIP_DESTROYED', { type: 'SHIP_DESTROYED', targetId, shooterId });
        d.logger.info({ targetId, shooterId }, 'ship destroyed');
      }
      return;
    }

    // 4. Swarm target. Asteroids (kind=0, no swarmHealth entry) → immune.
    const rec = d.swarmRegistry.get(targetId);
    if (!rec) return;
    const sf = d.shieldHullRouter.damageSwarmLayered(rec, damage);
    if (sf === null) return;
    const newHealth = d.shieldHullRouter.swarmHealth.get(targetId) ?? 0;

    const wireTargetId = `swarm-${rec.entityId}`;
    const b = slotBase(rec.slot);
    const swarmHitX = hitX ?? d.sabF32[b + SLOT_X_OFF]!;
    const swarmHitY = hitY ?? d.sabF32[b + SLOT_Y_OFF]!;
    d.broadcastDamage({
      type: 'damage',
      targetId: wireTargetId,
      damage,
      newHealth,
      shooterId,
      hitX: swarmHitX,
      hitY: swarmHitY,
      newShield: sf.newShield,
      shieldMax: sf.shieldMax,
      hullMax: sf.hullMax,
      hitLayer: sf.hitLayer,
    });

    // Phase 1 AI: a hit flips the drone's behaviour state to COMBAT and
    // adds the shooter to its hostile set. Same call goes to the client
    // from its damage-event handler — both sides converge on the same
    // hostility state without a wire-format bump.
    if (shooterId) {
      d.aiController.markHostile(rec.id, shooterId, d.serverTick());
    }

    if (newHealth <= 0) {
      d.evictSwarmEntity(rec, { broadcast: true, emitDestroyed: true, shooterId });
    }
  }
}
