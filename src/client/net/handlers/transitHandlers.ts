/**
 * Server → client warp and sector-transit messages: the `warp_in` /
 * `warp_out` broadcasts (the local arrival schedules the load-curtain drop),
 * the `transit_state` lifecycle (spool bar, cancel/arrive toasts) and the
 * `transit_ready` sector handoff (leave the source room, reset prediction,
 * wipe the old sector from the mirror, consume the destination seat).
 * Payloads keep their existing unvalidated wire types (no schema in
 * `ServerMessageSchemas` yet). Purity-clean: discrete UI values only (#2).
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import { SPOOL_DURATION_MS } from '@core/transit/TransitStateMachine';
import { getSector } from '@core/galaxy/galaxy';
import type { TransitStateMessage, WarpInEvent, WarpOutEvent } from '@shared-types/messages';
import { parseTransitReadyShipIds } from '@shared-types/messages';
import { useUIStore } from '../../state/store';
import { logEvent } from '../../debug/ClientLogger';
import type { TransitInstrumentation } from '../../debug/TransitInstrumentation';
import { isCommanderFleetFollow, transitStartsLocalTrip, type FleetArrivalWatch } from '../fleetWarpFollow';

/** What the warp / transit handlers touch on the client. */
export interface TransitHandlerCtx {
  readonly mirror: RenderMirror;
  readonly transitInstr: TransitInstrumentation;
  /** The injected clock's `now()` (ms). */
  now(): number;
  isDisposed(): boolean;
  /** Welcome anchor: the server tick and `now()` when it arrived. */
  serverTickAtWelcome(): number;
  welcomePerfNow(): number;
  isTravelling(): boolean;
  beginTravel(): void;
  travelOutRemainingMs(): number;
  /** RTS fleet warp (S8): arm (or clear) the follow-the-fleet arrival watch. */
  setFleetArrival(w: FleetArrivalWatch | null): void;
  resetPredictionState(): void;
  dropRemoteShip(id: string): void;
  /** `callbacks.onSectorHandoff` of the current connection. */
  onSectorHandoff(): void;
  /** Open the destination room from a seat reservation (new WS). */
  consumeSeatReservation(reservation: unknown): Promise<Room>;
  /** Make the destination room current and bind every handler to it. */
  adoptRoom(room: Room): void;
}

export function registerTransitHandlers(room: Room, ctx: TransitHandlerCtx): void {
  const mirror = ctx.mirror;
  const transitInstr = ctx.transitInstr;
  /** Collect-then-drop scratch for the remote-ship wipe (built once, #14). */
  const transitDropScratch: string[] = [];

  // Warp broadcasts. `warp_in` (a ship just arrived at this sector) and
  // `warp_out` (a ship just left) are logged for diagnostics; the local
  // player's own `warp_in` schedules the curtain drop. No renderer visual:
  // WarpFx draws every ship's warp from the snapshot's warp phase (#16).
  const handleWarpEvent = (msg: WarpInEvent | WarpOutEvent, kind: 'warp_in' | 'warp_out'): void => {
    // Render-jitter-fix Phase 1b (2026-05-21): log every warp event so
    // we can correlate drone-warp triggers with RAF stalls in the
    // diag capture. Drone warps (Living World hunter migrations) fire
    // these every few seconds; if the per-event renderer cost is what
    // builds the spiral, each event will line up with the next slow
    // RAF in the trace.
    const arrivalTick = (msg as WarpInEvent).arrivalTick;
    logEvent('warp_event', {
      kind,
      x: Math.round(msg.x * 100) / 100,
      y: Math.round(msg.y * 100) / 100,
      arrivalTick: typeof arrivalTick === 'number' ? arrivalTick : null,
      isLocal: msg.playerId === mirror.localPlayerId,
    });
    // Plan: crispy-kazoo, Commit 9 — synchronised arrival: the curtain
    // drops just before the arrival tick.
    //
    // SEQUENCE for the joiner:
    //   T0      receive `warp_in { arrivalTick }`
    //   T0+~150ms (= arrivalTick - 450ms): curtain starts fading
    //                                     (`setArrivalAcked(true)`
    //                                     → useIsLoadingActive → false
    //                                     → useWarpOrchestration calls
    //                                     `renderer.setLoadCurtain(false)`,
    //                                     a 380 ms fade)
    //   T0+~600ms (= arrivalTick):       the ship arrives (WarpFx);
    //                                     curtain is gone by now
    //
    // The wall-clock-anchored server-tick estimate is mandatory:
    // `this.inputTick` is stuck at welcome's serverTick because
    // `tickPhysics` is gated by the loading-active pause boundary,
    // so it never advances. Using inputTick as the reference gives
    // a ~5 s wait instead of ~600 ms — the 2026-05-31 smoke bug.
    if (
      kind === 'warp_in'
      && msg.playerId === mirror.localPlayerId
      && typeof arrivalTick === 'number'
    ) {
      useUIStore.getState().setArrivalTickFromServer(arrivalTick);
      // Wall-clock-anchored estimate of CURRENT server tick. Welcome
      // gave us a perfect anchor (`serverTickAtWelcome` +
      // `welcomePerfNow`); 60 ticks/sec wall-clock advance keeps the
      // estimate accurate independent of any input-loop gating.
      const wallClockMsSinceWelcome = ctx.now() - ctx.welcomePerfNow();
      const serverTickEstimate =
        ctx.serverTickAtWelcome() + Math.floor(wallClockMsSinceWelcome * 60 / 1000);
      const ticksUntilArrival = Math.max(0, arrivalTick - serverTickEstimate);
      const msUntilArrival = ticksUntilArrival * (1000 / 60);
      // 450 ms before arrival → curtain fade-out starts (380 ms fade
      // + 70 ms slack to ensure it's fully gone before the arrival).
      const CURTAIN_LEAD_MS = 450;
      const msUntilCurtainDrop = Math.max(0, msUntilArrival - CURTAIN_LEAD_MS);
      setTimeout(() => {
        if (ctx.isDisposed()) return;
        useUIStore.getState().setArrivalAcked(true);
        logEvent('arrival_acked', {
          arrivalTick,
          msUntilCurtainDrop: Math.round(msUntilCurtainDrop),
          msUntilArrival: Math.round(msUntilArrival),
        });
      }, msUntilCurtainDrop);
      // Phase 4 (user, 2026-11-07): the old shader warp-in flash is gone.
      // Arrivals are drawn by WarpFx from the snapshot (warp 3).
      return;
    }
    // Remote warp event: the old shader burst is retired; WarpFx draws the
    // arrival from the snapshot's warp phase (#16).
  };
  room.onMessage('warp_in', (msg) => handleWarpEvent(msg, 'warp_in'));
  room.onMessage('warp_out', (msg) => handleWarpEvent(msg, 'warp_out'));
  // Phase 8 sub-phase B — transit lifecycle messages.
  room.onMessage('transit_state', (msg: TransitStateMessage) => {
    const ui = useUIStore.getState();
    ui.setTransitState(msg.state);
    // F-transit-instrument — one mark per transit_state transition.
    // `setTransitState(msg.state)` above runs unconditionally before
    // the per-state branch, so this single site captures SPOOLING /
    // IN_TRANSIT / DOCKED / ARRIVED. Gated/no-op when diag is off.
    transitInstr.mark(`state:${msg.state}`, {
      ...(msg.targetSectorKey !== undefined ? { target: msg.targetSectorKey } : {}),
      ...(msg.reason !== undefined ? { reason: msg.reason } : {}),
    });
    if (msg.targetSectorKey !== undefined) ui.setTransitTargetSectorKey(msg.targetSectorKey);
    if (msg.state === 'SPOOLING') {
      ui.setTransitProgress(0);
      const start = ctx.now();
      const dur = msg.spoolMs ?? SPOOL_DURATION_MS;
      ui.setTransitSpoolMs(dur);
      mirror.localSpoolMs = dur;
      // Surface the destination once via the alert toast — the new
      // left-edge hyperspace bar is too narrow to carry the sector name,
      // and the player picked the destination on the map seconds ago, so
      // a brief reminder beats permanent overlay text.
      if (msg.targetSectorKey) {
        const dest = getSector(msg.targetSectorKey);
        ui.setSectorAlert(`Spooling to ${dest?.name ?? msg.targetSectorKey}`);
        setTimeout(() => {
          const cur = useUIStore.getState();
          // Only clear if still ours — don't clobber a later cancellation toast.
          if (cur.sectorAlert?.startsWith('Spooling to')) cur.setSectorAlert(null);
        }, 1800);
      }
      const ramp = (): void => {
        const elapsed = ctx.now() - start;
        const cur = useUIStore.getState();
        // Ramp only while still SPOOLING — bail if cancelled or committed.
        if (cur.transitState !== 'SPOOLING') return;
        if (elapsed >= dur) {
          cur.setTransitProgress(1);
          return;
        }
        cur.setTransitProgress(elapsed / dur);
        requestAnimationFrame(ramp);
      };
      requestAnimationFrame(ramp);
      // Phase 4 travel state: prepare the destination's sky during the
      // spool, so its textures don't upload mid-trip (a visible stall).
      if (msg.targetSectorKey) mirror.prewarmSector = msg.targetSectorKey;
    } else if (msg.state === 'IN_TRANSIT') {
      // Phase 4 travel state: the trip starts the moment the spool commits
      // (the room swap follows a moment later, mid-trip), so the ship leaves
      // at once instead of sitting still waiting for the swap. Not in
      // Command view: there is no local ship (a fleet warp; S7).
      if (!ctx.isTravelling() && transitStartsLocalTrip(ui.pilotMode)) {
        ctx.beginTravel();
        ui.setTravelling(true);
      }
    } else if (msg.state === 'DOCKED') {
      // Cancellation path. Surface the reason briefly.
      ui.setTransitProgress(0);
      ui.setTransitTargetSectorKey(null);
      ui.setTransitSpoolMs(null);
      mirror.localSpoolMs = undefined;
      if (msg.reason) {
        ui.setSectorAlert(`transit cancelled: ${msg.reason}`);
        setTimeout(() => useUIStore.getState().setSectorAlert(null), 2000);
      }
    } else if (msg.state === 'ARRIVED') {
      // Brief fade then back to DOCKED so the overlay clears.
      ui.setTransitProgress(1);
      ui.setTransitSpoolMs(null);
      mirror.localSpoolMs = undefined;
      setTimeout(() => {
        const cur = useUIStore.getState();
        cur.setTransitState('DOCKED');
        cur.setTransitProgress(0);
        cur.setTransitTargetSectorKey(null);
      }, 500);
    }
  });

  room.onMessage('transit_ready', async (msg: { reservation: unknown; targetSectorKey: string; shipIds?: unknown }) => {
    // RTS fleet warp (S7): a commander in Command view follows their fleet
    // on a spectator seat. Same room change as every transit; only the
    // local ship's trip is skipped (there is none), so the load curtain
    // covers the switch, and the warped ships are re-selected on arrival.
    const fleetIds = parseTransitReadyShipIds(msg.shipIds);
    const commanderFollow = isCommanderFleetFollow(fleetIds, useUIStore.getState().pilotMode);
    ctx.setFleetArrival(commanderFollow && fleetIds !== undefined && fleetIds.length > 0
      ? { ids: fleetIds, armedAtMs: ctx.now(), firstSeenAtMs: null }
      : null);
    // Phase 4 travel state: the old sector stays live (and falls behind) until
    // the ship has flown out of it; only then does the room swap happen.
    if (!commanderFollow && !ctx.isTravelling()) {
      ctx.beginTravel();
      useUIStore.getState().setTravelling(true);
    }
    const outWait = commanderFollow ? 0 : ctx.travelOutRemainingMs();
    if (outWait > 0) await new Promise((r) => setTimeout(r, outWait));
    // CRITICAL — leave the source room BEFORE consuming the destination
    // reservation. `client.consumeSeatReservation` opens a NEW WS without
    // touching the existing one, so without an explicit `room.leave()` the
    // client ends up with two simultaneous connections, both streaming
    // `snapshot` / `swarm` / `damage` etc. into the shared `this.mirror`.
    // The visible result is the player rendered in both sectors at once.
    // (The source onLeave's existing `transitState` early-return correctly
    // suppresses the disconnected-status flicker during this window.)
    // F-transit-instrument — bracket the source-room leave. `stepMs`
    // on `leave_room:end` is its own duration.
    transitInstr.mark('leave_room:begin');
    try {
      await room.leave(true /* consented */);
    } catch (err) {
      logEvent('cc_transit_leave_failed', { err: String(err) });
    }
    transitInstr.mark('leave_room:end');

    // Wipe Stage 4 prediction-loop state so the destination sector's first
    // snapshot is treated like a fresh-connect seed. Without this, the
    // 5+ s transit gap pollutes the surviving welford RTT stream and the
    // client over-predicts ~600 ms ahead of authoritative state for
    // tens of seconds post-arrival. See `resetPredictionState()` for the
    // full pathology and the diagnostic captures that motivated the fix.
    // F-transit-instrument — bracket resetPredictionState; `stepMs`
    // on `pred_reset:end` is its duration.
    transitInstr.mark('pred_reset:begin');
    ctx.resetPredictionState();
    transitInstr.mark('pred_reset:end');

    // Effects subsystem (M9 plan wiggly-puppy): wipe per-entity
    // emitters + in-flight bursts + shield rings so the destination
    // sector starts with a clean effects pool. Sibling line to
    // resetPredictionState + rearmJoinReadiness — separate per SRP
    // (each method owns its zone's state).
    ctx.onSectorHandoff();

    // Phase G — UI-readiness analogue of the spatial reseed above.
    // A pure inter-sector transit keeps `phase==='game'`, so
    // `setPhase` never re-arms the WarpScreen readiness flags / the
    // 5 s minimum-display floor (`setPhase`'s comment claimed it did
    // — it never fired for pure transit; same defect class as the
    // 7829d04 resetPredictionState "fresh-connect seed"). Re-arm them
    // here, exactly as a fresh connect would, so the destination's
    // first snapshot + the re-armed floor mask the post-reseed
    // reconcile settle, AND so `!gameReady` raises the load curtain
    // NOW (before the IN_TRANSIT spool-exit burst) — that ordering is
    // what collapses the "double arrival flash" to a single masked
    // hand-off. One ownership site; sibling to `resetPredictionState`
    // (NOT folded into it — that method is src/client/net prediction
    // state; SRP).
    // Phase 4 travel state: the trip starts now and IS the loading screen —
    // set before the readiness re-arm so the curtain never rises. A
    // commander following their fleet has no ship to fly: the curtain
    // rises for the switch instead (a short spinner).
    if (!commanderFollow && !ctx.isTravelling()) {
      ctx.beginTravel();
      useUIStore.getState().setTravelling(true);
    }
    useUIStore.getState().rearmJoinReadiness();

    // Wipe stale spatial state from the source sector. Without this, the old
    // sector's asteroids/drones (and remote ships) linger in the mirror at
    // their last-shipped world positions until the destination's first FULL
    // swarm snapshot reconciles them (~1 s) — long enough for the player to
    // see ghost entities sitting static across the new sector.
    mirror.swarm?.clear();
    mirror.projectiles?.clear();
    mirror.damagedShips?.clear();
    mirror.explodingShips?.clear();
    mirror.vaporisedShips?.clear();
    mirror.boostingShips?.clear();
    mirror.thrustingShips?.clear();
    mirror.remoteLasers?.clear();
    mirror.liveBeams?.clear();
    mirror.serverGhostPos = null;
    // Drop remote ships; the local entry is preserved so predWorld keeps
    // simulating until the destination's state patch arrives.
    // Collect-then-drop into a reused scratch (#14 backfill: was a
    // `[...keys()]` spread); dropping mutates the map we iterate.
    const preservedLocal = mirror.localPlayerId;
    const toDrop = transitDropScratch;
    toDrop.length = 0;
    for (const id of mirror.ships.keys()) {
      if (id !== preservedLocal) toDrop.push(id);
    }
    for (const id of toDrop) ctx.dropRemoteShip(id);
    toDrop.length = 0;

    try {
      // F-transit-instrument — bracket the destination seat consume
      // (opens the new WS). `join_room` `stepMs` is the consume cost.
      transitInstr.mark('seat_consume');
      const newRoom = await ctx.consumeSeatReservation(msg.reservation);
      ctx.adoptRoom(newRoom);
      transitInstr.mark('join_room');
      // Arm the destination-room one-shots NOW (handlers just bound
      // on `newRoom`). Until this, `markOnce` is inert, so the source
      // room's still-live `onStateChange` / `snapshot` handlers
      // (firing through spool) cannot steal `first_state` /
      // `first_snapshot` — they'll capture the destination's first.
      transitInstr.arm('first_state');
      transitInstr.arm('first_snapshot');
      // Server's onJoin will send a `welcome` setting currentSectorKey;
      // it'll also send `transit_state ARRIVED` once the destination
      // orchestrator marks the player landed (this path only fires on
      // the pre-consume edge — see server commitTransit). Defensive
      // fallback: if no ARRIVED arrives within 2 s, clear the overlay
      // ourselves so the player isn't stuck looking at warp-streaks.
      setTimeout(() => {
        const cur = useUIStore.getState();
        if (cur.transitState === 'IN_TRANSIT') {
          cur.setTransitState('ARRIVED');
          setTimeout(() => {
            const c2 = useUIStore.getState();
            c2.setTransitState('DOCKED');
            c2.setTransitProgress(0);
            c2.setTransitTargetSectorKey(null);
          }, 500);
        }
      }, 2000);
    } catch (err) {
      logEvent('cc_seat_reservation_failed', { err: String(err) });
      const ui = useUIStore.getState();
      ui.setTransitState('DOCKED');
      ui.setTransitProgress(0);
      ui.setTransitTargetSectorKey(null);
      ui.setSectorAlert('transit failed');
      setTimeout(() => useUIStore.getState().setSectorAlert(null), 2000);
    }
  });

}
