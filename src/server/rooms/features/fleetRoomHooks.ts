/**
 * RTS command layer — the room-side fleet hooks: the per-tick fleet command
 * cap, the owner-only `fleet_status` stream and its "send soon after a
 * command" flush, owned-hull retaliation + morale damage notes, spectate /
 * command-view entry, and the parked-hull poses a fleet warp reads. Moved
 * verbatim out of `SectorRoom`; the fleet command handlers themselves stay
 * `registerFleetMessages` (`fleetMessages.ts`). The room hands in live
 * accessors (`() => value` for fields it reassigns). Per-tick path (#14): the
 * cap map, the soon-queue and the bound sender are built once, here.
 */
import type { MapSchema } from '@colyseus/schema';
import type { Client } from 'colyseus';
import type { AiController } from '../../../core/ai/AiController.js';
import { effectiveShipShieldMax } from '../../../core/leveling/shipStats.js';
import { slotBase, SLOT_X_OFF, SLOT_Y_OFF } from '../../../shared-types/sabLayout.js';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import type { FleetCommandSubsystem } from '../../fleet/FleetCommandSubsystem.js';
import { FleetStatusSoon, FLEET_STATUS_SOON_TICKS } from '../../fleet/FleetStatusSoon.js';
import { FleetStatusStream } from '../../fleet/FleetStatusStream.js';
import type { FleetHullPose } from '../../transit/fleetArrivalPoses.js';
import { hullExtent } from '../join/joinConstants.js';
import type { ShipState } from '../schema/SectorState.js';
import type { WingmanPilots } from './wingmanPilots.js';

/** RTS fleet commands per session per tick (all five kinds together). The
 *  client sends one per click / key / panel button; a flood beyond this is
 *  silently dropped (src/server/CLAUDE.md thresholds). */
export const MAX_FLEET_MSGS_PER_TICK = 4;

/** What the fleet hooks need from the room; getters read the live field. */
export interface FleetRoomHooksHost {
  state(): { ships: MapSchema<ShipState> };
  fleet: Pick<FleetCommandSubsystem, 'statusFor' | 'ordersOf' | 'ownerOfAttached' | 'squadOf' | 'escortTargetOf' | 'size' | 'idAt' | 'ownerAt'>;
  clients(): readonly Client[];
  sessionToPlayer(): ReadonlyMap<string, string>;
  playerToSession(): ReadonlyMap<string, string>;
  playerToActiveShipInstance: ReadonlyMap<string, string>;
  lingeringSlots: ReadonlyMap<string, number>;
  spectateParkedHull: Map<string, string>;
  sabF32(): Float32Array;
  serverTick(): number;
  sectorKey(): string | null;
  aiController(): Pick<AiController, 'markHostile' | 'noteDamage'>;
  wingmen(): Pick<WingmanPilots, 'hostileActorOf'>;
  getActiveShip(playerId: string): ShipState | undefined;
  displaceActiveHullToLingering(playerId: string): void;
}

export class FleetRoomHooks {
  constructor(private readonly h: FleetRoomHooksHost) {}

  /** RTS fleet commands (`fleet_order` / `set_mode` / `set_stance` /
   *  `form_squad` / `disband_squad`) received this tick, per session. */
  readonly fleetMsgCountThisTick = new Map<string, number>();
  /** Count one fleet command for `sessionId`; false = over this tick's cap (drop it). */
  fleetMsgAllowed(sessionId: string): boolean {
    const n = this.fleetMsgCountThisTick.get(sessionId) ?? 0;
    if (n >= MAX_FLEET_MSGS_PER_TICK) return false;
    this.fleetMsgCountThisTick.set(sessionId, n + 1);
    return true;
  }
  /** RTS slice 7 — the owner-only `fleet_status` stream (on the selection-stats timer). */
  fleetStatus!: FleetStatusStream;
  /** RTS review 2026-11-14 — an accepted fleet command sends its owner's
   *  status right after the ships re-plan, not on the next timer fire. */
  readonly fleetStatusSoon = new FleetStatusSoon(FLEET_STATUS_SOON_TICKS);
  /** Bound sender for `fleetStatusSoon.flush` (no per-tick closure, #14). */
  readonly sendFleetStatusNow = (sessionId: string): void => {
    const pid = this.h.sessionToPlayer().get(sessionId);
    if (pid !== undefined) this.fleetStatus.sendTo(sessionId, pid);
  };

  /** Build the `fleet_status` stream (called from `onCreate`, beside the
   *  selection-stats subsystem whose timer it rides). */
  createFleetStatus(): void {
    // RTS slice 7 — owner-only fleet status rides the same timer, every other
    // fire (~2.5 Hz). Private per owner, so a message, not a snapshot field.
    this.fleetStatus = new FleetStatusStream({
      fleet: this.h.fleet,
      forEachSession: (cb) => {
        for (const c of this.h.clients()) {
          const pid = this.h.sessionToPlayer().get(c.sessionId);
          if (pid !== undefined) cb(c.sessionId, pid);
        }
      },
      shieldPct: (id) => {
        const s = this.h.state().ships.get(id);
        if (!s) return null;
        const max = effectiveShipShieldMax(getShipKind(s.kind).shieldMax, s.statAlloc);
        return max > 0 ? (s.shield / max) * 100 : null;
      },
      send: (sessionId, msg) => {
        const client = this.h.clients().find((c) => c.sessionId === sessionId);
        try { client?.send('fleet_status', msg); } catch { /* closing */ }
      },
      // The ship the owner flies goes back out under their playerId (4b).
      wireShipId: (ownerId, id) => (this.h.playerToActiveShipInstance.get(ownerId) === id ? ownerId : id),
    });
  }

  /** RTS Part B slice 4: an owned ship was hit — it and every squadmate of
   *  the same owner turn on the shooter through the shared AI's retaliation
   *  ledger (`AiController.markHostile`). The shooter is keyed by its owner
   *  (`hostileActorOf`: a hull's shot counts for its owning player), so one
   *  mark covers that player's active ship and parked hulls. The owner's own
   *  fire never turns their ships. Only ships an AI pilot flies are marked
   *  (the pilot's own ship is theirs to fly). Slice 10 (owner 2026-11-15): a
   *  guarded ship counts as a member of the squad (or lone ship) escorting
   *  it, so a hit on it turns its escorts and a hit on an escort turns the
   *  guarded ship when an AI pilot flies it. `hitId`: an AI-flown hull, or
   *  any other ship (a pilot's by playerId) that may be escorted.
   *  Event-driven, alloc-free. */
  ownedHullRetaliates(hitId: string, shooterId: string): void {
    const fleet = this.h.fleet;
    let shipId = hitId;
    let ownerId = fleet.ownerOfAttached(hitId);
    if (ownerId === null) {
      // A pilot's active ship (by playerId), in the fleet's id space.
      const active = this.h.playerToActiveShipInstance.get(hitId);
      if (active === undefined) return;
      shipId = active;
      ownerId = hitId;
    }
    const actor = shooterId === '' ? '' : this.h.wingmen().hostileActorOf(shooterId);
    if (actor === '' || actor === ownerId) return;
    const tick = this.h.serverTick();
    const ai = this.h.aiController();
    if (shipId === hitId) ai.markHostile(hitId, actor, tick);
    const sq = fleet.squadOf(shipId);
    if (sq !== null && sq.ownerId === ownerId) {
      for (let i = 0; i < sq.memberIds.length; i++) {
        const mid = sq.memberIds[i]!;
        if (mid !== shipId && fleet.ownerOfAttached(mid) === ownerId) ai.markHostile(mid, actor, tick);
      }
    }
    // The guarded ship is one of its escorts' squad: the ship this one
    // escorts, and every ship escorting this one.
    const guarded = fleet.escortTargetOf(shipId);
    if (guarded !== null && fleet.ownerOfAttached(guarded) === ownerId) ai.markHostile(guarded, actor, tick);
    for (let i = 0; i < fleet.size; i++) {
      const id = fleet.idAt(i);
      if (id !== shipId && fleet.ownerAt(i) === ownerId && fleet.escortTargetOf(id) === shipId) ai.markHostile(id, actor, tick);
    }
  }

  /** RTS Part B slice 4: the hull an owned ship lost to a hit, into the AI
   *  pilot brain's morale data (`AiController.noteDamage`; owned ships roll
   *  but never run: players-side morale weights). `hullBefore` is the hull
   *  before the hit; a hit the shield soaked notes nothing. */
  noteOwnedHullDamage(hullId: string, hullBefore: number): void {
    const ship = this.h.state().ships.get(hullId);
    if (!ship || !ship.alive) return;
    const hullLost = hullBefore - Math.max(0, ship.health);
    if (hullLost > 0) this.h.aiController().noteDamage(hullId, hullLost, this.h.serverTick(), ship.maxHealth > 0 ? ship.maxHealth : undefined);
  }

  /** STOP PILOTING (the `spectate` and `command` messages): park the caller's
   *  active hull as a lingering wingman and remember it as their parked hull. */
  enterSpectate(playerId: string): void {
    const parked = this.h.getActiveShip(playerId)?.shipInstanceId;
    this.h.displaceActiveHullToLingering(playerId);
    // Owner decision 2026-11-12: the parked hull is still there. NPC fire
    // control keeps engaging it on the pilot's behalf (their locks hold).
    if (parked && this.h.lingeringSlots.has(parked)) this.h.spectateParkedHull.set(playerId, parked);
  }

  /** RTS slice 10 — a `startMode: 'command'` join reached its arrival flip:
   *  park the hull through the same path as the `command` message and tell the
   *  client (`control_mode`) so it drops its prediction body and enters command
   *  view. The snapshot (own hull inactive, a parked hull in `mirror.ships`) carries the
   *  state (#16); the message only makes the flip immediate. */
  startInCommand(playerId: string, sessionId: string): void {
    this.enterSpectate(playerId);
    const client = this.h.clients().find((c) => c.sessionId === sessionId);
    client?.send('control_mode', { type: 'control_mode', mode: 'command' });
    serverLogEvent('command_start', { playerId, sectorKey: this.h.sectorKey() });
  }

  /** Live pose + extent of each of `shipIds` that is a parked hull here (a
   *  fleet warp; discrete, allocates). `idsOut` (when given) gets the ids in
   *  the same order. */
  fleetHullPoses(shipIds: readonly string[], idsOut: string[] | null): FleetHullPose[] {
    const out: FleetHullPose[] = [];
    const sabF32 = this.h.sabF32();
    for (let i = 0; i < shipIds.length; i++) {
      const id = shipIds[i]!;
      const slot = this.h.lingeringSlots.get(id);
      const ship = this.h.state().ships.get(id);
      if (slot === undefined || ship === undefined) continue;
      const b = slotBase(slot);
      out.push({ x: sabF32[b + SLOT_X_OFF]!, y: sabF32[b + SLOT_Y_OFF]!, radius: hullExtent(ship.kind) });
      idsOut?.push(id);
    }
    return out;
  }

  /** Send the commander's fleet status soon (after a warp hold / release). */
  fleetStatusSoonFor(playerId: string): void {
    const sessionId = this.h.playerToSession().get(playerId);
    if (sessionId !== undefined) this.fleetStatusSoon.request(sessionId, this.h.serverTick());
  }
}
