/**
 * `ColyseusClient.dispose()`: tear the client down (input, DataChannel, room,
 * subsystems, predWorld, mirror, per-connection stats). Runs once per client;
 * the ctx is the once-built sector-reset ctx plus what only teardown touches.
 */
import type { AiController } from '@core/ai/AiController';
import type { PhysicsWorld } from '@core/physics/World';
import { createWelford } from '@core/math/Welford';
import { createLookaheadController } from '../lookaheadController';
import { createDropDetector } from '../snapshotDropDetector';
import { clearMirror } from '../clearMirror.js';
import { useUIStore } from '../../state/store';
import { logEvent } from '../../debug/ClientLogger';
import { resetBuildModeView } from '../../structures/buildModeView.js';
import type { PredictionResetCtx } from '../prediction/resetPrediction.js';

type Disposable = { dispose(): void };
type Clearable = { clear(): void };

/** What `disposeClient` writes on `ColyseusClient` beyond the sector reset. */
export interface ClientTeardownCtx extends PredictionResetCtx {
  predWorld: PhysicsWorld | null;
  readonly aiController: Pick<AiController, 'unregister' | 'clear'>;
  disposed: boolean;
  localDead: boolean;
  diedAtMs: number;
  /** Input sources and audio: only released (nulled) here. */
  keyboard: unknown;
  touchInput: unknown;
  audio: unknown;
  room: { leave(): unknown } | null;
  readonly snapshotCoalescer: Disposable;
  readonly transitInstr: Disposable;
  readonly rafStallDetector: Disposable;
  readonly hudDispatcher: Disposable;
  readonly ghostManager: Disposable;
  readonly remoteHistory: Clearable;
  readonly predRemoteShipIds: Clearable;
  readonly remoteShipOffsets: Clearable;
  readonly predSwarmKeys: Clearable;
  readonly movingSwarmKeys: Clearable;
  readonly damageFlashFrames: Clearable;
  lastSentInputAtMs: number;
  lastSentInputState: unknown;
  /** `ColyseusGameClient._liveInstanceN` (static: live clients in this page). */
  liveInstanceN: number;
}

export function disposeClient(c: ClientTeardownCtx): void {
  c.cutField.stop();
  // Game time scale: the next session starts at 1× until its snapshots say otherwise.
  useUIStore.getState().setTimeScale(1);
  c.disposed = true;
  c.localDead = false;
  c.diedAtMs = 0;
  useUIStore.getState().setDead(false);
  // Phase 4 WS-A1 — a fresh GameSurface mount (new join / respawn-via-galaxy)
  // builds a new client; reset the spectator flag so the next session starts
  // piloting. (Spectator is client-local and never crosses a room boundary.)
  useUIStore.getState().setPilotMode('pilot');
  // Build mode never crosses a room boundary either (no stale fly-back).
  resetBuildModeView();
  c.keyboard = null;
  c.touchInput = null;
  // Phase 4 swift-otter — close the DC transport BEFORE the room leave
  // so the PeerConnection's signaling channel is shut down before the
  // WS closes. In React 18 StrictMode dev mode the useEffect cleanup
  // → re-mount cycle was creating two ColyseusClients per page load,
  // each with its own DataChannelTransport / PeerConnection. The
  // first instance's PC stayed open (the original dispose() didn't
  // touch it) and continued receiving the brief window of snapshots
  // that landed between its DC opening and the WS-level room.leave()
  // taking effect on the server — those snapshots logged with via=dc
  // alongside the second instance's, and any tick races between the
  // two receivers' `_lastSeenServerTick` produced `snap_dropped_old`
  // events the test surfaced as the integration bug.
  if (c.dataChannelTransport) {
    c.dataChannelTransport.close('client-dispose');
    c.dataChannelTransport = null;
  }
  c.room?.leave();
  c.room = null;

  // Plan: crispy-kazoo, Commit 6 — subsystem disposes.
  // The pre-Commit-6 dispose covered ~14 fields and missed 20+
  // surfaces, which is the proximate cascade-trigger root cause: a
  // stale ColyseusGameClient retained via uncleared subscriptions /
  // timers / Maps. Each subsystem's dispose is idempotent.
  c.snapshotCoalescer.dispose();
  c.transitInstr.dispose();
  c.rafStallDetector.dispose();
  c.hudDispatcher.dispose();
  c.ghostManager.dispose();
  c.aiController.clear();

  c.predWorld?.dispose();
  c.predWorld = null;
  c.reconciler = null;
  c.remoteHistory.clear();
  c.predRemoteShipIds.clear();
  c.remoteShipOffsets.clear();
  c.predSwarmKeys.clear();
  c.movingSwarmKeys.clear();

  // Maps + sets on the client itself (combat surfaces).
  c.damageFlashFrames.clear();
  c.scheduledDamageSpawns.length = 0;

  // Reflection-based clear: every Map / Set / Array on `mirror` empties.
  clearMirror(c.mirror); // ../clearMirror.ts

  // Stats + per-connection accumulators — reset to freshly-constructed
  // (non-nullable types) so a re-mount sees a clean baseline.
  c.rttWelford = createWelford();
  c.lookaheadCtrl = createLookaheadController(6);
  c.dropDetector = createDropDetector();
  c.anchorInitialised = false;
  c.anchorFreshAtMs = -Infinity;
  c.stallHoldSinceMs = -1;
  c.localPoseResolvedLogged = false;
  c.lastSentInputAtMs = 0;
  c.lastSentInputState = null;

  // Audio reference released — GameSurface owns the lifecycle.
  c.audio = null;

  c.liveInstanceN = Math.max(0, c.liveInstanceN - 1);
  logEvent('dispose_complete', {
    liveInstanceN: c.liveInstanceN,
    mirrorShipsRemaining: c.mirror.ships.size,
    mirrorSwarmRemaining: c.mirror.swarm?.size ?? 0,
  });
}
