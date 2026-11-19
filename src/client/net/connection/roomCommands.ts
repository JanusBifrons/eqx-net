/**
 * `ColyseusClient`'s outbound room commands and the local-ship control
 * hand-overs they start: pilot swap, spectate / command view, fleet orders,
 * ship upgrades, mount activation, respawn, the client-ready handshake, and the
 * one-shot camera-glide / fleet-arrival reads the RAF loop polls. Each runs
 * with the once-built `RoomCommandsCtx` (getters for reassigned fields, #14);
 * `ColyseusClient` keeps one-line public delegates.
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Clock } from '@core/clock/Clock';
import type { GameClock } from '@core/clock/GameClock';
import type { PhysicsWorld } from '@core/physics/World';
import { Reconciler } from '@core/prediction/Reconciler';
import type { RespawnAckMessage } from '@shared-types/messages';
import type { FleetOrderMessage, SetModeMessage, SetStanceMessage, FormSquadMessage, DisbandSquadMessage } from '@shared-types/messages';
import { useUIStore } from '../../state/store';
import { logEvent } from '../../debug/ClientLogger';
import { stepFleetArrival, type FleetArrival, type FleetArrivalWatch } from '../fleetWarpFollow';
import type { SentInputState } from '../prediction/predictionStepCtx.js';

export type FleetCommandMessage = FleetOrderMessage | SetModeMessage | SetStanceMessage | FormSquadMessage | DisbandSquadMessage;

/** What the room commands read and write on `ColyseusClient`. Built ONCE (#14). */
export interface RoomCommandsCtx {
  readonly room: Room | null;
  readonly mirror: RenderMirror;
  readonly clock: Clock;
  readonly gameClock: GameClock;
  readonly predWorld: PhysicsWorld | null;
  readonly disposed: boolean;
  reconciler: Reconciler | null;
  localDead: boolean;
  pendingPilotSwapShipId: string | null;
  pilotSwapGlidePending: boolean;
  fleetArrival: FleetArrivalWatch | null;
  inputTick: number;
  serverTickAtWelcome: number;
  welcomePerfNow: number;
  clockAnchorServerTick: number;
  clockAnchorPerfNow: number;
  anchorInitialised: boolean;
  anchorFreshAtMs: number;
  lastSentInputState: SentInputState | null;
  lastSentInputAtMs: number;
  rekeyShip(from: string, to: string): void;
  killEntity(id: string): void;
}

/**
 * Phase 4 WS-A2 — same-sector instant pilot swap. Sends `pilot_ship { shipId }`
 * over the LIVE room (no leave/rejoin → no spool, no curtain), then primes the
 * client-side transition: despawn the local predWorld body so the fresh
 * `welcome` re-anchors self-prediction at the new authoritative pose (one
 * ownership site — same discipline as `resetPredictionState`), and stash the
 * target shipId so the welcome handler clears spectator + arms the camera glide.
 * Returns true when the swap was dispatched (false when there's no live room).
 */
export function pilotInSectorShip(c: RoomCommandsCtx, shipId: string): boolean {
  if (!c.room || shipId === '') return false;
  c.room.send('pilot_ship', { type: 'pilot_ship', shipId });
  c.pendingPilotSwapShipId = shipId;
  // Despawn the local predWorld body so the welcome's `tryInitPredWorld`
  // reseeds it at the new ship's AUTHORITATIVE pose (the spectator case has
  // none; the switch-from-another-hull case must drop the OLD body). The
  // `welcome` handler nulls + rebuilds the Reconciler via tryInitPredWorld.
  const localId = c.mirror.localPlayerId;
  if (localId && c.predWorld?.hasShip(localId)) {
    c.predWorld.despawnShip(localId);
    c.reconciler = null;
  }
  c.localDead = false;
  logEvent('pilot_swap_requested', { shipId });
  return true;
}

/**
 * Equinox Phase-5 audit — STOP PILOTING → spectate. The inverse of
 * {@link pilotInSectorShip}: tell the server to displace our active hull into a
 * lingering hull (so it parks in-world AND surfaces in our own parked hulls
 * for the Pilot dropdown). Drop the local predWorld body — same one-ownership-
 * site discipline as the pilot swap / death — so prediction doesn't fight the
 * now-parked hull; re-piloting re-anchors via the fresh `welcome`. No-op
 * server-side when we have no active hull. Returns true when dispatched.
 */
export function sendSpectate(c: RoomCommandsCtx): boolean {
  if (!c.room) return false;
  c.room.send('spectate', { type: 'spectate' });
  dropLocalShipForCommand(c);
  logEvent('spectate_requested', {});
  return true;
}

/**
 * RTS command layer (slice 10) — let go of the controls: enter command view.
 * Sends `command` (the server parks the hull as an AI-flown wingman, the same
 * path as `spectate`) and does the same local drop. The caller flips
 * `pilotMode` first (as the toggle does for spectate). Returns true when
 * dispatched.
 */
export function sendCommand(c: RoomCommandsCtx): boolean {
  if (!c.room) return false;
  c.room.send('command', { type: 'command' });
  dropLocalShipForCommand(c);
  logEvent('command_requested', {});
  return true;
}

/** RTS slice 10 — the server's `control_mode: command` (a command-view join
 *  parked our hull at the arrival flip): flip the mode, then drop the local
 *  ship exactly as a toggle-to-command does. Idempotent. Public for tests. */
export function enterCommandFromServer(c: RoomCommandsCtx): void {
  const ui = useUIStore.getState();
  if (ui.pilotMode !== 'spectator') ui.setPilotMode('spectator');
  dropLocalShipForCommand(c);
  logEvent('command_view_entered', { source: 'join' });
}

/** The local half of stop-piloting (spectate / command / a command-view
 *  join): drop the predWorld body (one ownership site, like the pilot swap /
 *  death) and the own drawn entry. The hull is parked now and comes back as a
 *  lingering hull (syncMirror skips the own ship while spectating). */
export function dropLocalShipForCommand(c: RoomCommandsCtx): void {
  const localId = c.mirror.localPlayerId;
  // Seamless hand-over (RTS Part A): the ship we let go of keeps being drawn
  // as the parked hull it becomes. Its entry, body and renderer state MOVE
  // to its shipInstanceId (`rekeyShip`); the router keys our still-ACTIVE
  // wire entry there too until the server parks it (`shipMirrorKey`).
  const sid = c.mirror.localShipInstanceId ?? null;
  const own = localId !== null ? c.mirror.ships.get(localId) : undefined;
  if (localId !== null && own !== undefined && sid !== null && sid !== localId) {
    own.isActive = false;
    own.ownerPlayerId = localId;
    own.shipInstanceId = sid;
    c.rekeyShip(localId, sid);
    return;
  }
  if (localId && c.predWorld?.hasShip(localId)) {
    c.predWorld.despawnShip(localId);
    c.reconciler = null;
  }
  if (localId) c.mirror.ships.delete(localId);
}

/**
 * RTS command layer (slice 6a): send a fleet command message
 * (`fleet_order` / `set_mode` / `set_stance` / `form_squad` /
 * `disband_squad`). Pure dispatch — no local state; the server owns the
 * wingman brains. Returns true when dispatched (false with no live room).
 */
export function sendFleetCommand(c: RoomCommandsCtx, msg: FleetCommandMessage): boolean {
  if (!c.room) return false;
  c.room.send(msg.type, msg);
  return true;
}

/**
 * Phase 4 WS-B2 — send a free stat allocation for a ship instance. The server
 * validates ownership + the point budget, persists, applies the multipliers,
 * and echoes `ship_upgrade_applied`. The physics re-anchor happens off the
 * authoritative own-ship `statAlloc` snapshot slice (not this send), so the
 * client never predicts the upgrade — it waits for the server's truth. Returns
 * true when dispatched (false when there's no live room / blank id).
 */
export function applyShipUpgrade(c: RoomCommandsCtx, shipId: string, alloc: Record<string, number>): boolean {
  if (!c.room || shipId === '') return false;
  c.room.send('apply_ship_upgrade', { type: 'apply_ship_upgrade', shipId, alloc });
  logEvent('ship_upgrade_requested', { shipId });
  return true;
}

/**
 * Phase 4 WS-B2 — respec a ship instance (refund every spent point). The
 * server resets the roster `statAlloc` to `{}`, re-anchors the multipliers to
 * neutral, and echoes `ship_upgrade_applied` with the empty alloc. Returns
 * true when dispatched.
 */
export function respecShip(c: RoomCommandsCtx, shipId: string): boolean {
  if (!c.room || shipId === '') return false;
  c.room.send('respec_ship', { type: 'respec_ship', shipId });
  logEvent('ship_respec_requested', { shipId });
  return true;
}

/**
 * Phase 4 WS-B3 — activate a latent weapon mount on a ship instance + bind a
 * weapon to it. The server validates ownership + that `slotId` is a real
 * latent hardpoint, persists the activation on the roster, mirrors it onto the
 * live hull, and echoes `mount_activated`. The activated mount fires + renders
 * from the next snapshot (PUBLIC via `states[].mounts`; geometry looked up
 * client-side by `(kind, slotId)`). Returns true when dispatched.
 */
export function activateMount(c: RoomCommandsCtx, shipId: string, slotId: string, weaponId: 'hitscan' | 'laser' | 'heat-seeker'): boolean {
  if (!c.room || shipId === '' || slotId === '') return false;
  c.room.send('activate_mount', { type: 'activate_mount', shipId, slotId, weaponId });
  logEvent('mount_activation_requested', { shipId, slotId, weaponId });
  return true;
}

/**
 * Phase 4 WS-A2 — one-shot read of the pending pilot-swap camera glide target.
 * Returns the NEW local ship's GAME-space pose ONCE the welcome has landed AND
 * the new pose is in the mirror, then clears the flag; null otherwise. The RAF
 * loop calls this each frame and, on a non-null return, drives the renderer's
 * `glideCameraTo` (the smooth ship-switch). Driven off the mirror pose, not
 * pose interpolation — independent of the snapshot teleport guard (Risk #4).
 */
export function consumePendingCameraGlide(c: RoomCommandsCtx): { x: number; y: number } | null {
  if (!c.pilotSwapGlidePending) return null;
  const localId = c.mirror.localPlayerId;
  const ship = localId ? c.mirror.ships.get(localId) : undefined;
  if (!ship) return null; // wait until the new pose is mirrored
  c.pilotSwapGlidePending = false;
  return { x: ship.x, y: ship.y };
}

/**
 * RTS fleet warp (S8) — one-shot: once the ships the commander followed are
 * in the destination's mirror, returns their ids (to re-select: the ONE
 * selection lives in the renderer) and their centroid (the camera glide
 * target), then clears. Null while waiting or when nothing is pending. The
 * RAF loop calls it each frame, like `consumePendingCameraGlide`.
 */
export function consumePendingFleetArrival(c: RoomCommandsCtx): FleetArrival | null {
  const w = c.fleetArrival;
  if (w === null) return null;
  const r = stepFleetArrival(w, c.mirror.ships, c.clock.now());
  if (r === null) return null;
  c.fleetArrival = null;
  if (r === 'drop') {
    logEvent('fleet_warp_follow_lost', { ids: w.ids.length });
    return null;
  }
  logEvent('fleet_warp_follow_arrived', { ids: r.ids.length, of: w.ids.length });
  return r;
}

export function handleRespawnAck(c: RoomCommandsCtx, msg: RespawnAckMessage): void {
  const playerId = c.mirror.localPlayerId;
  if (!playerId || !c.predWorld) return;

  // Spawn new physics body at server-assigned position.
  c.predWorld.spawnShip(playerId, msg.x, msg.y);

  // Re-initialise reconciler so it doesn't try to replay inputs from before death.
  c.reconciler = new Reconciler(c.predWorld, playerId, c.clock);

  // Sync input tick to server tick so first fire passes temporal plausibility,
  // and re-anchor the clock so tickPhysics()'s `targetTick` derivation stays
  // consistent with the new tick base.
  c.inputTick = msg.serverTick;
  c.serverTickAtWelcome = msg.serverTick;
  c.welcomePerfNow = c.clock.now();
  c.clockAnchorServerTick = msg.serverTick;
  c.clockAnchorPerfNow = c.gameClock.at(c.welcomePerfNow);
  c.anchorInitialised = true;
  c.anchorFreshAtMs = c.welcomePerfNow;
  // Reset the idle-input throttle so the first post-respawn input always sends.
  c.lastSentInputState = null;
  c.lastSentInputAtMs = 0;

  // Bootstrap mirror so the renderer shows the ship immediately (before next syncMirror).
  c.mirror.ships.set(playerId, { x: msg.x, y: msg.y, vx: 0, vy: 0, angle: 0 });

  c.localDead = false;
  useUIStore.getState().setDead(false);
  useUIStore.getState().setHullPct(100);
  useUIStore.getState().setSectorAlert(null);

  logEvent('cc_respawned', { x: msg.x, y: msg.y });
}

/** Send a respawn request to the server. Only valid while the local ship is dead. */
export function respawnShip(c: RoomCommandsCtx): void {
  if (!c.room || !c.localDead) return;
  c.room.send('respawn', { type: 'respawn' });
}

/**
 * Test-only (Phase 4 WS-A1) — drive the CLIENT-LOCAL death path for the local
 * ship, exactly as a `destroy` event would (kill the body + mirror entry +
 * flip into spectator). Spectator is client-local + un-networked (D5), so the
 * spectator-mode E2E exercises the transition deterministically here instead
 * of waiting out hostile-fire TTK. Exposed only via the DEV-gated
 * `__eqxKillLocalShip` window hook in App.tsx; production tree-shakes the hook.
 */
export function devKillLocalShip(c: RoomCommandsCtx): void {
  const id = c.mirror.localPlayerId;
  if (!id) return;
  c.killEntity(id);
}

/**
 * Plan: crispy-kazoo, Commit 2 — synchronised warp-in handshake.
 *
 * Tells the server "I have finished bootstrapping; please activate
 * my ship and broadcast the warp-in". Idempotent: a second call
 * (e.g. from the per-RAF trigger in gameRafLoop after the first
 * fire) is a no-op. The Zustand `clientReadySent` flag flips here
 * so future callers also short-circuit.
 *
 * Called from the per-RAF check in `gameRafLoop` once all
 * bootstrap gates pass (`computeBootstrapReadyFromState === true`).
 */
export function sendClientReady(c: RoomCommandsCtx): void {
  if (!c.room || c.disposed) return;
  const state = useUIStore.getState();
  if (state.clientReadySent) return;
  state.setClientReadySent(true);
  c.room.send('client_ready', { type: 'client_ready' });
  const msSinceWelcome = c.welcomePerfNow > 0
    ? Math.round(c.clock.now() - c.welcomePerfNow)
    : -1;
  logEvent('client_ready_sent', { msSinceWelcome });
}
