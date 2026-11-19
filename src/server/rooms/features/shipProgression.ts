/**
 * Phase 4 (Leveling & XP, WS-B1/B2) — ship progression: kill XP, stat
 * upgrades / respec, and pushing a hull's physics multipliers to its worker
 * body. Moved verbatim out of `SectorRoom`. The room hands in live accessors
 * (`() => value` for fields it reassigns); built once (#14). Discrete events
 * only (a kill, an upgrade message, a spawn), never per tick.
 */
import type { Client } from 'colyseus';
import type { Logger } from 'pino';
import type { Bus } from '../../../core/events/Bus.js';
import { applyKillXp, xpForKill } from '../../../core/leveling/shipXp.js';
import {
  deriveStatMultipliers, isAllocValid, pointBudget, spentPoints, effectiveShipShieldMax, effectiveShipEnergyMax,
  type StatAlloc as CoreStatAlloc,
} from '../../../core/leveling/shipStats.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { getPlayerShipStore } from '../../db/PersistenceWorker.js';
import type { FleetCommandSubsystem } from '../../fleet/FleetCommandSubsystem.js';
import { classifyAttacker } from '../classifyAttacker.js';
import type { WorkerCmd } from '../PhysicsWorkerProxy.js';
import type { SectorState } from '../schema/SectorState.js';
import type { WingmanPilots } from './wingmanPilots.js';

/** What ship progression needs from the room; getters read the live field. */
export interface ShipProgressionHost {
  state(): Pick<SectorState, 'ships'>;
  lingeringSlots: Pick<ReadonlyMap<string, number>, 'has'>;
  fleet: Pick<FleetCommandSubsystem, 'isAttached'>;
  wingmen(): Pick<WingmanPilots, 'attachWingman'>;
  bus(): Pick<Bus, 'emit'>;
  broadcast(type: string, message: unknown): void;
  logger: Pick<Logger, 'warn'>;
  resolveActiveShipKey(playerId: string): string | undefined;
  postToWorker(cmd: WorkerCmd): void;
  shipHullMax(kindMax: number, alloc: CoreStatAlloc | undefined, shipInstanceId: string): number;
}

export class ShipProgression {
  constructor(private readonly h: ShipProgressionHost) {}

  /**
   * Phase 4 (Leveling & XP, WS-B1) — award XP to the KILLER SHIP INSTANCE on a
   * kill, weighted by the victim's `maxHealth` (tougher = more, D10). XP is
   * PER SHIP INSTANCE (D8): the killer's playerId resolves to the hull THAT
   * PLAYER is currently piloting (`resolveActiveShipKey`), and the XP rides
   * that hull's persistent roster row — switching ships switches progression.
   *
   * Only PLAYER killers earn XP — a drone/structure killer (`swarm-`/`lwbot-`/
   * `pstruct-` prefix) has no roster ship instance, so it's skipped. Engineering
   * rooms (no roster) and unbound killers are no-ops.
   *
   * On crossing a threshold the ship's `level` increments, the roster persists
   * the new `(level, xp)`, the live `ShipState.level` mirror updates (so the
   * next snapshot ships the public badge), a discrete `SHIP_LEVEL_UP` fires on
   * the bus, and a `ship_level_up` Colyseus message broadcasts to every client.
   */
  awardKillXp(killerId: string, victimMaxHealth: number): void {
    if (classifyAttacker(killerId) !== 'player') return; // drones/structures don't level
    const store = getPlayerShipStore();
    // RTS slice: a wingman (AI-flown lingering hull) fires under its own
    // shipInstanceId, so the killer id IS the hull's roster key (D8: the ship
    // that made the kill earns the XP). Otherwise it is a pilot's playerId.
    const killerShipInstanceId = this.h.lingeringSlots.has(killerId)
      ? killerId
      : this.h.resolveActiveShipKey(killerId);
    if (killerShipInstanceId === undefined || killerShipInstanceId === '') return;
    const row = store.get(killerShipInstanceId);
    if (row === null) return; // no roster row (engineering room / not persisted)

    const gained = xpForKill(victimMaxHealth);
    const result = applyKillXp(row.level, row.xp, gained);
    // Persist the new progression (level/xp) on the killer's instance.
    store.setProgress(killerShipInstanceId, { level: result.level, xp: result.xp });

    // Mirror the level onto the live ShipState so the broadcaster ships the
    // public badge on the next snapshot.
    const killerShip = this.h.state().ships.get(killerShipInstanceId);
    if (killerShip !== undefined) killerShip.level = result.level;

    if (result.levelsGained > 0) {
      this.h.bus().emit('SHIP_LEVEL_UP', {
        type: 'SHIP_LEVEL_UP',
        shipInstanceId: killerShipInstanceId,
        newLevel: result.level,
      });
      this.h.broadcast('ship_level_up', {
        type: 'ship_level_up',
        shipInstanceId: killerShipInstanceId,
        newLevel: result.level,
      });
    }
  }

  /**
   * Phase 4 WS-B2 — push a ship instance's per-instance PHYSICS multipliers
   * (`topSpeed`/`turnRate`, derived from its spent stat allocation) to its
   * worker body via `SET_STAT_MUL`. `bodyKey` is the worker body id (the
   * active player's is `playerId`; a lingering hull's is `linger-<shipId>`).
   * An empty / un-upgraded allocation resets the body to the un-upgraded
   * factors (both undefined). Allocation-free beyond the small derived literal
   * (called only on spawn + on a discrete upgrade — never per tick).
   */
  applyStatMulToWorker(bodyKey: string, alloc: CoreStatAlloc | undefined): void {
    const mul = deriveStatMultipliers(alloc);
    // Send the physics pair only. Neutral (both 1) ⇒ send the factors anyway so
    // a respec/clear visibly resets the body; SET_STAT_MUL with 1/1 is a no-op
    // beyond writing the (identity) multipliers.
    this.h.postToWorker({ type: 'SET_STAT_MUL', id: bodyKey, topSpeed: mul.topSpeed, turnRate: mul.turnRate });
  }

  /**
   * Phase 4 WS-B2 — apply a free stat allocation (or a respec, `alloc = {}`) to a
   * ship INSTANCE the requester owns. The single server entry for both messages.
   *
   * Validates, in order:
   *   - ownership (the roster row's `playerId === requester`),
   *   - the point budget (`isAllocValid(alloc, row.level)` — the budget CANNOT be
   *     exceeded, the authoritative gate).
   * A foreign / unknown / over-budget request is a silent no-op (no echo, no
   * persistence). On success: persist the new `statAlloc` on the roster row, and
   * — if this instance is the player's ACTIVE hull in THIS room — update the live
   * `ShipState.statAlloc` mirror AND push the physics multipliers to its worker
   * body (so the next tick scales movement; the OWN-ship snapshot slice carries
   * the alloc so the client re-anchors its predWorld identically). Finally echo
   * `ship_upgrade_applied` so the modal closes + the roster card refreshes.
   */
  applyShipUpgrade(
    client: Client,
    playerId: string,
    shipId: string,
    alloc: CoreStatAlloc,
  ): void {
    const store = getPlayerShipStore();
    const row = store.get(shipId);
    if (row === null || row.playerId !== playerId) return; // foreign / unknown
    if (!isAllocValid(alloc, row.level)) {
      this.h.logger.warn(
        { sessionId: client.sessionId, shipId, level: row.level },
        'apply_ship_upgrade over budget / invalid — dropped',
      );
      return;
    }
    // Persist on the roster (the per-instance source of truth, D8).
    store.setProgress(shipId, { statAlloc: alloc });

    // If this instance is the player's ACTIVE hull in THIS room, mirror the
    // alloc + re-anchor the worker body's physics multipliers immediately.
    const activeShipKey = this.h.resolveActiveShipKey(playerId);
    if (activeShipKey === shipId) {
      const ship = this.h.state().ships.get(shipId);
      if (ship !== undefined) {
        ship.statAlloc = alloc;
        // Review must-fix #1 — a LIVE upgrade/respec must recompute the NON-
        // PHYSICS caps from the new alloc and CLAMP the current value down to
        // the new max (a respec that lowers a cap must not leave current above
        // it). NO free heal — clamp only; the bar shrinks, it never refills.
        // One source: the `effectiveShip*` helpers (so the seed + denominator
        // agree). hpMax/shieldMax/energyMax all ride the OWN-ship snapshot
        // slice / discrete DamageEvent so the client re-reads the new caps.
        const upgKind = getShipKind(ship.kind);
        ship.maxHealth = this.h.shipHullMax(upgKind.maxHealth, alloc, ship.shipInstanceId);
        if (ship.health > ship.maxHealth) ship.health = ship.maxHealth;
        const newShieldMax = effectiveShipShieldMax(upgKind.shieldMax, alloc);
        if (ship.shield > newShieldMax) ship.shield = newShieldMax;
        const newEnergyMax = effectiveShipEnergyMax(upgKind.energyMax ?? 100, alloc);
        if (ship.energy > newEnergyMax) ship.energy = newEnergyMax;
      }
      // The active player's worker body is keyed by playerId.
      this.applyStatMulToWorker(playerId, alloc);
    } else if (this.h.lingeringSlots.has(shipId)) {
      // RTS slice 4: a LINGERING hull here is flown by a wingman. Its body
      // takes the new physics multipliers now (keyed `linger-<id>`) and the
      // brain is rebuilt from the new alloc so its stats match the body.
      // Non-physics caps are re-seeded on reclaim, as before.
      const ship = this.h.state().ships.get(shipId);
      if (ship !== undefined) ship.statAlloc = alloc;
      this.applyStatMulToWorker(`linger-${shipId}`, alloc);
      if (this.h.fleet.isAttached(shipId)) this.h.wingmen().attachWingman(shipId);
    }

    client.send('ship_upgrade_applied', {
      type: 'ship_upgrade_applied',
      shipInstanceId: shipId,
      alloc,
      spent: spentPoints(alloc),
      budget: pointBudget(row.level),
    });
  }
}
