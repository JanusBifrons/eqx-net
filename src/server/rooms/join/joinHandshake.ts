/**
 * The warp-in handshake's room side: `client_ready` picks the arrival tick
 * and broadcasts `warp_in`; the per-tick drain activates the hull at that
 * tick (or fires the watchdog). Moved verbatim out of `SectorRoom` (god-file
 * split); `JoinHandler` exposes them as `clientReady` / `drainPending`.
 * `this.` became `d.`. The drain runs every tick and allocates nothing
 * when no join is pending (#14).
 */

import type { Client } from 'colyseus';
import { TICK_IDX } from '../../../shared-types/sabLayout.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { getIncomingPlayerSink } from '../../livingworld/incomingPlayerSink.js';
import { ARRIVAL_OFFSET_TICKS } from './joinConstants.js';
import type { JoinHandlerDeps } from './joinDeps.js';

/**
 * Plan: crispy-kazoo, Commit 2 — `client_ready` handler.
 *
 * Picks `arrivalTick = serverTick + ARRIVAL_OFFSET_TICKS`, stamps it
 * on the pending-join record, and broadcasts `warp_in { playerId,
 * x, y, arrivalTick }` to ALL occupants (no `except: client`).
 *
 * Idempotent: a second send when the player is already activated
 * or already has an arrivalTick is silently dropped + logged for
 * diag.
 */
export function handleClientReady(d: JoinHandlerDeps, client: Client): void {
  const playerId = d.sessionToPlayer.get(client.sessionId);
  if (!playerId) {
    serverLogEvent('client_ready_no_session', { sessionId: client.sessionId });
    return;
  }
  const pending = d.pendingJoin.get(playerId);
  if (!pending) {
    // Already activated (handshake completed) or never registered.
    serverLogEvent('client_ready_no_pending', { playerId, sessionId: client.sessionId });
    return;
  }
  if (pending.arrivalTick !== null) {
    // Second client_ready before arrival fires — idempotent no-op.
    serverLogEvent('client_ready_duplicate', { playerId, arrivalTick: pending.arrivalTick });
    return;
  }
  const currentTick = Atomics.load(d.sabU32, TICK_IDX);
  const arrivalTick = currentTick + ARRIVAL_OFFSET_TICKS;
  pending.arrivalTick = arrivalTick;
  // Perf scenes: the scene clock starts with the first pilot.
  d.startSceneClock(arrivalTick);

  d.broadcast('warp_in', {
    type: 'warp_in',
    playerId,
    x: pending.spawnX,
    y: pending.spawnY,
    arrivalTick,
  });

  // Phase-4 P0 — the player has ARRIVED; clear any friendly "incoming" banner
  // their transit raised in this sector. Idempotent (non-transit joins clear a
  // non-existent entry harmlessly); galaxy-only (engineering rooms have no key).
  if (d.sectorKey) getIncomingPlayerSink()?.clearIncomingPlayer(playerId, d.sectorKey);
  // 2026-11-08 — a `warp_warning` only reaches the occupants at broadcast
  // time, so a pilot arriving during a wave's ~30 s final approach never saw
  // it. Replay what is still inbound here, with the countdown left (once per
  // join; discrete, off the tick).
  if (d.sectorKey) getIncomingPlayerSink()?.replayIncomingTo(d.sectorKey, (m) => client.send('warp_warning', m));

  serverLogEvent('client_ready_received', {
    playerId,
    sessionId: client.sessionId,
    msSinceJoin: (currentTick - pending.joinTick) * (1000 / 60),
    arrivalTick,
  });
}

/**
 * Plan: crispy-kazoo, Commit 2 — per-tick pending-join drain.
 *
 * Called from the room's `update()` after `serverTick` is refreshed.
 *
 *   - For entries whose `arrivalTick` has been reached: flip
 *     `ship.isActive = true` and remove from the map. The schema
 *     diff broadcasts the new state on the next snapshot tick.
 *   - For entries past `watchdogTick` whose client_ready never
 *     arrived: synthesise an arrival (pick `arrivalTick =
 *     currentTick + ARRIVAL_OFFSET_TICKS`, broadcast `warp_in`,
 *     leave in map for normal drain). Player appears even if
 *     their client is wedged — better than an invisible ghost.
 */
export function drainPendingJoin(d: JoinHandlerDeps): void {
  if (d.pendingJoin.size === 0) return;
  const currentTick = d.serverTick;
  for (const [playerId, rec] of d.pendingJoin) {
    // Activation branch: arrivalTick set and reached.
    if (rec.arrivalTick !== null && currentTick >= rec.arrivalTick) {
      const ship = d.getActiveShip(playerId);
      if (ship) {
        ship.isActive = true;
        // Phase 4: a ship joining the sector drops in with the same arrival
        // effect as a warp (snapshot warp 3, #16); the old shader is gone.
        // A teleport is not a warp: it appears in place, with no drop-in.
        if (!rec.teleport) d.markWarpArrived(playerId, currentTick);
        serverLogEvent('ship_activated', {
          playerId,
          entityId: ship.shipInstanceId,
          arrivalTick: rec.arrivalTick,
          currentTick,
        });
        // RTS slice 10 — a command-view join: park the just-activated hull
        // (an AI-flown wingman) and tell the client to enter command view.
        if (d.pendingCommandStart.delete(playerId)) d.startInCommand(playerId, rec.sessionId);
      } else if (rec.spectator === true) {
        // Equinox Phase 5 (WS-3) — join-as-spectator: there is NO hull to
        // activate (the player joined with no ship at all). The warp-in
        // handshake already fired at `client_ready` (so the client's curtain
        // lifts); this just completes the pending-join lifecycle.
        serverLogEvent('spectator_join_ready', {
          playerId,
          arrivalTick: rec.arrivalTick,
          currentTick,
        });
      }
      d.pendingJoin.delete(playerId);
      continue;
    }
    // Watchdog branch: client_ready never arrived.
    if (rec.arrivalTick === null && currentTick >= rec.watchdogTick) {
      const arrivalTick = currentTick + ARRIVAL_OFFSET_TICKS;
      rec.arrivalTick = arrivalTick;
      d.broadcast('warp_in', {
        type: 'warp_in',
        playerId,
        x: rec.spawnX,
        y: rec.spawnY,
        arrivalTick,
      });
      serverLogEvent('client_ready_timeout', {
        playerId,
        sessionId: rec.sessionId,
        joinTick: rec.joinTick,
        watchdogTick: rec.watchdogTick,
        arrivalTick,
      });
    }
  }
}
