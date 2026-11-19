/**
 * Player onJoin handler — identity, join-as-spectator, rebind and (via
 * `joinFreshSpawn`) the fresh-spawn path.
 *
 * Dispatched in order:
 *   1. identity — account-bound / transit / anonymous playerId, takeover of
 *      another session piloting the same id, pilot-session registration;
 *   2. spectator (`{ spectator: true }`, galaxy rooms) — shipless camera join;
 *   3. rebind — reattach to the player's lingering hull (unless they picked a
 *      new / different ship, which keeps the hull lingering);
 *   4. fresh spawn — `joinFreshSpawn.ts`.
 *
 * Extracted from SectorRoom (god-file split), matching `LeaveHandler` /
 * `RespawnHandler`: the room builds the deps once in `onCreate` and
 * `onJoin` delegates here. Bodies are verbatim; `this.` became `d.`.
 */

import type { Client } from 'colyseus';
import {
  SLOT_X_OFF,
  SLOT_Y_OFF,
  TICK_IDX,
  slotBase,
} from '../../../shared-types/sabLayout.js';
import { DEFAULT_SHIP_KIND, isPlayableShipKindId } from '../../../shared-types/shipKinds.js';
import type { WelcomeMessage } from '../../../shared-types/messages.js';
import { factionLooksWelcomeField } from '../../../shared-types/factions.js';
import { clampToSectorBounds } from '../../../shared-types/sectorBounds.js';
import { validateToken } from '../../auth/AuthService.js';
import { getAccountPlayerRegistry } from '../../identity/AccountPlayerRegistry.js';
import { consumeTransitIdentity } from '../../identity/TransitIdentityTokens.js';
import { assignPlayerId } from '../../identity/PlayerIdentity.js';
import { getPlayerSession, registerPlayerSession, takeOverPlayerSession } from '../../identity/PlayerSessionRegistry.js';
import { getPlayerShipStore } from '../../db/PersistenceWorker.js';
import { setSession } from '../../transit/sessionRegistry.js';
import { serverLogEvent } from '../../debug/ServerEventLog.js';
import { registerConnectedPlayer } from '../../push/connectedPlayers.js';
import { recordGameJoin } from '../../stats/StatsService.js';
import { auditEvent } from '../../audit/GameplayAuditLog.js';
import {
  CLIENT_READY_TIMEOUT_TICKS,
  JOIN_BROADCAST_GRACE_TICKS,
  withShipScale,
} from './joinConstants.js';
import { JoinOptionsSchema } from './joinOptions.js';
import { joinFreshSpawn } from './joinFreshSpawn.js';
import type { JoinHandlerDeps } from './joinDeps.js';

export class JoinHandler {
  constructor(private readonly deps: JoinHandlerDeps) {}

  async handle(client: Client, options: unknown): Promise<void> {
    const d = this.deps;
    const logger = d.logger;
    logger.info({ sessionId: client.sessionId, options }, 'onJoin called');
    const parsed = JoinOptionsSchema.safeParse(options);
    const requestedId = parsed.success ? parsed.data.playerId : null;

    const authToken = parsed.success ? parsed.data.authToken : undefined;
    let userId = authToken ? await validateToken(authToken) : null;

    // ── PR 3a — account-bound identity ────────────────────────────────────
    // The playerId (owner of ships / structures / hulls) belongs to the
    // ACCOUNT, not the browser. See identity/AccountPlayerRegistry.ts.
    const identity = getAccountPlayerRegistry();
    const transitToken = parsed.success ? parsed.data.transitToken : undefined;
    let playerId: string;
    // Test-fixture accounts (the shared E2E login) keep per-browser ids.
    const accountBound = userId !== null && !identity.isExempt(userId);
    if (accountBound) {
      // Logged in → always the account's canonical id (the claim is ignored
      // once the account is bound; a first login adopts this browser's id).
      playerId = identity.resolveForUser(userId as string, requestedId);
    } else if (transitToken !== undefined && consumeTransitIdentity(transitToken, requestedId)) {
      // Server-reserved transit arrival — the token proves the identity; the
      // account (if any) is recovered from the registry.
      playerId = requestedId as string;
      userId = userId ?? identity.userForPlayer(playerId);
    } else {
      // Anonymous → may NOT claim an id that belongs to an account (that would
      // let a logged-out browser pilot the account's ships). Historical alias
      // ids are account-bound too.
      playerId = assignPlayerId(requestedId);
      if (identity.isAccountBound(playerId)) playerId = assignPlayerId(null);
    }

    // Same id already piloted by another session. A logged-in (or transiting)
    // player TAKES OVER — the old session, in whichever room it lives, is
    // told `session_replaced` and disconnected first, then this join rebinds
    // to the hull like a normal reconnect. An anonymous duplicate (two tabs
    // sharing one localStorage) keeps the legacy behaviour: a fresh identity.
    if ((accountBound || identity.isAccountBound(playerId)) && getPlayerSession(playerId) !== undefined) {
      await takeOverPlayerSession(playerId);
    }

    // Validated ship-kind id from JoinOptions, or the catalogue default. Used
    // by the fresh-spawn and Limbo paths below; explicitly NOT consulted on
    // the rebind path (a bad-actor client must not be able to mid-session
    // swap kind by reconnecting — the existing ShipState.kind is preserved).
    const requestedKind = parsed.success
        && typeof parsed.data.shipKind === 'string'
        && isPlayableShipKindId(parsed.data.shipKind)
      ? parsed.data.shipKind
      : DEFAULT_SHIP_KIND;

    // If the requested ID is STILL held by an active session in this room
    // (anonymous two-tabs case, or a takeover that timed out), assign a fresh
    // UUID — two sessions must never pilot one id.
    if (d.playerToSession.has(playerId)) {
      playerId = assignPlayerId(null);
    }

    // PR 3a — register this session as the current pilot of `playerId` so a
    // later login on another device can take it over (any room, this server).
    const joinSessionId = client.sessionId;
    d.sessionRegisteredPlayer.set(joinSessionId, playerId);
    registerPlayerSession(playerId, {
      roomId: d.roomId,
      sessionId: joinSessionId,
      evict: () => d.evictSessionForTakeover(joinSessionId),
    });

    // ── Equinox Phase 5 (WS-3) — JOIN-AS-SPECTATOR ─────────────────────────
    // The galaxy "Spectate" CTA joins with `{ spectator: true }`. The player
    // drops into the sector as a free-roam camera with NO ship at all — no
    // hull, no slot, no roster row, nothing in the world (the user's "there
    // should be no hull or wreck or ship involved"). Short-circuit BEFORE the
    // rebind / fresh-spawn paths so a spectator never spawns or displaces a
    // hull. Galaxy rooms only (engineering rooms have no roster/persistence;
    // they fall through to the normal pilot join).
    if (parsed.success && parsed.data.spectator === true && d.sectorKey !== null) {
      // RTS fleet warp (S7): a commander following their fleet arrives with
      // the fleet's anchor as spawnX/spawnY (the seat reservation's options).
      const spawn = parsed.data.spawnX !== undefined && parsed.data.spawnY !== undefined
        ? clampToSectorBounds(parsed.data.spawnX, parsed.data.spawnY)
        : null;
      this.joinAsSpectator(client, playerId, userId, spawn);
      return;
    }

    // RTS slice 10 — `startMode: 'command'`: spawn / rebind as normal (the
    // client's join readiness runs the proven handshake), then park the hull
    // at the arrival flip so the player lands in command view. Galaxy rooms
    // only; absent / `fly` keeps the pilot join.
    if (parsed.success && parsed.data.startMode === 'command' && d.sectorKey !== null) {
      d.pendingCommandStart.add(playerId);
    } else {
      d.pendingCommandStart.delete(playerId);
    }

    // ── Phase 8 sub-phase B — REBIND PATH ──────────────────────────────────
    // If this player has an ownerless ship still drifting in the sector
    // (disconnected within the TTL window), reattach the new session to
    // the existing ship instead of fresh-spawning. The ship's pose / vel /
    // angle / health reflect what happened during the offline window
    // (drift decayed by drag, possibly damage from passing drones).
    //
    // Phase 3 multi-ship: the player can intentionally bypass rebind by
    // (a) sending `isNewShip:true` (sector-click → kind picker → fresh
    // spawn), or (b) sending a `shipId` that doesn't match the lingering
    // ship's `shipInstanceId` (roster card → resume a DIFFERENT stored
    // ship). When either is set, evict the lingering ship to stored
    // state (it stays in the roster, the slot is freed) and fall
    // through to the fresh-spawn path below.
    // Phase 6b cleanup — ownerlessShips is now keyed by the lingering hull's
    // shipInstanceId. Resolve via the playerToActiveShipInstance indirection
    // that was set up at original spawn and preserved through onLeave's
    // linger branch.
    const lingeringShipId = d.resolveActiveShipKey(playerId);
    const ownerlessTimer = lingeringShipId !== undefined
      ? d.ownerlessShips.get(lingeringShipId)
      : undefined;
    if (d.sectorKey !== null && ownerlessTimer !== undefined) {
      const existingShip = d.getActiveShip(playerId);
      const wantsNewShip = parsed.success && parsed.data.isNewShip === true;
      const requestedShipIdForRebindCheck = parsed.success && typeof parsed.data.shipId === 'string'
        ? parsed.data.shipId
        : '';
      const wantsDifferentShip = requestedShipIdForRebindCheck !== ''
        && existingShip !== undefined
        && existingShip.shipInstanceId !== ''
        && existingShip.shipInstanceId !== requestedShipIdForRebindCheck;
      if (wantsNewShip || wantsDifferentShip) {
        logger.info(
          { playerId, wantsNewShip, wantsDifferentShip, existingShipId: existingShip?.shipInstanceId, requestedShipId: requestedShipIdForRebindCheck },
          'rebind skipped — player picked a different / new ship; keeping lingering hull in sector',
        );
        // Phase 6b — DON'T evict the lingering hull. Promote it to the
        // lingeringSlots map so the snapshot loop continues to broadcast
        // it; clear the active indirection so the fresh ship can take
        // playerToActiveShipInstance[playerId] in its onJoin path.
        //
        // The ownerlessShips entry is keyed by the lingering hull's
        // shipInstanceId, so the displaced hull keeps its presence marker
        // across this transition (the player's fresh hull is tracked
        // separately). WS-12 / R2.26: that marker is a persist-forever `null`
        // (no despawn timer) — the displaced hull stays in the world until the
        // owner abandons it (→ scrap) or it is destroyed; it never times out.
        const lingeringSlot = d.playerToSlot.get(playerId);
        if (lingeringSlot !== undefined && existingShip && existingShip.shipInstanceId !== '') {
          d.lingeringSlots.set(existingShip.shipInstanceId, lingeringSlot);
          // The hull is no longer "the player's active hull"; the fresh
          // spawn will overwrite playerToActiveShipInstance below.
          d.playerToActiveShipInstance.delete(playerId);
          // existingShip.isActive was already false from the original
          // onLeave linger branch — leave it false so the client
          // continues to render with the lingering tint.

          // Phase 6b push-fix (2026-05-13, diag
          // 2026-05-13T19-33-59-440Z-04j2mm — the "fly into the
          // abandoned ship, moves then snaps back" smoke-test bug).
          //
          // Rekey the worker's Rapier body identity from `playerId` to
          // a unique `linger-${shipInstanceId}`. Without this, the
          // imminent fresh-spawn `SPAWN { playerId, slot: newSlot }`
          // calls `World.spawnShip(playerId, ...)` which does
          // `bodies.set(playerId, newBody)` and ORPHANS the old body —
          // it remains alive in Rapier (still collidable, still
          // pushable) but its pose is no longer iterated by
          // `getAllShipStates()`, so the worker stops writing its
          // updated pose to SAB. The main thread reads the lingering
          // slot's SAB cells (stale forever) and broadcasts the
          // original abandon-point pose to clients every snapshot.
          // Visible bug: client predicts the hull moving on collision
          // → snapshot pulls it back to the stale pose → repeat.
          //
          // playerToSlot in the worker also gets remapped to the new
          // key, so SAB writes continue to land in the correct (now-
          // lingering) slot.
          d.postToWorker({
            type: 'REKEY_SHIP',
            oldId: playerId,
            newId: `linger-${existingShip.shipInstanceId}`,
          });
          d.attachWingman(existingShip.shipInstanceId);
        }
        // Fall through to the fresh-spawn / shipId-restore path below.
        // The fresh spawn will allocate a NEW slot from freeSlots
        // (the lingering slot stays allocated, tracked by lingeringSlots).
        // playerToSlot[playerId] gets overwritten with the new slot.
      } else {
        // Original rebind behaviour: reattach to the existing slot.
        // Phase 6b cleanup — ownerlessShips keyed by shipInstanceId. R2.26: a
        // persist-forever lingering hull holds a `null` marker (no timer) — only
        // a real Timeout needs clearing; the presence entry is always deleted.
        if (ownerlessTimer) clearTimeout(ownerlessTimer);
        if (lingeringShipId !== undefined) d.ownerlessShips.delete(lingeringShipId);
        const existingSlot = d.playerToSlot.get(playerId);
        if (existingSlot !== undefined && existingShip) {
        // Plan: crispy-kazoo, Commit 2 — invariant: every join goes
        // through the synchronised handshake (`pendingJoin` →
        // `client_ready` → `warp_in` → arrivalTick → isActive=true).
        // The rebind path used to flip `isActive = true` directly,
        // skipping the handshake — works for the player (the ship is
        // already alive) but BREAKS the client's bootstrap which sits
        // waiting for `warp_in` to flip `arrival_acked`. Repro: phone
        // smoke capture 2026-05-31T15-36-08Z-7eqj1a + the React
        // StrictMode dev-mount cycle.
        //
        // The fix is to register the rebind in `pendingJoin` exactly
        // as a fresh spawn does: isActive=false initially, watchdog
        // armed, waiting for the client's `client_ready` to broadcast
        // `warp_in`. `drainPendingJoin` flips `isActive=true` at the
        // arrivalTick. The hull stays at its current live pose (we
        // don't move it); only the visibility + handshake state are
        // re-driven through the unified path.
        existingShip.isActive = false;
        d.sessionToPlayer.set(client.sessionId, playerId);
        d.playerToSession.set(playerId, client.sessionId);

        // WS-B (Phase 5): Limbo is retired. The live ShipState/SAB is the
        // source of truth for the rebound hull; the anonymous-reconnect userId
        // fallback now comes from the userId retained on this room from the
        // original session, else the roster row (markLinger preserved it).
        const rosterUserId = existingShip
          ? (getPlayerShipStore().get(existingShip.shipInstanceId)?.userId ?? null)
          : null;
        const effectiveUserId = userId ?? d.playerToUser.get(playerId) ?? rosterUserId;
        d.playerToUser.set(playerId, effectiveUserId);

        // lastFireClientTick is already retained from the original session;
        // do NOT reset — preserves cooldown across reconnect.

        const b = slotBase(existingSlot);
        const liveX = d.sabF32[b + SLOT_X_OFF]!;
        const liveY = d.sabF32[b + SLOT_Y_OFF]!;

        const tickAtRebind = Atomics.load(d.sabU32, TICK_IDX);
        const welcome: WelcomeMessage = {
          type: 'welcome',
          playerId,
          serverTick: tickAtRebind,
          sectorKey: d.sectorKey,
          shipInstanceId: existingShip?.shipInstanceId ?? '',
        };
        client.send('welcome', withShipScale({ ...welcome, ...d.shellWelcomeFields(client, playerId), ...d.wreckWelcomeFields(), ...d.cutField?.welcome, ...factionLooksWelcomeField() }));

        setSession(client.sessionId, {
          roomId: d.roomId,
          playerId,
          sectorKey: d.sectorKey,
        });

        // Note: we do NOT call recordGameJoin again — the original
        // session's joined_at remains canonical. From a stats perspective
        // a disconnect+reconnect is one continuous play session.

        d.bus.emit('SHIP_SPAWNED', {
          type: 'SHIP_SPAWNED' as const,
          playerId,
          x: liveX,
          y: liveY,
        });
        // Reconnect-restore path: force snapshot broadcasts so the
        // returning client reconciles its prediction before
        // idle-suppression can kick in. See JOIN_BROADCAST_GRACE_TICKS.
        d.forceBroadcastUntilTick =
          Atomics.load(d.sabU32, TICK_IDX) + JOIN_BROADCAST_GRACE_TICKS;
        serverLogEvent('player_rebind', {
          playerId,
          sessionId: client.sessionId,
          x: liveX,
          y: liveY,
          health: existingShip.health,
        });
        logger.info(
          { playerId, sessionId: client.sessionId, x: liveX, y: liveY, health: existingShip.health, alive: existingShip.alive },
          'player rebound to lingering ship',
        );

        // Plan: crispy-kazoo invariant — register the rebind in
        // `pendingJoin` so `client_ready` → `warp_in` → arrivalTick →
        // isActive=true follows the same path as a fresh spawn. The
        // hull pose stays live (no SAB reset); only the visibility +
        // handshake state are re-driven through the unified path.
        d.pendingJoin.set(playerId, {
          joinTick: tickAtRebind,
          watchdogTick: tickAtRebind + CLIENT_READY_TIMEOUT_TICKS,
          arrivalTick: null,
          spawnX: liveX,
          spawnY: liveY,
          sessionId: client.sessionId,
        });
        serverLogEvent('pending_join_registered', {
          playerId,
          sessionId: client.sessionId,
          watchdogTick: tickAtRebind + CLIENT_READY_TIMEOUT_TICKS,
          source: 'rebind',
        });
        return;
      }
        // Stale entry: ownerlessShips had this player but the slot/ShipState
        // is gone (e.g. a race we didn't anticipate). Fall through to
        // fresh-spawn — better to recover than throw.
        logger.warn({ playerId }, 'stale ownerless entry — falling through to fresh spawn');
      }
    }


    joinFreshSpawn(d, client, parsed, playerId, userId, requestedKind, transitToken);
  }

  /**
   * Equinox Phase 5 (WS-3) — JOIN-AS-SPECTATOR. The player joins the sector as
   * a free-roam camera with NO ship at all: no `state.ships` entry, no slot, no
   * roster row — nothing in the world. They still receive snapshots (to watch
   * the sector) and can `place_structure` (construction-without-a-ship). Galaxy
   * rooms only (gated by the caller).
   *
   * The only seam that assumes a connected client has a ship is the
   * `SnapshotBroadcaster` recipient gate (it SKIPs a recipient with no
   * `shipPoseCache` entry), so we seed a FIXED origin pose-cache entry — the
   * spectator's snapshot interest is then culled around the sector centre (the
   * binary swarm channel sends all drones/asteroids unculled, since there's no
   * slot ⇒ no interest set ⇒ broadcast-all). Camera-relative interest is a
   * follow-up; origin covers the common case (action clusters near centre).
   * `shipPoseCache` is cleaned up by `LeaveHandler` on leave (the despawn path,
   * which a shipless session takes since `shouldLinger` is false).
   *
   * Readiness: we still drive the unified warp-in handshake (`client_ready` →
   * `warp_in` → `arrivalAcked`) off a SHIPLESS `pendingJoin` entry so the
   * client's load curtain lifts the proven way; `drainPendingJoin`'s activation
   * branch no-ops for a shipless entry (`getActiveShip` is undefined).
   */
  private joinAsSpectator(
    client: Client, playerId: string, userId: string | null,
    spawn: { x: number; y: number } | null = null,
  ): void {
    const d = this.deps;
    const logger = d.logger;
    d.sessionToPlayer.set(client.sessionId, playerId);
    d.playerToSession.set(playerId, client.sessionId);
    // Presence — mark connected (push-offline gate); decremented in onLeave.
    registerConnectedPlayer(playerId);
    d.playerToUser.set(playerId, userId);

    // Seed a fixed pose so the per-recipient snapshot broadcaster does not
    // skip this shipless spectator (see the method doc): the origin, or the
    // given spawn point (RTS fleet warp: the commander's interest window
    // starts on the fleet they followed in, so its ships stream in at once).
    const sx = spawn?.x ?? 0, sy = spawn?.y ?? 0;
    d.shipPoseCache.set(playerId, { x: sx, y: sy, vx: 0, vy: 0, angle: 0, angvel: 0 });

    const currentServerTick = Atomics.load(d.sabU32, TICK_IDX);
    const welcome: WelcomeMessage = {
      type: 'welcome',
      playerId,
      serverTick: currentServerTick,
      sectorKey: d.sectorKey,
      shipInstanceId: '',
      spectator: true,
    };
    client.send('welcome', withShipScale({ ...welcome, ...d.shellWelcomeFields(client, playerId), ...d.wreckWelcomeFields(), ...d.cutField?.welcome, ...factionLooksWelcomeField() }));

    setSession(client.sessionId, {
      roomId: d.roomId,
      playerId,
      sectorKey: d.sectorKey,
    });
    recordGameJoin(userId, playerId, d.sectorKey ?? d.roomId);

    // Force snapshot broadcasts for the grace window so `firstSnapshotApplied`
    // fires on the client (curtain readiness) even in a quiet sector.
    d.forceBroadcastUntilTick = currentServerTick + JOIN_BROADCAST_GRACE_TICKS;

    // Shipless pending-join: drives `client_ready` → `warp_in` → `arrivalAcked`
    // exactly as a normal join, but there's no hull to activate at the arrival
    // flip (drainPendingJoin's `else if (rec.spectator)` branch).
    d.pendingJoin.set(playerId, {
      joinTick: currentServerTick,
      watchdogTick: currentServerTick + CLIENT_READY_TIMEOUT_TICKS,
      arrivalTick: null,
      spawnX: sx,
      spawnY: sy,
      sessionId: client.sessionId,
      spectator: true,
    });

    serverLogEvent('spectator_join', {
      playerId,
      sessionId: client.sessionId,
      sectorKey: d.sectorKey,
    });
    auditEvent({ event: 'player_joined', sector: d.sectorKey ?? undefined, playerId });
    logger.info({ playerId, sessionId: client.sessionId }, 'player joined as spectator (no hull)');
  }
}
