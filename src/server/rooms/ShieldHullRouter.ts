/**
 * Two-layer shield/hull damage + regen routing.
 *
 * Owns the swarm-side shield/hull state stores:
 *   - `swarmHealth` (hull per drone — asteroids absent: immune)
 *   - `swarmShield` (current shield pool per drone)
 *   - `swarmShieldLastDmg` (last-damage tick → drives regen delay)
 *
 * Plus the three layered-damage methods extracted from SectorRoom:
 *   - `damageShipLayered`  — Colyseus ShipState (active + lingering hulls)
 *   - `damageSwarmLayered` — drone records (asteroids → null = immune)
 *   - `tickShieldRegen`    — per-update regen pass for both ships + drones
 *
 * Composes the pure `ShieldHull` core (`applyLayeredDamage` + `regenStep`)
 * with the room's broadcast / bus / worker postMessage seams via injected
 * callbacks. The 0-cross / restore wire decisions stay here so the room
 * stays the orchestrator.
 *
 * Extracted from SectorRoom (commit 21 partial; src/server/CLAUDE.md
 * "Shield/Hull + ramming" section).
 */

import {
  applyLayeredDamage,
  regenStep,
  type ShieldHullState,
} from '../../core/combat/ShieldHull.js';
import {
  DEFAULT_SHIP_KIND,
  getShipKind,
  type ShipKindId,
} from '../../shared-types/shipKinds.js';
import {
  getDroneMaxHealth,
  getDroneShieldMax,
} from './droneKindHelpers.js';
import type { ShieldEventMessage } from '../../shared-types/messages.js';
import type { Bus } from '../../core/events/Bus.js';
import type { MapSchema } from '@colyseus/schema';
import type { ShipState } from './schema/SectorState.js';
import type { WorkerCmd } from './PhysicsWorkerProxy.js';

/** Result of a layered damage application (ship or drone). */
export interface LayeredDamageResult {
  newShield: number;
  shieldMax: number;
  hullMax: number;
  hitLayer: 'shield' | 'hull';
}

/** The swarm-record shape the router mutates (subset of SwarmEntityRecord). */
export interface SwarmDamageTarget {
  id: string;
  entityId: number;
  shipKind?: ShipKindId | null;
  shieldDown?: boolean;
}

/** Narrow view of swarmRegistry — only `get(id)` is needed for regen.
 *  Returns null when the id is not present (matches SwarmEntityRegistry).
 *  `kind` is the pose-core kind (0 asteroid / 1 drone / 2 structure) — only
 *  drones (1) have a shield layer, so the regen pass gates on it. */
export interface SwarmLookup {
  get(id: string): {
    kind?: number;
    shipKind?: ShipKindId | null;
    entityId?: number;
    shieldDown?: boolean;
  } | null | undefined;
}

export interface ShieldHullRouterDeps {
  /** Current authoritative server tick. */
  serverTick: () => number;
  /** State.ships (regen iterates active ships; lingering hulls are not active). */
  shipsMap: MapSchema<ShipState>;
  /** Lookup for the swarm-side regen pass. */
  swarmRegistry: SwarmLookup;
  /** Event bus — emit SHIELD_BROKEN / SHIELD_RESTORED on transitions. */
  bus: Bus;
  /** Server log event sink — diagnostic capture stream. */
  serverLogEvent: (tag: string, data: Record<string, unknown>) => void;
  /** Typed postMessage facade — used for SET_HULL_EXPOSED collider swap. */
  postToWorker: (cmd: WorkerCmd) => void;
  /** Broadcast a shield event to every client (regen anchor messages). */
  broadcast: (type: 'shield', msg: ShieldEventMessage) => void;
}

export class ShieldHullRouter {
  /** Per-swarm-entity health. Drones are killable; asteroids absent. */
  readonly swarmHealth = new Map<string, number>();
  /** Per-drone shield pool (mirrors swarmHealth; cleared in evictSwarmEntity). */
  readonly swarmShield = new Map<string, number>();
  /** Per-drone last-damage tick (drives regen delay). */
  readonly swarmShieldLastDmg = new Map<string, number>();

  constructor(private readonly deps: ShieldHullRouterDeps) {}

  /**
   * Shield→hull layered damage for a schema ShipState (active or
   * lingering). Mutates ship.health (hull) + ship.shield +
   * shieldLastDamageTick. On the 0-cross-down: emit SHIELD_BROKEN +
   * post SET_HULL_EXPOSED (when a workerBodyId is provided).
   */
  damageShipLayered(
    ship: ShipState,
    damage: number,
    workerBodyId: string | null,
  ): LayeredDamageResult {
    const d = this.deps;
    const kind = getShipKind(ship.kind);
    const state: ShieldHullState = {
      shield: ship.shield,
      hull: ship.health,
      lastDamageTick: ship.shieldLastDamageTick,
    };
    const r = applyLayeredDamage(state, damage, d.serverTick());
    ship.shield = state.shield;
    ship.health = state.hull;
    ship.shieldLastDamageTick = state.lastDamageTick;
    if (r.brokeThisHit) {
      d.bus.emit('SHIELD_BROKEN', { type: 'SHIELD_BROKEN', entityId: ship.shipInstanceId });
      d.serverLogEvent('shield_broken', { entityId: ship.shipInstanceId, kindId: ship.kind, tick: d.serverTick() });
      if (workerBodyId !== null) {
        d.postToWorker({ type: 'SET_HULL_EXPOSED', id: workerBodyId, exposed: true, kindId: ship.kind, tick: d.serverTick() });
      }
    }
    // hullMax stays ship.maxHealth (schema): hull behaves exactly as
    // today ("hull works as health does currently"); shield is the new layer.
    return { newShield: state.shield, shieldMax: kind.shieldMax, hullMax: ship.maxHealth, hitLayer: r.hitLayer };
  }

  /**
   * Shield→hull layered damage for a swarm drone. State lives in
   * swarmShield / swarmShieldLastDmg (here); hull in swarmHealth.
   * Returns null for asteroids (immune — no swarmHealth entry).
   *
   * On the 0-cross-down: flip `rec.shieldDown=true` AND post
   * SET_HULL_EXPOSED. The drone wire bit + collider swap shipped in
   * Phase 6.
   */
  damageSwarmLayered(
    rec: SwarmDamageTarget,
    damage: number,
  ): LayeredDamageResult | null {
    const d = this.deps;
    const hull0 = this.swarmHealth.get(rec.id);
    if (hull0 === undefined) return null;
    const shieldMax = getDroneShieldMax(rec.shipKind);
    const state: ShieldHullState = {
      shield: this.swarmShield.get(rec.id) ?? shieldMax,
      hull: hull0,
      lastDamageTick: this.swarmShieldLastDmg.get(rec.id) ?? d.serverTick(),
    };
    const r = applyLayeredDamage(state, damage, d.serverTick());
    this.swarmShield.set(rec.id, state.shield);
    this.swarmShieldLastDmg.set(rec.id, state.lastDamageTick);
    this.swarmHealth.set(rec.id, state.hull);
    if (r.brokeThisHit) {
      d.bus.emit('SHIELD_BROKEN', { type: 'SHIELD_BROKEN', entityId: `swarm-${rec.entityId}` });
      d.serverLogEvent('shield_broken', { entityId: `swarm-${rec.entityId}`, tick: d.serverTick() });
      rec.shieldDown = true;
      d.postToWorker({ type: 'SET_HULL_EXPOSED', id: rec.id, exposed: true, kindId: rec.shipKind ?? DEFAULT_SHIP_KIND, tick: d.serverTick() });
    }
    return { newShield: state.shield, shieldMax, hullMax: getDroneMaxHealth(rec.shipKind) ?? 40, hitLayer: r.hitLayer };
  }

  /**
   * Halo shield regen — one cheap pass per update(). Full-shield
   * entities skip with two comparisons (no allocation). On the
   * 0-cross-up an active player ship swaps its collider back to the
   * cheap circle and SHIELD_RESTORED fires. Drone regen is server-side
   * only on the worker-body side (collider swap); the discrete regen-
   * ramp broadcast is reserved for active player ships.
   */
  tickShieldRegen(): void {
    const d = this.deps;
    const t = d.serverTick();
    for (const [, ship] of d.shipsMap) {
      if (!ship.alive) continue;
      const kind = getShipKind(ship.kind);
      if (ship.shield >= kind.shieldMax) continue;
      if (t - ship.shieldLastDamageTick < kind.shieldRegenDelayTicks) continue;
      const state: ShieldHullState = {
        shield: ship.shield,
        hull: ship.health,
        lastDamageTick: ship.shieldLastDamageTick,
      };
      const r = regenStep(state, kind, t);
      if (!r.regenerated) continue;
      ship.shield = state.shield;
      if (r.restoredThisStep) {
        d.bus.emit('SHIELD_RESTORED', { type: 'SHIELD_RESTORED', entityId: ship.shipInstanceId });
        d.serverLogEvent('shield_restored', { entityId: ship.shipInstanceId, tick: t });
        if (ship.isActive) {
          d.postToWorker({ type: 'SET_HULL_EXPOSED', id: ship.playerId, exposed: false, kindId: ship.kind, tick: t });
          // Discrete client anchor: regen began. The client tweens the
          // bar from here to shieldMax over the known regen duration —
          // the ramp itself is never streamed (locked: no continuous
          // shield traffic). Lingering hulls' owners aren't connected,
          // so only active player ships broadcast.
          d.broadcast('shield', { type: 'shield', targetId: ship.playerId, shield: ship.shield, shieldMax: kind.shieldMax, phase: 'restored', tick: t });
        }
      }
      if (r.regenComplete && ship.isActive) {
        d.broadcast('shield', { type: 'shield', targetId: ship.playerId, shield: kind.shieldMax, shieldMax: kind.shieldMax, phase: 'regen_complete', tick: t });
      }
    }
    for (const [id, shieldVal] of this.swarmShield) {
      const rec = d.swarmRegistry.get(id);
      if (!rec) continue;
      // ONLY drones (kind 1) have a shield layer. Structures (kind 2) seed
      // swarmShield = 0 ("no shield"), but `getDroneShieldMax`/`getShipKind` are
      // forgiving — a structure's kind id falls back to a FIGHTER, so without
      // this gate a damaged structure would regen a phantom fighter shield and
      // post SET_HULL_EXPOSED, corrupting its collider to a ~12u fighter hull
      // (the unified-entity-hull "fly into a capital" bug). Asteroids (kind 0)
      // are likewise shieldless. (Shield-fence plan: pylons are the first
      // structures the AI actively shoots, which is what surfaced this.)
      if (rec.kind !== 1) continue;
      const sMax = getDroneShieldMax(rec.shipKind);
      if (shieldVal >= sMax) continue;
      const hull = this.swarmHealth.get(id);
      if (hull === undefined || hull <= 0) continue;
      const dkind = getShipKind(rec.shipKind);
      if (t - (this.swarmShieldLastDmg.get(id) ?? t) < dkind.shieldRegenDelayTicks) continue;
      const state: ShieldHullState = { shield: shieldVal, hull, lastDamageTick: this.swarmShieldLastDmg.get(id) ?? t };
      const r = regenStep(state, dkind, t);
      if (r.regenerated) this.swarmShield.set(id, state.shield);
      if (r.restoredThisStep) {
        d.serverLogEvent('shield_restored', { entityId: `swarm-${(rec as { entityId?: number }).entityId ?? -1}`, tick: t });
        (rec as { shieldDown?: boolean }).shieldDown = false;
        d.postToWorker({ type: 'SET_HULL_EXPOSED', id, exposed: false, kindId: rec.shipKind ?? DEFAULT_SHIP_KIND, tick: t });
      }
    }
  }
}
