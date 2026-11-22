/**
 * Server → client `welcome`: the join handshake. Reads the server's feature
 * flags (shell events, wrecks, cut field), anchors the clock and input tick,
 * sets the local player / ship ids, re-keys our own hull, answers a pilot
 * swap, enters spectator, and starts the DataChannel handshake. Parsed by the
 * pure guard (#3). Runs once per join, not per frame.
 */
import type { Room } from 'colyseus.js';
import type { RenderMirror } from '@core/contracts/IRenderer';
import type { Clock } from '@core/clock/Clock';
import type { GameClock } from '@core/clock/GameClock';
import { getSector } from '@core/galaxy/galaxy';
import type { WreckDescriptor } from '@shared-types/messages/snapshotMessages';
import { shipScaleMismatch } from '@shared-types/shipScale/welcomeScale';
import { navalRangeMismatch } from '@shared-types/combat/navalRange';
import { setFactionLooks } from '../../../shared-types/factions.js';
import { useUIStore } from '../../state/store';
import { logEvent } from '../../debug/ClientLogger';
import { parseWelcome } from '../parseWelcome';
import { resetAnchorHardSnapCount } from '../clockAnchor.js';
import { resetSnapshotArrivalStats } from '../snapshotArrivalStats.js';
import type { CutFieldClient } from '../CutFieldClient.js';
import type { WreckGeometryStore } from '../wreckGeometryStore.js';
import type { DrawnShellTiming } from '../drawnShellTiming';
import type { DataChannelTransport } from '../dataChannelTransport.js';
import type { SentInputState } from '../prediction/predictionStepCtx.js';
import { clearMissileDetonations } from '../../combat/MissileMirror.js';

const NO_WRECK_LIST: readonly WreckDescriptor[] = [];

/** What the welcome handler reads and writes on `ColyseusClient`. Built ONCE
 *  (#14): reassigned fields are getters/setters. */
export interface WelcomeTarget {
  readonly mirror: RenderMirror;
  readonly clock: Clock;
  readonly gameClock: GameClock;
  readonly cutField: Pick<CutFieldClient, 'setSeed' | 'fieldOpts'>;
  readonly wrecks: WreckGeometryStore;
  readonly shellTiming: Pick<DrawnShellTiming, 'onWelcome'>;
  readonly room: Room | null;
  readonly webrtcEnabled: boolean;
  readonly dataChannelTransport: DataChannelTransport | null;
  /** The `storedPlayerId` the current connection joined with. */
  readonly storedPlayerId: string | null;
  shellEvents: boolean;
  serverTickAtWelcome: number;
  welcomePerfNow: number;
  clockAnchorServerTick: number;
  clockAnchorPerfNow: number;
  anchorInitialised: boolean;
  anchorFreshAtMs: number;
  inputTick: number;
  lastSentInputState: SentInputState | null;
  lastSentInputAtMs: number;
  pendingPilotSwapShipId: string | null;
  pilotSwapGlidePending: boolean;
  /** `callbacks.onPlayerId` of the current connection. */
  onPlayerId(id: string): void;
  rekeyOwnShipFromHull(playerId: string, welcomeShipInstanceId: string): void;
  tryInitPredWorld(playerId: string): void;
}

export interface WelcomeHandlerCtx {
  readonly welcome: WelcomeTarget;
}

export function registerWelcomeHandlers(room: Room, hctx: WelcomeHandlerCtx): void {
  const ctx = hctx.welcome;
  // Campaign 6.1 (invariant #3): `welcome` was the last load-bearing
  // handler consuming a raw cast — parse-and-drop via the pure guard
  // before anything reaches prediction anchoring / the phase machine.
  room.onMessage('welcome', (raw: unknown) => {
    const msg = parseWelcome(raw);
    if (msg === null) return;
    // Ship scale: the catalogue is built at load from this client's own
    // config; a server at another scale would desync physics and hits.
    const scaleMismatch = shipScaleMismatch(msg);
    if (scaleMismatch) logEvent('ship_scale_mismatch', scaleMismatch);
    // Naval range mode: the client draws range and lock rings from its own
    // catalogue, the server fires from its own (invariant #15).
    const navalMismatch = navalRangeMismatch(msg);
    if (navalMismatch) logEvent('naval_range_mismatch', navalMismatch);
    // Shells as events: read shell_salvo / shell_end only when the server
    // says it sends them (#15), and take the shells already in flight (#16).
    ctx.shellEvents = msg.shellEvents === true;
    // Capital wrecks on: a dying capital explodes at its kill point (the
    // wreck break-up), not as a hull-sized blast (money-shot review).
    ctx.mirror.capitalWrecks = msg.capitalWrecks === true;
    // Sub-cap wrecks on: a dying sub-cap's hull is held until its pieces draw.
    ctx.mirror.subcapWrecks = msg.subcapWrecks === true;
    // Cut field on: cut the same rocks as the server from its seed (#16).
    ctx.cutField.setSeed(msg.cutField?.seed ?? null, msg.cutField?.consumed, msg.cutField?.moved, msg.cutField?.clearings);
    // A broken field rock's wreck rebuilds from the same field options, in
    // this store and the renderer's (through the mirror), before the wrecks.
    ctx.wrecks.setField(ctx.cutField.fieldOpts);
    ctx.mirror.wreckField = ctx.cutField.fieldOpts;
    // Sub-capital break-up slice 3: the welcome carries the FULL live wreck
    // set (#16); snapshots then carry only adds, removes and a slow resync.
    if (msg.capitalWrecks === true || msg.subcapWrecks === true) {
      ctx.wrecks.apply(msg.wrecks ?? NO_WRECK_LIST);
      ctx.mirror.wrecks = ctx.wrecks.descriptors;
    }
    ctx.shellTiming.onWelcome(ctx.shellEvents, msg.shellsInFlight);
    // Held missile detonations belong to the old room: drop them (no blast).
    clearMissileDetonations(ctx.mirror);
    // Every claimed faction ship look (#16); later claims: faction_look_claimed.
    if (msg.factionLooks) setFactionLooks(msg.factionLooks);
    const idChanged = ctx.storedPlayerId && msg.playerId !== ctx.storedPlayerId;
    logEvent('cc_welcome', {
      playerId: msg.playerId,
      serverReassigned: Boolean(idChanged),
      serverTick: msg.serverTick,
    });
    ctx.serverTickAtWelcome = msg.serverTick;
    ctx.welcomePerfNow = ctx.clock.now();
    ctx.clockAnchorServerTick = msg.serverTick;
    ctx.clockAnchorPerfNow = ctx.gameClock.at(ctx.welcomePerfNow);
    // The welcome handshake gives us a perfect anchor; let the next
    // snapshot drop straight into EWMA-smoothing instead of snapping.
    ctx.anchorInitialised = true;
    ctx.anchorFreshAtMs = ctx.welcomePerfNow;
    resetAnchorHardSnapCount(); // the anchor is re-seeded: count snaps from this join
    resetSnapshotArrivalStats(); // a new room: no gap or delay floor carries over
    ctx.inputTick = msg.serverTick; // Sync to server tick space so fire messages pass temporal plausibility check.
    // Reset idle-input throttle: the first input after a (re)connect must
    // always reach the server so it has a baseline before tick advance.
    ctx.lastSentInputState = null;
    ctx.lastSentInputAtMs = 0;
    logEvent('welcome', { playerId: msg.playerId, serverTick: msg.serverTick, idReassigned: !!idChanged });
    ctx.mirror.localPlayerId = msg.playerId;
    // The local ACTIVE ship's id. Own-ship snapshot routing keys on this,
    // not just playerId, because a displaced player owns BOTH a lingering
    // hull and a fresh active ship under one playerId (2026-06-03 "pinned
    // in my old interceptor" bug).
    ctx.mirror.localShipInstanceId =
      msg.shipInstanceId && msg.shipInstanceId !== '' ? msg.shipInstanceId : null;
    ctx.onPlayerId(msg.playerId);
    // Phase 8 — surface the stable galaxy sector key for HUD + galaxy-map
    // overlay consumers. `null` for engineering rooms. The display name is
    // also refreshed here so post-transit reconnects update the HUD; the
    // initial App.tsx setSectorName covers engineering rooms (key=null).
    const ui = useUIStore.getState();
    ui.setCurrentSectorKey(msg.sectorKey);
    if (msg.sectorKey) {
      const sec = getSector(msg.sectorKey);
      if (sec) ui.setSectorName(sec.name);
    }
    // Phase 5 — identify the ship the LOCAL browser session is bound to.
    // Distinct from any `ship.isActive` flag on the roster (which stays
    // true through the 15-min reconnect linger window even when no
    // session is driving it). The roster panel + detail modal use this
    // to drive the "Piloting" disabled state and the switch-confirm.
    // Empty string from engineering rooms or pre-Phase-5 servers ⇒ null.
    ui.setLocalShipInstanceId(msg.shipInstanceId && msg.shipInstanceId !== '' ? msg.shipInstanceId : null);

    // Plan: crispy-kazoo, Commit 8 — re-key our own ship from its hull key.
    // Pre-welcome our own ship is `isActive=false` (server's spawn-
    // handshake design) and the snapshot router + syncMirror both key it
    // by shipInstanceId as a parked hull, because they don't yet know our
    // localPlayerId. A take-controls swap (WS-A2 / RTS) does the same: the
    // hull we take was a parked, AI-flown hull under its shipInstanceId,
    // with its own remote predWorld body. Now that welcome has arrived,
    // re-key it to our playerId: drop the hull key through the ONE drop
    // path FIRST (its remote body goes, so `tryInitPredWorld` below never
    // overlaps two bodies; RTS Part A S3), then seed the local entry at
    // the hull's last pose.
    ctx.rekeyOwnShipFromHull(msg.playerId, msg.shipInstanceId);

    // Phase 4 WS-A2 — a SAME-SECTOR pilot swap re-anchors via this same
    // welcome path. When the welcome's shipInstanceId matches the swap we
    // requested, this is a successful in-room reclaim: leave spectator
    // (re-enable pilot input + self-prediction) and ARM the one-shot camera
    // glide to the new ship (fired by the RAF loop once its pose is mirrored).
    if (
      ctx.pendingPilotSwapShipId !== null &&
      msg.shipInstanceId !== '' &&
      msg.shipInstanceId === ctx.pendingPilotSwapShipId
    ) {
      ctx.pendingPilotSwapShipId = null;
      ctx.pilotSwapGlidePending = true;
      useUIStore.getState().setPilotMode('pilot');
      // The server reclaims the hull through the join handshake (pending
      // until `client_ready` → `warp_in` → arrival). `sendClientReady` is
      // latched once per room join, so answer the swap's handshake here:
      // without it the flown hull stayed "joining" until the 30 s watchdog
      // (no own-ship slices, hidden from others; RTS review 2026-11-14,
      // lock `tests/e2e/rts-take-controls.spec.ts`). Only once the room's
      // own handshake is done: before that the RAF loop sends it.
      if (useUIStore.getState().clientReadySent && ctx.room) {
        ctx.room.send('client_ready', { type: 'client_ready' });
        logEvent('client_ready_sent', { msSinceWelcome: 0, pilotSwap: true });
      }
      logEvent('pilot_swap_welcomed', { shipInstanceId: msg.shipInstanceId });
    }

    // Equinox Phase 5 (WS-3) — JOIN-AS-SPECTATOR. The player joins with NO
    // ship at all (free-roam camera). There is no local hull to bootstrap, so
    // SKIP `tryInitPredWorld` and mark `localPoseResolved` vacuously true (no
    // pose to resolve) — the load curtain instead lifts via the spectator
    // branch in `computeBootstrapReadyFromState` (which drops the
    // `localShipInstanceId`/`localPoseResolved` ship gates) + the normal
    // `client_ready` → `warp_in` → `arrivalAcked` handshake. The spectating
    // effects (camera free-roam + input disable + `setSpectator`) are already
    // wired off `pilotMode` (the death→spectator path). A pilot-swap welcome
    // (handled just above) never carries `spectator`, so the two never collide.
    if (msg.spectator === true) {
      const ui = useUIStore.getState();
      ui.setPilotMode('spectator');
      ui.setLocalPoseResolved(true);
      logEvent('joined_as_spectator', { playerId: msg.playerId, sectorKey: msg.sectorKey });
    } else {
      // If state already arrived, bootstrap the prediction world now.
      ctx.tryInitPredWorld(msg.playerId);
    }
    // Phase 2 swift-otter — kick off the DC handshake after welcome.
    // The transport's start() is idempotent so a stale call from a
    // pre-welcome retry is safe.
    if (ctx.webrtcEnabled && ctx.dataChannelTransport) {
      void ctx.dataChannelTransport.start();
    }
  });
}
