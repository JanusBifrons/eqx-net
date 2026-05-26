/**
 * Tear down a swarm entity (drone or asteroid).
 *
 * Two callers:
 *   - Combat kills (`broadcast: true`, `emitDestroyed: true`): the
 *     client flashes destruction; the kill-feed/SFX path runs; the
 *     `ENTITY_DESTROYED` bus event triggers respawn for living-world
 *     bots.
 *   - LoadShedder evictions (`broadcast: false`, `emitDestroyed: false`):
 *     eviction for budget is invisible to players (an explosion on a
 *     5000-unit-distant drone would be confusing diegetically). The
 *     `ENTITY_SHED` bus channel (separate from `ENTITY_DESTROYED`)
 *     lets persistence/telemetry distinguish the two.
 *
 * Touches 10 collaborating state stores via deps interface. Single
 * canonical eviction site — calls from applyDamage, LoadShedder,
 * `despawnLivingWorldBot`, room shutdown all flow through here.
 *
 * Extracted from SectorRoom (commit 21 partial).
 */

import type { Bus } from '../../core/events/Bus.js';
import type { Logger } from 'pino';
import type { DestroyEvent } from '../../shared-types/messages.js';
import type { SwarmEntityRecord } from '../net/SwarmEntityRegistry.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';
import type { ShieldHullRouter } from './ShieldHullRouter.js';
import type { WeaponMountTicker } from './WeaponMountTicker.js';

export interface SwarmEvictorDeps {
  bus: Bus;
  logger: Logger;
  broadcastDestroy: (msg: DestroyEvent) => void;
  postToWorker: (cmd: WorkerCmd) => void;
  /** Spatial grid — drop the entity's cell entry. */
  interestGrid: { remove(entityId: number): void };
  /** Swarm registry — remove the record. */
  swarmRegistry: { unregister(id: string): void };
  /** AI controller — drop the behaviour. */
  aiController: { unregister(id: string): void };
  /** Lag-comp ring — drop the entity's pose row. */
  snapshotRing: { unregisterEntity(id: string): void };
  /** Shield/hull state — owns swarmHealth/Shield/LastDmg. */
  shieldHullRouter: ShieldHullRouter;
  /** Mount-angle ticker — owns droneMountAngles / droneSlotTargets. */
  mountTicker: WeaponMountTicker;
  /** Free-slot list — push the released SAB slot. */
  freeSlots: number[];
}

export interface EvictSwarmOpts {
  broadcast: boolean;
  emitDestroyed: boolean;
  shooterId?: string;
}

export class SwarmEvictor {
  constructor(private readonly deps: SwarmEvictorDeps) {}

  evict(rec: SwarmEntityRecord, opts: EvictSwarmOpts): void {
    const d = this.deps;
    if (opts.broadcast) {
      d.broadcastDestroy({
        type: 'destroy',
        targetId: `swarm-${rec.entityId}`,
        shooterId: opts.shooterId ?? '',
      });
    }
    if (opts.emitDestroyed) {
      d.bus.emit('ENTITY_DESTROYED', { type: 'ENTITY_DESTROYED', entityId: rec.id });
    }

    d.postToWorker({ type: 'DESPAWN', slot: rec.slot, playerId: rec.id });
    d.interestGrid.remove(rec.entityId);
    d.swarmRegistry.unregister(rec.id);
    d.aiController.unregister(rec.id);
    d.shieldHullRouter.swarmHealth.delete(rec.id);
    d.shieldHullRouter.swarmShield.delete(rec.id);
    d.shieldHullRouter.swarmShieldLastDmg.delete(rec.id);
    d.snapshotRing.unregisterEntity(rec.id);
    // Phase 4c — clean up drone turret state alongside the body.
    d.mountTicker.clearDrone(rec.id);
    d.freeSlots.push(rec.slot);
    if (opts.broadcast) {
      d.logger.info({ targetId: rec.id, shooterId: opts.shooterId }, 'drone destroyed');
    }
  }
}
