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
 * On commit (no abort fired by `setTimeout(spoolMs)`):
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
  /** Campaign 3.1 — does this player currently have a LIVE, ACTIVE hull?
   *  A warp needs one: the SHIP_DESTROYED abort only covers death DURING
   *  the spool, so without this gate an already-dead (spectating) player
   *  could start spooling a warp for a hull that doesn't exist. */
  hasLiveActiveHull(playerId: string): boolean;
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
}

interface InFlight {
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
  commitTimer: ReturnType<typeof setTimeout>;
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
export type ReserveByName = (
  roomName: string,
  options: { playerId: string; transitToken: string; shipId?: string },
) => Promise<unknown>;

const defaultReserveByName: ReserveByName = async (roomName, options) => {
  const rooms = await matchMaker.query({ name: roomName });
  if (rooms.length === 0) throw new Error(`no live room named ${roomName}`);
  return matchMaker.reserveSeatFor(rooms[0]!, options);
};

export class TransitOrchestrator {
  private inFlight = new Map<string, InFlight>();
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
    // Campaign 3.1 (anti-patterns review A14) — a warp needs a live, ACTIVE
    // hull. The SHIP_DESTROYED subscription below only aborts a death DURING
    // the spool; an already-dead (spectating) player used to sail straight
    // into SPOOLING ("I'm dead!!! How can I warp?", Equinox Phase 6).
    if (!this.room.hasLiveActiveHull(playerId)) {
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
    machine.beginSpool(Date.now());

    const transitToken = randomUUID();
    const onShipDestroyed: InFlight['onShipDestroyed'] = (evt) => {
      if (evt.targetId === playerId) this.cancelTransit(playerId, 'destroyed');
    };
    this.room.bus.on('SHIP_DESTROYED', onShipDestroyed);

    const commitTimer = setTimeout(() => {
      void this.commitTransit(playerId);
    }, this.spoolMs);

    this.inFlight.set(playerId, {
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

  /** Cancel an in-flight spool. Legal from SPOOLING only — once committed
   *  the destination has a reservation. */
  cancelTransit(playerId: string, reason: TransitCancelReason): void {
    const inFlight = this.inFlight.get(playerId);
    if (!inFlight) return;
    if (inFlight.machine.rawState !== 'SPOOLING') return;
    clearTimeout(inFlight.commitTimer);
    this.room.bus.off('SHIP_DESTROYED', inFlight.onShipDestroyed);
    inFlight.machine.cancel();
    this.inFlight.delete(playerId);
    // Phase-4 P0 — the spool aborted; clear the friendly inbound banner.
    getIncomingPlayerSink()?.clearIncomingPlayer(playerId, inFlight.targetSectorKey);
    this.sendState(playerId, {
      type: 'transit_state',
      state: 'DOCKED',
      targetSectorKey: inFlight.targetSectorKey,
      reason,
    });
  }

  /** Internal — fired by the spool timer. Reserves the destination seat,
   *  re-homes the ship onto the roster at the destination sector (WS-B; the
   *  transit Limbo entry is retired), sends `transit_state` IN_TRANSIT (the
   *  client triggers consumeSeatReservation off the same message). */
  async commitTransit(playerId: string): Promise<void> {
    const inFlight = this.inFlight.get(playerId);
    if (!inFlight) return;
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

