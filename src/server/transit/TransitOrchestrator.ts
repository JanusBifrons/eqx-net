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
import { LimboStore, LIMBO_TRANSIT_TTL_MS, type LimboPayload } from '../limbo/LimboStore.js';
import type { PlayerShipStore } from '../playerShips/PlayerShipStore.js';
import { isNeighbour } from '../../core/galaxy/galaxy.js';
import type { TransitStateMessage, TransitCancelReason } from '../../shared-types/messages.js';
import { randomUUID } from 'node:crypto';
import {
  SLOT_X_OFF, SLOT_Y_OFF, SLOT_VX_OFF, SLOT_VY_OFF, SLOT_ANGLE_OFF, SLOT_ANGVEL_OFF,
  slotBase,
} from '../../shared-types/sabLayout.js';
import { clampToSectorBounds } from '../../shared-types/sectorBounds.js';
import { SHIP_MAX_HEALTH } from '../../core/combat/Weapons.js';

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
  readonly lastFireClientTick: ReadonlyMap<string, number>;
  /** Per-room schema map — used to read live health (not in SAB). */
  getShipHealth(playerId: string): number;
  /** Per-room schema lookup — used to preserve the player's chosen ship kind
   *  across the transit hop. */
  getShipKind(playerId: string): string;
  /** The set of playerIds currently mid-transit; commitTransit adds, onLeave checks. */
  playerToTransitInFlight: Set<string>;
  /** Look up the live Colyseus client for a given playerId. */
  clientForPlayer(playerId: string): Client | null;
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
    private readonly limboStore: LimboStore,
    private readonly spoolMs: number = SPOOL_DURATION_MS,
    /** Phase 5 — optional PlayerShipStore used to validate roster
     *  ownership when `beginTransit` is called with a `shipId`. When
     *  omitted (test fixtures that don't exercise the shipId path), any
     *  `shipId` argument is rejected as unknown — same outcome as a
     *  foreign id. */
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
    this.sendState(playerId, {
      type: 'transit_state',
      state: 'DOCKED',
      targetSectorKey: inFlight.targetSectorKey,
      reason,
    });
  }

  /** Internal — fired by the spool timer. Reserves the destination seat,
   *  writes Limbo, sends `transit_state` IN_TRANSIT (the client triggers
   *  consumeSeatReservation off the same message via `targetSectorKey`). */
  async commitTransit(playerId: string): Promise<void> {
    const inFlight = this.inFlight.get(playerId);
    if (!inFlight) return;
    // From this point forward, a SHIP_DESTROYED is the death flow's problem,
    // not transit's — the seat is reserved and the pilot is out the door.
    this.room.bus.off('SHIP_DESTROYED', inFlight.onShipDestroyed);

    const slot = this.room.playerToSlot.get(playerId);
    if (slot === undefined) {
      // Player vanished mid-spool (disconnect). Don't bother reserving —
      // their normal onLeave Limbo put will handle it (with disconnect TTL).
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
    const payload: LimboPayload = {
      x:      arrivalPos ? arrivalPos.x : sabX,
      y:      arrivalPos ? arrivalPos.y : sabY,
      vx:     this.room.sabF32[b + SLOT_VX_OFF]!,
      vy:     this.room.sabF32[b + SLOT_VY_OFF]!,
      angle:  this.room.sabF32[b + SLOT_ANGLE_OFF]!,
      angvel: this.room.sabF32[b + SLOT_ANGVEL_OFF]!,
      health: this.room.getShipHealth(playerId) ?? SHIP_MAX_HEALTH,
      lastFireClientTick: this.room.lastFireClientTick.get(playerId) ?? 0,
      userId: this.room.playerToUser.get(playerId) ?? null,
      sectorKey: inFlight.targetSectorKey,
      kind: this.room.getShipKind(playerId),
    };

    // Reserve the seat BEFORE writing Limbo: if reservation fails, we want
    // to bail out without leaving a stale Limbo entry that misroutes a
    // future reconnect. (Limbo `take` would still expire after 30 s but the
    // operator-facing log noise is worth avoiding.)
    let reservation: unknown = null;
    try {
      // Phase 5 — when an in-flight transit carries a `shipId`, thread it
      // through reserveSeatFor options so the destination's `onJoin` can
      // bind the named roster entry instead of the source ship. Absent ⇒
      // legacy options shape (regression locked by the test suite).
      const reserveOpts: { playerId: string; transitToken: string; shipId?: string } = {
        playerId,
        transitToken: inFlight.transitToken,
      };
      if (inFlight.shipId !== null) reserveOpts.shipId = inFlight.shipId;
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

    this.limboStore.put(playerId, payload, LIMBO_TRANSIT_TTL_MS);
    this.room.playerToTransitInFlight.add(playerId);

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

