/**
 * The room connection around `ColyseusClient.connect()`: the URL transport
 * flags, the connect-time diagnostics, the join (auth token, ship kind,
 * 12 s timeout), the DEV bandwidth tally, the DataChannel snapshot
 * transport and the room's leave / error lifecycle. Runs once per connect
 * or room bind, never per frame.
 */
import type { Client, Room } from 'colyseus.js';
import type { Clock } from '@core/clock/Clock';
import type { SnapshotMessage } from '@shared-types/messages';
import { useUIStore, type ConnectionStatus } from '../../state/store';
import { logEvent } from '../../debug/ClientLogger';
import { installLongtaskObserver } from '../../debug/longtaskObserver';
import { installPageLifecycleObserver } from '../../debug/pageLifecycleObserver';
import { startHealthStatsPublisher } from '../../debug/healthStats';
import { DataChannelTransport } from '../dataChannelTransport.js';
import { webrtcEnabledFromSearch } from '../webrtcEnable.js';
import type { SnapshotCoalescer } from '../SnapshotCoalescer.js';

/** The connection's status callback (`ColyseusClientCallbacks.onConnectionStatus`). */
export interface ConnectionStatusSink {
  onConnectionStatus: (s: ConnectionStatus) => void;
}

/** The URL-driven transport flags, read once at construction. */
export interface ConnectionFlags {
  /** Snapshot coalescing (`?coalesce=0` turns it off). */
  coalesce: boolean;
  /** The WebRTC DataChannel snapshot transport. */
  webrtc: boolean;
}

export function readConnectionFlags(): ConnectionFlags {
  // Probe 6 — `?coalesce=0` disables snapshot coalescing for A/B
  // testing. Default ON. Tests construct with the mock URL absent →
  // coalesce defaults ON, matching production behaviour.
  let coalesceParam: string | null = null;
  try {
    if (typeof window !== 'undefined' && window.location?.search) {
      coalesceParam = new URLSearchParams(window.location.search).get('coalesce');
    }
  } catch {
    // Non-browser context — keep default.
  }
  const coalesce = coalesceParam !== '0';
  // swift-otter — WebRTC DataChannel snapshot transport. Default flipped
  // ON for real users (2026-06-06): on-device the DC carries ~99% of
  // snapshots over UDP, avoiding the WS/TCP head-of-line amplification that
  // stretches a brief WiFi-radio stall into a ~530 ms snapshot gap (the
  // on-device "jumps"). Reliable WS is retained as automatic fallback when
  // the DC can't establish (NAT/cellular), so default-on is safe. Default
  // OFF under Playwright automation (navigator.webdriver) so the E2E suite
  // stays WS-deterministic AND the netgate keeps measuring the proxied WS
  // path (the DC is P2P UDP and bypasses the injected-latency proxy).
  // `?webrtc=0`/`=1` override. Pure decision lives in `webrtcEnable.ts`.
  let webrtcEnabled = false;
  try {
    if (typeof window !== 'undefined' && window.location) {
      const isAutomation =
        typeof navigator !== 'undefined' && navigator.webdriver === true;
      webrtcEnabled = webrtcEnabledFromSearch(window.location.search, isAutomation);
    }
  } catch {
    // Non-browser context — keep default OFF (no RTCPeerConnection).
  }
  return { coalesce, webrtc: webrtcEnabled };
}

/** Connect-time diagnostics; each is idempotent. */
export function installConnectionDiagnostics(): void {
  // Mobile main-thread block detector — see `longtaskObserver.ts` for the
  // motivating capture (`2026-05-09T07-23-39-893Z-651792`: two ~500–600 ms
  // client-receive gaps with the server emitting cleanly throughout).
  // Idempotent; safe to call again on reconnect.
  installLongtaskObserver();
  // r2 evidence pass — visibility / freeze / resume / connection
  // change listeners. Distinguishes "page backgrounded" throttle
  // from "phone CPU throttle" in effectiveHz drops.
  installPageLifecycleObserver();
  // Paradigm plan (quirky-rabbit) Phase 6 — kick the rolling-30 s
  // health-stats publisher. Idempotent at the function-level: the
  // setInterval is set per call, but every connect() call is in fact
  // a fresh ColyseusClient instance via clientSingleton, so it lands
  // exactly once per session.
  startHealthStatsPublisher((s) => useUIStore.getState().setHealthStats(s));
}

/** Join (or create) `roomName`; reports `'error'` and rethrows on failure. */
export async function joinRoom(
  client: Client,
  roomName: string,
  storedPlayerId: string | null,
  extraJoinOptions: Record<string, unknown>,
  callbacks: ConnectionStatusSink,
): Promise<Room> {
  let resolvedRoom: Room;
  try {
    logEvent('cc_join_attempt', {});
    const { loadToken } = await import('../../auth/tokenStorage.js');
    const authToken = loadToken();
    // Pull the player's selected ship kind out of the UI store at the moment
    // we open the room. Server validates and falls back to the catalogue
    // default on any unknown id (`isShipKindId`), so a mid-build kind change
    // can't crash the spawn path. Limbo / rebind paths ignore this.
    const shipKind = useUIStore.getState().selectedShipKind;
    const joinPromise = client.joinOrCreate<unknown>(roomName, {
      playerId: storedPlayerId,
      ...(authToken ? { authToken } : {}),
      shipKind,
      ...extraJoinOptions,
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('joinOrCreate timed out after 12 s — WS proxy likely broken')), 12000),
    );
    resolvedRoom = await Promise.race([joinPromise, timeoutPromise]);
  } catch (err) {
    logEvent('cc_join_failed', { err: String(err) });
    callbacks.onConnectionStatus('error');
    throw err;
  }
  return resolvedRoom;
}

/** Phase 5e DEV-only inbound bandwidth tally surfaced on `window.__EQX_BW_STATS`. */
export interface BwStats {
  startedAt: number;
  swarmBytes: number;
  swarmPackets: number;
  snapshotBytes: number;
  snapshotCount: number;
  reset(): void;
}

export function bwStats(): BwStats | null {
  if (!import.meta.env.DEV) return null;
  return (window as unknown as { __EQX_BW_STATS?: BwStats }).__EQX_BW_STATS ?? null;
}

export function installBwStats(clock: Clock): void {
  // Phase 5e: DEV-only inbound-bandwidth tally exposed on `window` so the
  // swarm-bandwidth E2E can sample bytes/sec without DPI-level WS plumbing.
  // Tracks `swarmBytes` (binary channel — the dominant cost) and
  // `snapshotBytes` (JSON-shape approximation). Production builds tree-
  // shake the window assignment via the import.meta.env.DEV branch.
  if (import.meta.env.DEV) {
    const w = window as unknown as { __EQX_BW_STATS?: BwStats };
    if (!w.__EQX_BW_STATS) {
      // Closure-capture the injected clock so the `reset()` method (where
      // `this` rebinds to `stats`) still uses the right time source.
      const devClock = clock;
      const stats: BwStats = {
        startedAt: devClock.now(),
        swarmBytes: 0,
        swarmPackets: 0,
        snapshotBytes: 0,
        snapshotCount: 0,
        reset(): void {
          this.startedAt = devClock.now();
          this.swarmBytes = 0;
          this.swarmPackets = 0;
          this.snapshotBytes = 0;
          this.snapshotCount = 0;
        },
      };
      w.__EQX_BW_STATS = stats;
    }
  }
}

/** Where DataChannel snapshots go (the same route as the WS `snapshot`). */
export interface SnapshotSink {
  readonly snapshotCoalescer: SnapshotCoalescer;
  logSnapshotRecvTelemetry(snap: SnapshotMessage, via: 'ws' | 'dc'): void;
  applySnapshotNow(snap: SnapshotMessage): void;
}

/** The DataChannel snapshot transport for `room` (started by the welcome handler). */
export function createSnapshotDataChannel(room: Room, sink: SnapshotSink): DataChannelTransport {
  // Phase 2/4 swift-otter — instantiate the DataChannel transport
  // SYNCHRONOUSLY before any room handlers so the welcome handler is
  // guaranteed to have a non-null `_dataChannelTransport` when it
  // fires. The first Phase 4 E2E run failed because a dynamic
  // `import('./dataChannelTransport.js')` left the field null past
  // welcome; start() never ran; DC never opened. Static import has
  // no native-binding cost on the client (RTCPeerConnection is a
  // browser global; @colyseus/msgpackr is already in the Colyseus
  // import graph) so the only cost paid by non-opted-in sessions is
  // a few KB of dead JS — acceptable for measurement parity.
  return new DataChannelTransport({
    send: (type, payload) => room.send(type, payload),
    onSnapshot: (snap) => {
      // Phase 4 swift-otter — log transport-tagged recv telemetry
      // BEFORE the coalescer enqueue so the measurement reflects DC
      // arrival (not apply). Mirrors the WS-path call above.
      sink.logSnapshotRecvTelemetry(snap, 'dc');
      // Mirror the WS-path coalescer behaviour: queue when enabled,
      // otherwise apply immediately. Both paths converge at
      // applySnapshotNow → handleSnapshot.
      if (sink.snapshotCoalescer.isEnabled()) {
        sink.snapshotCoalescer.enqueue(snap);
      } else {
        sink.applySnapshotNow(snap);
      }
    },
    onDiag: (tag, data) => logEvent(tag, data),
  });
}

/** What the room's leave handler writes on the client. Built once (#14). */
export interface RoomLifecycleCtx {
  dataChannelTransport: DataChannelTransport | null;
  /** Drop the keyboard / touch input sources (`connect()` set them). */
  detachInput(): void;
}

/** The room's `onLeave` / `onError`: close the DataChannel and report status. */
export function registerRoomLifecycle(room: Room, ctx: RoomLifecycleCtx, callbacks: ConnectionStatusSink): void {
  room.onLeave((code) => {
    logEvent('cc_left_room', { code });
    logEvent('disconnected', { code });
    // Phase 2 swift-otter — close the DataChannel on every onLeave.
    // Sector handoffs short-circuit below, so the transport teardown
    // there is `resetPredictionState` (called by the transit-arrival
    // path); this is the non-transit disconnect path.
    const cur = useUIStore.getState();
    if (cur.transitState !== 'IN_TRANSIT' && cur.transitState !== 'SPOOLING') {
      if (ctx.dataChannelTransport) {
        ctx.dataChannelTransport.close('room-leave');
        ctx.dataChannelTransport = null;
      }
    }
    // During transit `consumeSeatReservation` we'll see an onLeave on the
    // source room as the WS is replaced. Don't flip status to disconnected
    // when a transit is mid-flight — the destination is already being
    // bound. The post-consume rebind sets connected status implicitly via
    // the new room's flow.
    if (cur.transitState === 'IN_TRANSIT' || cur.transitState === 'SPOOLING') return;
    callbacks.onConnectionStatus('disconnected');
    ctx.detachInput();
  });

  room.onError((code, message) => {
    logEvent('cc_room_error', { code, message });
    logEvent('room_error', { code, message });
    callbacks.onConnectionStatus('error');
  });
}
