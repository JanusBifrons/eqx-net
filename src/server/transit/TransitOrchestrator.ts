/**
 * TransitOrchestrator — Phase 8 sub-phase B server-side driver.
 *
 * One instance per `SectorRoom`. Owns a per-player `TransitStateMachine` and
 * the timers + listeners that drive a transit from spool-up to commit.
 *
 * Vulnerable spool-up by design: the player's ship STAYS in the source room
 * during the 3 s spool, fully damageable. If the ship dies during spool the
 * orchestrator subscribes to SHIP_DESTROYED and cancels transit cleanly
 * (the death flow takes over). The player can also send `cancel_transit`.
 *
 * On commit (no abort fired by the spool timer):
 *   1. Read SAB pose (NOT Colyseus schema — SAB is 60 Hz ground truth).
 *   2. Build a LimboPayload with `sectorKey: targetSectorKey`, 30 s TTL.
 *   3. `limboStore.put(playerId, payload, LIMBO_TRANSIT_TTL_MS)`.
 *   4. `matchMaker.reserveSeatFor(\`galaxy-\${target}\`, { playerId, transitToken })`.
 *   5. Mark `room.playerToTransitInFlight.add(playerId)` so the impending
 *      `onLeave` skips its own Limbo put (the transit-in-flight entry is
 *      already there with the destination sector key).
 *   6. Send `transit_ready` so the client can `consumeSeatReservation`.
 *
 * The destination's `onJoin` then `take`s the Limbo entry and the pilot
 * appears at the same `(x, y, vx, vy, angle, angvel, health, lastFireClientTick)`.
 *
 * See [TransitStateMachine](../../core/transit/TransitStateMachine.ts) and
 * docs/features/phase-8-galaxy-and-transit.md (sub-phase C).
 */
import { matchMaker, type Client } from 'colyseus';
import { TransitStateMachine, SPOOL_DURATION_MS } from '../../core/transit/TransitStateMachine.js';
import type { Bus } from '../../core/events/Bus.js';
import type { PlayerShipStore } from '../playerShips/PlayerShipStore.js';
import { isNeighbour } from '../../core/galaxy/galaxy.js';
import { auditEvent } from '../audit/GameplayAuditLog.js';
import type { TransitStateMessage, TransitCancelReason } from '../../shared-types/messages.js';
import { randomUUID } from 'node:crypto';
import {
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_ANGVEL_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { clampToSectorBounds } from '../../shared-types/sectorBounds.js';
import { SHIP_MAX_HEALTH } from '../../core/combat/Weapons.js';
import { getIncomingPlayerSink } from '../livingworld/incomingPlayerSink.js';
import { issueTransitIdentity } from '../identity/TransitIdentityTokens.js';
import { gameClock, type GameTimer } from '../time/gameTime.js';
import type { GameClock } from '../../core/clock/GameClock.js';

/**
 * Narrow interface the orchestrator needs from its host room. SectorRoom
 * satisfies this; tests inject a mock that implements only these members.
 */
export interface TransitHostRoom {
  /** Stable galaxy sector key of THIS room (the source). */
  readonly sectorKey: string | null;
  readonly bus: Bus;
  readonly sabF32: Float32Array;
  /** Per-player SAB slot — used to read pose for the LimboPayload. */
  readonly playerToSlot: ReadonlyMap<string, number>;
  readonly playerToUser: ReadonlyMap<string, string | null>;
  /** Per-player active ship-instance id (the roster shipId of the live hull).
   *  WS-B: `commitTransit` re-homes the transit reservation onto this roster
   *  row (markStored at the destination sector) instead of writing Limbo. */
  readonly playerToActiveShipInstance: ReadonlyMap<string, string>;
  readonly lastFireClientTick: ReadonlyMap<string, number>;
  /** Per-room schema map — used to read live health (not in SAB). */
  getShipHealth(playerId: string): number;
  /** Campaign 3.1 — does this player currently have a LIVE hull?
   *  A warp needs one: the SHIP_DESTROYED abort only covers death DURING
   *  the spool, so without this gate an already-dead (spectating) player
   *  could start spooling a warp for a hull that doesn't exist.
   *  Deliberately ALIVE-only, NOT `isActive` — a PENDING hull (joined but
   *  pre-`client_ready`) has always been allowed to engage transit, and a
   *  dead player has no active `state.ships` entry at all (it's removed or
   *  rekeyed to `linger-<id>`), so `alive` fully covers the reported bug.
   *  Gating on `isActive` broke the Phase-A9 transit wiring locks
   *  (`transitShipIdBinding` — `connectAs` clients are pending forever). */
  hasLiveHull(playerId: string): boolean;
  /** Per-room schema lookup — used to preserve the player's chosen ship kind
   *  across the transit hop. */
  getShipKind(playerId: string): string;
  /** The set of playerIds currently mid-transit; commitTransit adds, onLeave checks. */
  playerToTransitInFlight: Set<string>;
  /** Look up the live Colyseus client for a given playerId. */
  clientForPlayer(playerId: string): Client | null;
  /** Colyseus room-broadcast. `except` excludes the named client(s) —
   *  used to emit warp_out to everyone in the source sector except the
   *  player who's leaving (the leaver gets their own local-warp visual
   *  from the `transit_state` machinery). */
  broadcast(type: string, message: unknown, options?: { except?: Client | Client[] }): void;

  // ── RTS fleet warp (the selected ships warp together) ─────────────────
  /** May `shipId` join a fleet warp ordered by `commanderId`? True only for a
   *  LINGERING hull parked in this room (`lingeringSlots`), alive
   *  (`isLingeringHull`), owned by the commander. The orchestrator itself
   *  checks "not already in another fleet warp". */
  canFleetWarp(commanderId: string, shipId: string): boolean;
  /** Hold the ships still while they spool: the existing fleet `stop` order. */
  holdFleetShips(commanderId: string, shipIds: readonly string[]): void;
  /** Let go of the hold (cancel / drop-out): clear the order so each ship
   *  goes back to its mode. */
  releaseFleetShips(commanderId: string, shipIds: readonly string[]): void;
  /** The point the group arrives round when no arrival point was picked
   *  (a hull's live pose). Null ⇒ none of the ids has a pose. */
  fleetAnchor(shipIds: readonly string[]): { x: number; y: number } | null;
  /** Move the parked hulls to `destSectorKey`, round `anchor`. Returns the
   *  ids that moved; the rest stay here (and are released). Removing a hull
   *  here runs `detachWingman` → `dropHull`, which the commit ignores. */
  handOffHulls(shipIds: readonly string[], destSectorKey: string, anchor: { x: number; y: number }): readonly string[];
}

/** RTS fleet warp — the group part of an in-flight record. */
interface FleetGroup {
  /** Members: parked hulls, plus the one the commander took the controls of. */
  hullIds: Set<string>;
  /** A member the commander is flying ("you go with them"): it travels by the
   *  pilot path (the commander's seat), the others by `handOffHulls`. */
  pilotedId: string | null;
  /** A reclaim of this member is under way: its `detachWingman` → `dropHull`
   *  is the hull leaving lingering to be flown, not leaving the group. */
  takingId: string | null;
  /** The commit is running: removals it makes itself are not drops. */
  committing: boolean;
  /** When the spool began (the clock's ms), for the banner's countdown left. */
  startedAtMs: number;
}

interface InFlight {
  /** Who gets `transit_state` (the pilot, or the fleet's commander). */
  commanderId: string;
  /** Non-null for a fleet warp (key `fleet:<commander>:<n>`). */
  fleet: FleetGroup | null;
  machine: TransitStateMachine;
  targetSectorKey: string;
  transitToken: string;
  /** Optional client-requested arrival pose. Absent ⇒ commitTransit reads
   *  the SAB pose at commit time (default behaviour). Present ⇒ commit
   *  uses these (server-clamped to playable bounds) for x/y. vx/vy/angle
   *  always come from the SAB. */
  arrival: { x: number; y: number } | null;
  /** Phase 5 — when set, the destination room binds this roster entry
   *  instead of letting the source ship continue. Already validated for
   *  ownership at `beginTransit` time. Threaded through `reserveSeatFor`'s
   *  options bag so the destination's `onJoin` can pick it up. */
  shipId: string | null;
  /** Timer that fires the commit unless aborted earlier. */
  commitTimer: GameTimer;
  /** One-shot bus listener — must be unsubscribed on cancel + commit. */
  onShipDestroyed: (evt: { type: 'SHIP_DESTROYED'; targetId: string; shooterId: string }) => void;
}

/**
 * Phase-4 P0 — a cosmetic display label for an inbound player on the "incoming"
 * banner. Uses the userId (email-ish) trimmed to the local part, capped at the
 * wire's 64-char label bound; falls back to "Pilot" when anonymous. Label only —
 * never an identity.
 */
function incomingPlayerLabel(userId: string | null | undefined): string {
  if (!userId) return 'Pilot';
  const local = userId.includes('@') ? userId.slice(0, userId.indexOf('@')) : userId;
  const trimmed = local.trim();
  if (trimmed.length === 0) return 'Pilot';
  return trimmed.slice(0, 64);
}

/**
 * Reserve a seat on a destination room by name. Default implementation
 * queries the matchmaker, picks the live room, and calls `reserveSeatFor`.
 * Test seam — `setReserveByNameOverride` replaces this entirely.
 *
 * Phase 5 — `options.shipId` (optional) tells the destination room to
 * bind a specific roster entry on arrival; absent ⇒ destination uses the
 * Limbo entry's source-ship pose (today's behaviour).
 */
export interface ReserveOptions {
  playerId: string;
  transitToken: string;
  shipId?: string;
  /** RTS fleet warp: the commander arrives with no ship (join-as-spectator)
   *  at (spawnX, spawnY), the fleet's arrival anchor. */
  spectator?: boolean;
  spawnX?: number;
  spawnY?: number;
}

export type ReserveByName = (
  roomName: string,
  options: ReserveOptions,
) => Promise<unknown>;

/** Most ids a fleet warp reads (the wire allows the same). */
const FLEET_WARP_MAX_IDS = 64;
/** The incoming banner's label for a fleet: "3 × ships warping in". */
const FLEET_INCOMING_LABEL = 'ship';

const defaultReserveByName: ReserveByName = async (roomName, options) => {
  const rooms = await matchMaker.query({ name: roomName });
  if (rooms.length === 0) throw new Error(`no live room named ${roomName}`);
  return matchMaker.reserveSeatFor(rooms[0]!, options);
};

export class TransitOrchestrator {
  /** Keyed by playerId for a pilot warp, `fleet:<commander>:<n>` for a fleet
   *  warp (several fleet warps may run at once, each its own record). */
  private inFlight = new Map<string, InFlight>();
  /** Fleet warp: member ship id → its group's key. */
  private hullToGroup = new Map<string, string>();
  private fleetSeq = 0;
  /** Override for tests. Production is the live colyseus matchMaker. */
  private reserveByNameFn: ReserveByName = defaultReserveByName;

  constructor(
    private readonly room: TransitHostRoom,
    private readonly spoolMs: number = SPOOL_DURATION_MS,
    /** PlayerShipStore — validates roster ownership when `beginTransit` is
     *  called with a `shipId` (Phase 5), AND (WS-B) is where `commitTransit`
     *  re-homes the transit reservation (markStored at the destination sector).
     *  Required in production; when omitted (legacy test fixtures), a `shipId`
     *  argument is rejected as unknown and the re-home is skipped. */
    private readonly playerShipStore?: PlayerShipStore,
    /** The sector's game clock (game speed is per sector): spools run on it.
     *  Defaults to the process clock (unit fixtures). */
    private readonly clock: GameClock = gameClock,
  ) {}

  /** Test seam — replace the matchMaker query+reserve pair with a stub. */
  setReserveByNameOverride(fn: ReserveByName): void {
    this.reserveByNameFn = fn;
  }

  /** Read-only snapshot for tests / diag routes. */
  isInFlight(playerId: string): boolean {
    return this.inFlight.has(playerId);
  }

  /**
   * Begin a transit. Validates that the source has a `sectorKey` and that
   * the target is a direct neighbour. On reject, sends a `transit_state`
   * back to DOCKED with the appropriate reason and returns false.
   *
   * `arrival` (optional): client-requested arrival x/y. Stored on the
   * in-flight record and consumed by `commitTransit`. If absent, the
   * server falls back to the SAB pose at commit time (legacy behaviour).
   *
   * `shipId` (optional, Phase 5): when set, the destination room will
   * bind this roster entry instead of letting the source ship continue.
   * Validated for ownership against `PlayerShipStore`; foreign or
   * unknown ids reject with `destination_unavailable`. Threaded through
   * `reserveSeatFor` options so the destination's `onJoin` can read it.
   */
  beginTransit(
    playerId: string,
    targetSectorKey: string,
    arrival?: { x: number; y: number },
    shipId?: string,
  ): boolean {
    const src = this.room.sectorKey;
    if (src === null) {
      // Engineering room — transit is a galaxy-only feature.
      this.sendState(playerId, { type: 'transit_state', state: 'DOCKED', reason: 'manual' });
      return false;
    }
    if (!isNeighbour(src, targetSectorKey)) {
      this.sendState(playerId, { type: 'transit_state', state: 'DOCKED', reason: 'not_neighbour' });
      return false;
    }
    // Campaign 3.1 (anti-patterns review A14) — a warp needs a LIVE hull.
    // The SHIP_DESTROYED subscription below only aborts a death DURING the
    // spool; an already-dead (spectating) player used to sail straight into
    // SPOOLING ("I'm dead!!! How can I warp?", Equinox Phase 6). Alive-only:
    // a pending (pre-client_ready) hull may still warp — see the seam doc.
    if (!this.room.hasLiveHull(playerId)) {
      this.sendState(playerId, {
        type: 'transit_state',
        state: 'DOCKED',
        targetSectorKey,
        reason: 'destroyed',
      });
      return false;
    }
    if (this.inFlight.has(playerId)) {
      // Already spooling — second request is a no-op.
      return false;
    }
    // RTS fleet warp: the ship they fly is in a spooling fleet warp (they took
    // its controls), so it already goes with the fleet. No second warp.
    const flying = this.room.playerToActiveShipInstance.get(playerId);
    if (flying !== undefined && this.hullToGroup.has(flying)) return false;

    // Phase 5 — ownership validation. A client can pass any roster shipId
    // they like; we reject foreign / unknown ids before spinning up the
    // machine. This is the single load-bearing check that prevents ship
    // hijacking via `engage_transit`.
    if (shipId !== undefined) {
      const rec = this.playerShipStore?.get(shipId);
      if (!rec || rec.playerId !== playerId) {
        this.sendState(playerId, {
          type: 'transit_state',
          state: 'DOCKED',
          targetSectorKey,
          reason: 'destination_unavailable',
        });
        return false;
      }
    }

    const machine = new TransitStateMachine(playerId, this.room.bus, this.spoolMs);
    machine.beginSpool(this.clock.now());

    const transitToken = randomUUID();
    const onShipDestroyed: InFlight['onShipDestroyed'] = (evt) => {
      if (evt.targetId === playerId) this.cancelTransit(playerId, 'destroyed');
    };
    this.room.bus.on('SHIP_DESTROYED', onShipDestroyed);

    const commitTimer = this.clock.after(this.spoolMs, () => {
      void this.commitTransit(playerId);
    });

    this.inFlight.set(playerId, {
      commanderId: playerId,
      fleet: null,
      machine,
      targetSectorKey,
      transitToken,
      arrival: arrival ? { x: arrival.x, y: arrival.y } : null,
      shipId: shipId ?? null,
      commitTimer,
      onShipDestroyed,
    });

    this.sendState(playerId, {
      type: 'transit_state',
      state: 'SPOOLING',
      spoolMs: this.spoolMs,
      targetSectorKey,
    });

    // Phase-4 P0 — announce this player as a FRIENDLY inbound to the destination
    // sector's occupants the moment they elect to warp (spool start). Cleared on
    // arrival (destination `client_ready`) or abort (`cancelTransit`). Null-safe:
    // no sink ⇒ no banner (Living World disabled / test harness). `src` is the
    // source sectorKey (non-null — engineering rooms returned early above).
    getIncomingPlayerSink()?.registerIncomingPlayer({
      playerId,
      destSectorKey: targetSectorKey,
      sourceSectorKey: src,
      label: incomingPlayerLabel(this.room.playerToUser.get(playerId)),
      etaMs: this.spoolMs,
    });
    return true;
  }

  /**
   * v4 T3 — a teleporter jump to another sector: an INSTANT hop to any sector
   * (no neighbour check, no spool; the teleporter's own cycle was the wait),
   * landing at `arrival` on the partner pad. Reuses the normal commit path
   * (seat reservation, roster re-home, `transit_ready`), so the arrival is
   * the same shipId-restore every warp uses.
   */
  teleportOut(playerId: string, targetSectorKey: string, arrival: { x: number; y: number }): boolean {
    if (this.room.sectorKey === null || this.inFlight.has(playerId) || !this.room.hasLiveHull(playerId)) return false;
    const machine = new TransitStateMachine(playerId, this.room.bus, 1);
    machine.beginSpool(this.clock.now());
    const onShipDestroyed: InFlight['onShipDestroyed'] = () => undefined;
    this.room.bus.on('SHIP_DESTROYED', onShipDestroyed);
    this.inFlight.set(playerId, {
      commanderId: playerId,
      fleet: null,
      machine,
      targetSectorKey,
      transitToken: randomUUID(),
      arrival: { x: arrival.x, y: arrival.y },
      shipId: null,
      commitTimer: this.clock.after(0, () => undefined),
      onShipDestroyed,
    });
    void this.commitTransit(playerId);
    return true;
  }

  /** Cancel an in-flight spool. Legal from SPOOLING only — once committed
   *  the destination has a reservation. */
  cancelTransit(playerId: string, reason: TransitCancelReason): void {
    const inFlight = this.inFlight.get(playerId);
    if (!inFlight) return;
    if (inFlight.machine.rawState !== 'SPOOLING') return;
    // A fleet commit in progress owns the record (its seat may be reserved).
    if (inFlight.fleet?.committing) return;
    inFlight.commitTimer.cancel();
    this.room.bus.off('SHIP_DESTROYED', inFlight.onShipDestroyed);
    inFlight.machine.cancel();
    this.inFlight.delete(playerId);
    // RTS fleet warp: let go of the ships still in the group (they go back to
    // their modes) and forget the membership.
    if (inFlight.fleet !== null) this.releaseGroup(inFlight);
    // Phase-4 P0 — the spool aborted; clear the friendly inbound banner. A
    // fleet's banner is registered under its group key (= `playerId` here).
    getIncomingPlayerSink()?.clearIncomingPlayer(playerId, inFlight.targetSectorKey);
    this.sendState(inFlight.commanderId, {
      type: 'transit_state',
      state: 'DOCKED',
      targetSectorKey: inFlight.targetSectorKey,
      reason,
    });
  }

  // ── RTS fleet warp ─────────────────────────────────────────────────────
  //
  // "Warp here" in Command view warps the SELECTED ships together; the
  // commander's seat follows them. Same state machine, timer, `transit_state`
  // and incoming banner as a pilot warp; one in-flight record per GROUP
  // (key `fleet:<commander>:<n>`), so several fleet warps can run at once.
  // The commander may have no ship at all, so this branch never asks for a
  // live hull or a player slot. See docs/architecture/fleet-command.md.

  /**
   * Begin a fleet warp of `shipIds` to `targetSectorKey`. Each id is checked
   * (`canFleetWarp`: parked here, alive, owned by the commander) and must not
   * already be in a fleet warp; others drop silently. None valid ⇒ DOCKED
   * `no_ships`. The valid ships hold still (fleet `stop`) while they spool and
   * stay damageable. Returns the group key, or null on a reject.
   */
  beginFleetTransit(
    commanderId: string,
    targetSectorKey: string,
    shipIds: readonly string[],
    arrival?: { x: number; y: number },
  ): string | null {
    const src = this.room.sectorKey;
    if (src === null) {
      this.sendState(commanderId, { type: 'transit_state', state: 'DOCKED', reason: 'manual' });
      return null;
    }
    if (!isNeighbour(src, targetSectorKey)) {
      this.sendState(commanderId, { type: 'transit_state', state: 'DOCKED', reason: 'not_neighbour' });
      return null;
    }
    const ids = new Set<string>(); // off the tick: one message per Warp click
    const n = Math.min(shipIds.length, FLEET_WARP_MAX_IDS);
    for (let i = 0; i < n; i++) {
      const id = shipIds[i]!;
      if (ids.has(id) || this.hullToGroup.has(id)) continue;
      if (!this.room.canFleetWarp(commanderId, id)) continue;
      ids.add(id);
    }
    if (ids.size === 0) {
      this.sendState(commanderId, {
        type: 'transit_state', state: 'DOCKED', targetSectorKey, reason: 'no_ships',
      });
      return null;
    }

    const key = `fleet:${commanderId}:${++this.fleetSeq}`;
    const machine = new TransitStateMachine(commanderId, this.room.bus, this.spoolMs);
    const nowMs = this.clock.now();
    machine.beginSpool(nowMs);
    const group: FleetGroup = {
      hullIds: ids, pilotedId: null, takingId: null, committing: false, startedAtMs: nowMs,
    };
    // The commander's own ship dying matters only when it is the member they
    // took the controls of (a parked member's death comes in via `dropHull`).
    const onShipDestroyed: InFlight['onShipDestroyed'] = (evt) => {
      if (evt.targetId !== commanderId || group.pilotedId === null) return;
      const piloted = group.pilotedId;
      // Parked again (they let go of it) ⇒ it is a hull, not the dead ship.
      if (this.room.canFleetWarp(commanderId, piloted)) { group.pilotedId = null; return; }
      this.dropHull(piloted);
    };
    this.room.bus.on('SHIP_DESTROYED', onShipDestroyed);
    const commitTimer = this.clock.after(this.spoolMs, () => {
      void this.commitTransit(key);
    });
    this.inFlight.set(key, {
      commanderId,
      fleet: group,
      machine,
      targetSectorKey,
      transitToken: randomUUID(),
      arrival: arrival ? { x: arrival.x, y: arrival.y } : null,
      shipId: null,
      commitTimer,
      onShipDestroyed,
    });
    for (const id of ids) this.hullToGroup.set(id, key);

    // Hold them still (they stay damageable) until the jump.
    this.room.holdFleetShips(commanderId, [...ids]);
    this.sendState(commanderId, {
      type: 'transit_state', state: 'SPOOLING', spoolMs: this.spoolMs, targetSectorKey,
    });
    this.announceGroup(key, src, targetSectorKey, ids.size, this.spoolMs);
    return key;
  }

  /** The group key a ship is spooling with, or null. */
  fleetGroupOf(shipId: string): string | null {
    return this.hullToGroup.get(shipId) ?? null;
  }

  /** The members of a spooling fleet warp (test / diag read). */
  fleetMembers(groupKey: string): readonly string[] {
    const g = this.inFlight.get(groupKey)?.fleet;
    return g ? [...g.hullIds] : [];
  }

  /**
   * The ONE drop point: a member left the world or stopped being a parked hull
   * (`SectorRoom.detachWingman` calls this for every lingering exit). Ignored
   * during the group's own commit and for the member the commander is taking
   * the controls of. A group left empty cancels (`destroyed`).
   */
  dropHull(shipId: string): void {
    const key = this.hullToGroup.get(shipId);
    if (key === undefined) return;
    const inFlight = this.inFlight.get(key);
    const g = inFlight?.fleet;
    if (!inFlight || !g) { this.hullToGroup.delete(shipId); return; }
    if (g.committing) return;
    if (g.takingId === shipId) {
      // The reclaim's own detach: the commander now flies it and goes with them.
      g.takingId = null;
      g.pilotedId = shipId;
      return;
    }
    this.removeMember(key, inFlight, shipId, 'destroyed');
  }

  /**
   * The commander is taking the controls of `shipId` (the room calls this just
   * before the reclaim detaches the hull). If it is spooling in one of their
   * fleet warps, it STAYS in the group and the commander goes with them: at the
   * jump it travels by the pilot path (their seat), the rest as hulls.
   */
  noteTakeControls(commanderId: string, shipId: string): void {
    const key = this.hullToGroup.get(shipId);
    if (key === undefined) return;
    const inFlight = this.inFlight.get(key);
    if (!inFlight?.fleet || inFlight.commanderId !== commanderId) return;
    inFlight.fleet.takingId = shipId;
  }

  /**
   * A new order / mode / stance reached these ships (the fleet command
   * handlers call this with the ids the command named). Those spooling in one
   * of the caller's fleet warps drop out and obey. An order replaces the hold
   * by itself; a mode or stance does not, so `releaseHold` lets go of it.
   */
  fleetCommandIssued(commanderId: string, shipIds: readonly string[], releaseHold: boolean): void {
    for (let i = 0; i < shipIds.length; i++) {
      const id = shipIds[i]!;
      const key = this.hullToGroup.get(id);
      if (key === undefined) continue;
      const inFlight = this.inFlight.get(key);
      if (!inFlight?.fleet || inFlight.commanderId !== commanderId) continue;
      if (inFlight.fleet.committing || inFlight.fleet.pilotedId === id) continue;
      if (releaseHold) this.room.releaseFleetShips(commanderId, [id]);
      this.removeMember(key, inFlight, id, 'manual');
    }
  }

  /** Cancel every spooling fleet warp the commander ordered (their
   *  `cancel_transit`). A disconnect does NOT call this: the ships still go. */
  cancelFleetTransits(commanderId: string, reason: TransitCancelReason): void {
    for (const [key, f] of [...this.inFlight]) {
      if (f.fleet !== null && f.commanderId === commanderId) this.cancelTransit(key, reason);
    }
  }

  /** Take one member out of its group; an emptied group cancels. */
  private removeMember(key: string, inFlight: InFlight, shipId: string, emptyReason: TransitCancelReason): void {
    const g = inFlight.fleet!;
    g.hullIds.delete(shipId);
    this.hullToGroup.delete(shipId);
    if (g.pilotedId === shipId) g.pilotedId = null;
    if (g.takingId === shipId) g.takingId = null;
    if (g.hullIds.size === 0) { this.cancelTransit(key, emptyReason); return; }
    const src = this.room.sectorKey;
    const left = Math.max(1, this.spoolMs - (this.clock.now() - g.startedAtMs));
    if (src !== null) this.announceGroup(key, src, inFlight.targetSectorKey, g.hullIds.size, left);
  }

  /** Release the hold on the group's remaining ships and forget them. */
  private releaseGroup(inFlight: InFlight): void {
    const g = inFlight.fleet!;
    const ids = [...g.hullIds];
    if (g.pilotedId !== null) {
      // The ship the commander flies has no hold to release.
      const at = ids.indexOf(g.pilotedId);
      if (at >= 0) ids.splice(at, 1);
    }
    if (ids.length > 0) this.room.releaseFleetShips(inFlight.commanderId, ids);
    for (const id of g.hullIds) this.hullToGroup.delete(id);
    g.hullIds.clear();
  }

  /** The friendly "N × ships warping in" banner at the destination. */
  private announceGroup(key: string, src: string, dest: string, count: number, etaMs: number): void {
    getIncomingPlayerSink()?.registerIncomingPlayer({
      playerId: key,
      destSectorKey: dest,
      sourceSectorKey: src,
      label: FLEET_INCOMING_LABEL,
      etaMs,
      count,
    });
  }

  /**
   * Fleet commit. Order: (1) work out who goes (the flown member by the pilot
   * path, parked members as hulls; each re-checked now); (2) reserve the
   * commander's seat FIRST — the pilot seat when they fly a member, else a
   * shipless spectator seat at the arrival anchor — skipped when the
   * commander is not connected; (3) hand the hulls off. A seat that can't be
   * reserved aborts the whole jump (`destination_unavailable`).
   */
  private async commitFleet(key: string, inFlight: InFlight): Promise<void> {
    const g = inFlight.fleet!;
    const cmd = inFlight.commanderId;
    const dest = inFlight.targetSectorKey;
    this.room.bus.off('SHIP_DESTROYED', inFlight.onShipDestroyed);
    g.committing = true;

    const piloted = g.pilotedId !== null
      && this.room.playerToActiveShipInstance.get(cmd) === g.pilotedId
      && this.room.hasLiveHull(cmd)
      && this.room.playerToSlot.has(cmd)
      ? g.pilotedId : null;
    const hulls: string[] = [];
    for (const id of g.hullIds) if (id !== piloted && this.room.canFleetWarp(cmd, id)) hulls.push(id);

    const finish = (): void => {
      for (const id of g.hullIds) this.hullToGroup.delete(id);
      this.inFlight.delete(key);
      getIncomingPlayerSink()?.clearIncomingPlayer(key, dest);
    };

    if (hulls.length === 0 && piloted === null) {
      // Everyone was lost between the last drop and the jump.
      inFlight.machine.cancel();
      finish();
      this.sendState(cmd, { type: 'transit_state', state: 'DOCKED', targetSectorKey: dest, reason: 'destroyed' });
      return;
    }

    // The flown member's live pose (the commander's slot).
    let pilotX = 0, pilotY = 0, b = 0;
    if (piloted !== null) {
      b = slotBase(this.room.playerToSlot.get(cmd)!);
      pilotX = this.room.sabF32[b + SLOT_X_OFF]!;
      pilotY = this.room.sabF32[b + SLOT_Y_OFF]!;
    }
    const anchor = inFlight.arrival
      ? clampToSectorBounds(inFlight.arrival.x, inFlight.arrival.y)
      : (hulls.length > 0 ? this.room.fleetAnchor(hulls) : null) ?? { x: pilotX, y: pilotY };

    // (2) The commander's seat, BEFORE any hull moves. A commander flying a
    // ship OUTSIDE the group stays with that ship (a spectator seat would
    // leave it behind unparked), so only the hulls go.
    const followsFleet = piloted !== null || !this.room.hasLiveHull(cmd);
    const client = followsFleet ? this.room.clientForPlayer(cmd) : null;
    let reservation: unknown = null;
    if (client) {
      const opts: ReserveOptions = piloted !== null
        ? { playerId: cmd, transitToken: inFlight.transitToken, shipId: piloted }
        : { playerId: cmd, transitToken: inFlight.transitToken, spectator: true, spawnX: anchor.x, spawnY: anchor.y };
      try {
        issueTransitIdentity(inFlight.transitToken, cmd);
        reservation = await this.reserveByNameFn(`galaxy-${dest}`, opts);
      } catch {
        // No seat ⇒ nobody goes: the ships stay and go back to their modes.
        inFlight.machine.cancel();
        g.committing = false;
        this.releaseGroup(inFlight);
        finish();
        this.sendState(cmd, {
          type: 'transit_state', state: 'DOCKED', targetSectorKey: dest, reason: 'destination_unavailable',
        });
        return;
      }
      if (piloted !== null) {
        // The flown member re-homes exactly like a pilot warp (shipId restore).
        this.playerShipStore?.markStored(piloted, {
          x:      inFlight.arrival ? anchor.x : pilotX,
          y:      inFlight.arrival ? anchor.y : pilotY,
          vx:     this.room.sabF32[b + SLOT_VX_OFF]!,
          vy:     this.room.sabF32[b + SLOT_VY_OFF]!,
          angle:  this.room.sabF32[b + SLOT_ANGLE_OFF]!,
          angvel: this.room.sabF32[b + SLOT_ANGVEL_OFF]!,
          health: this.room.getShipHealth(cmd) ?? SHIP_MAX_HEALTH,
          lastFireClientTick: this.room.lastFireClientTick.get(cmd) ?? 0,
          sectorKey: dest,
        });
      }
      this.room.playerToTransitInFlight.add(cmd);
      auditEvent({
        event: 'transit_started', sector: this.room.sectorKey ?? undefined, playerId: cmd,
        from: this.room.sectorKey ?? undefined, to: dest,
      });
    }

    // (3) The parked hulls.
    const moved = hulls.length > 0 ? this.room.handOffHulls(hulls, dest, anchor) : [];
    const from = this.room.sectorKey ?? undefined;
    const adjacent = from ? isNeighbour(from, dest) : undefined;
    for (const id of moved) {
      auditEvent({ event: 'sector_change', entityKind: 'hull', id, sector: from, from, to: dest, adjacent });
    }
    if (piloted !== null && client) {
      auditEvent({ event: 'sector_change', entityKind: 'player', id: cmd, sector: from, from, to: dest, adjacent });
    }
    // Hulls that did not move stay here: let go of their hold.
    if (moved.length < hulls.length) {
      const movedSet = new Set(moved);
      const stayed = hulls.filter((id) => !movedSet.has(id));
      if (stayed.length > 0) this.room.releaseFleetShips(cmd, stayed);
    }

    inFlight.machine.beginTransit();
    if (client) {
      client.send('transit_state', {
        type: 'transit_state', state: 'IN_TRANSIT', targetSectorKey: dest,
      } satisfies TransitStateMessage);
      client.send('transit_ready', {
        type: 'transit_ready', reservation, transitToken: inFlight.transitToken, targetSectorKey: dest,
      });
      if (piloted !== null) {
        this.room.broadcast('warp_out', { type: 'warp_out', playerId: cmd, x: pilotX, y: pilotY }, { except: client });
      }
    } else {
      // The commander stays here (flying another ship): end their spool UI.
      this.sendState(cmd, { type: 'transit_state', state: 'DOCKED', targetSectorKey: dest });
    }
    inFlight.machine.arrive();
    inFlight.machine.reset();
    finish();
  }

  /** Internal — fired by the spool timer. Reserves the destination seat,
   *  re-homes the ship onto the roster at the destination sector (WS-B; the
   *  transit Limbo entry is retired), sends `transit_state` IN_TRANSIT (the
   *  client triggers consumeSeatReservation off the same message). */
  async commitTransit(playerId: string): Promise<void> {
    const inFlight = this.inFlight.get(playerId);
    if (!inFlight) return;
    if (inFlight.fleet !== null) return this.commitFleet(playerId, inFlight);
    // From this point forward, a SHIP_DESTROYED is the death flow's problem,
    // not transit's — the seat is reserved and the pilot is out the door.
    this.room.bus.off('SHIP_DESTROYED', inFlight.onShipDestroyed);

    const slot = this.room.playerToSlot.get(playerId);
    if (slot === undefined) {
      // Player vanished mid-spool (disconnect). Don't bother reserving — their
      // normal onLeave lingering path (roster markLinger) will handle it.
      this.inFlight.delete(playerId);
      return;
    }

    const b = slotBase(slot);
    // Position: prefer the client-requested arrival (clamped) when set,
    // otherwise fall through to the SAB pose. Velocity / angle / angvel
    // are always SAB — only the landing point is overridable.
    const sabX = this.room.sabF32[b + SLOT_X_OFF]!;
    const sabY = this.room.sabF32[b + SLOT_Y_OFF]!;
    const arrivalPos = inFlight.arrival
      ? clampToSectorBounds(inFlight.arrival.x, inFlight.arrival.y)
      : null;
    // WS-B (Phase 5): the hopping ship is an explicit roster-switch `shipId`, else
    // the player's active hull's roster id. Threaded through reserveSeatFor so the
    // destination's onJoin binds it via the shipId-restore path (Limbo retired).
    const shipInstanceId =
      inFlight.shipId ?? this.room.playerToActiveShipInstance.get(playerId) ?? null;

    // Reserve the seat BEFORE re-homing the roster row: if reservation fails we
    // bail out without having moved the ship's roster sector.
    let reservation: unknown = null;
    try {
      // Thread the resolved shipId through reserveSeatFor options so the
      // destination's `onJoin` binds the named roster entry via the
      // shipId-restore path (WS-B: this is now the path for ALL transits).
      const reserveOpts: { playerId: string; transitToken: string; shipId?: string } = {
        playerId,
        transitToken: inFlight.transitToken,
      };
      if (shipInstanceId !== null) reserveOpts.shipId = shipInstanceId;
      // PR 3a — the reservation carries no auth token, so register the
      // transit token as a single-use server proof that this join IS
      // `playerId` (lets an account-bound id cross sectors; see
      // identity/TransitIdentityTokens.ts).
      issueTransitIdentity(inFlight.transitToken, playerId);
      reservation = await this.reserveByNameFn(
        `galaxy-${inFlight.targetSectorKey}`,
        reserveOpts,
      );
    } catch {
      this.inFlight.delete(playerId);
      this.sendState(playerId, {
        type: 'transit_state',
        state: 'DOCKED',
        targetSectorKey: inFlight.targetSectorKey,
        reason: 'destination_unavailable',
      });
      return;
    }

    // WS-B: re-home the reservation onto the ROSTER (Limbo retired). For the
    // LEGACY case (the active hull continues into the destination) freeze the
    // commit pose at the destination sector so the destination's onJoin
    // shipId-restore lands it exactly where the Limbo entry used to. A
    // roster-switch `shipId` keeps its OWN stored pose (don't clobber it). The
    // roster has no TTL, so an aborted hop just leaves the ship stored at the
    // destination (reclaimable) instead of expiring after 30 s.
    if (inFlight.shipId === null && shipInstanceId !== null) {
      this.playerShipStore?.markStored(shipInstanceId, {
        x:      arrivalPos ? arrivalPos.x : sabX,
        y:      arrivalPos ? arrivalPos.y : sabY,
        vx:     this.room.sabF32[b + SLOT_VX_OFF]!,
        vy:     this.room.sabF32[b + SLOT_VY_OFF]!,
        angle:  this.room.sabF32[b + SLOT_ANGLE_OFF]!,
        angvel: this.room.sabF32[b + SLOT_ANGVEL_OFF]!,
        health: this.room.getShipHealth(playerId) ?? SHIP_MAX_HEALTH,
        lastFireClientTick: this.room.lastFireClientTick.get(playerId) ?? 0,
        sectorKey: inFlight.targetSectorKey,
      });
    }
    this.room.playerToTransitInFlight.add(playerId);

    // Gameplay audit — the pilot has committed to the hop (seat reserved, out
    // the door). The matching arrival is recorded as `player_joined` at the
    // destination room's onJoin. Off the 60 Hz loop (a discrete transit event).
    auditEvent({
      event: 'transit_started',
      sector: this.room.sectorKey ?? undefined,
      playerId,
      from: this.room.sectorKey ?? undefined,
      to: inFlight.targetSectorKey,
    });
    // #18 — uniform durable sector-change record (the SAME event drones emit) so
    // one `event:sector_change` grep covers ALL ship movements. beginTransit
    // already rejects non-neighbours, so `adjacent` is true in practice here; the
    // field keeps the player + drone records shape-identical for the audit query.
    const fromSector = this.room.sectorKey ?? undefined;
    auditEvent({
      event: 'sector_change',
      entityKind: 'player',
      id: playerId,
      sector: fromSector,
      from: fromSector,
      to: inFlight.targetSectorKey,
      adjacent: fromSector ? isNeighbour(fromSector, inFlight.targetSectorKey) : undefined,
    });

    inFlight.machine.beginTransit();

    // Send the transit_state IN_TRANSIT message with the reservation embedded
    // so the client can call `client.consumeSeatReservation(...)`. We use a
    // single `transit_state` message rather than a separate `transit_ready`
    // because the reservation IS the IN_TRANSIT signal — no other path the
    // client takes from SPOOLING needs it.
    const client = this.room.clientForPlayer(playerId);
    if (client) {
      client.send('transit_state', {
        type: 'transit_state',
        state: 'IN_TRANSIT',
        targetSectorKey: inFlight.targetSectorKey,
      } satisfies TransitStateMessage);
      // Reservation goes on its own channel because the message-handler
      // function on the client uses it as the trigger to swap rooms.
      client.send('transit_ready', {
        type: 'transit_ready',
        reservation,
        transitToken: inFlight.transitToken,
        targetSectorKey: inFlight.targetSectorKey,
      });
    }

    // Broadcast the departure to everyone else in this sector so their
    // renderer fires a one-shot flash + burst ripple at the leaver's
    // world position. The leaver themselves are excluded — their own
    // warp visual is driven by the `transit_state` SPOOLING/IN_TRANSIT
    // sequence which produces the full spool → climax → burst envelope.
    // Use the SAB pose (sabX/sabY captured above) — this is where the
    // ship was at commit, which is what observers' snapshots will show
    // up to the moment the leave fires.
    this.room.broadcast(
      'warp_out',
      { type: 'warp_out', playerId, x: sabX, y: sabY },
      client ? { except: client } : undefined,
    );

    inFlight.machine.arrive();
    inFlight.machine.reset();
    this.inFlight.delete(playerId);
  }

  /** Cancel every in-flight transit (room dispose). */
  cancelAll(reason: TransitCancelReason): void {
    for (const playerId of [...this.inFlight.keys()]) {
      this.cancelTransit(playerId, reason);
    }
  }

  private sendState(playerId: string, msg: TransitStateMessage): void {
    const client = this.room.clientForPlayer(playerId);
    if (client) client.send('transit_state', msg);
  }
}

