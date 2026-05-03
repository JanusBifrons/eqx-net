import { Client, Room } from 'colyseus.js';
import type { RenderMirror, ProjectileRenderState } from '@core/contracts/IRenderer';
import type { WelcomeMessage, SnapshotMessage, HitAckMessage, DamageEvent, DestroyEvent, LaserFiredEvent, RespawnAckMessage } from '@shared-types/messages';
import { PhysicsWorld, type ShipPhysicsState } from '@core/physics/World';
import { Reconciler, type InputRecord } from '@core/prediction/Reconciler';
import { useUIStore, type ConnectionStatus } from '../state/store';
import { logEvent } from '../debug/ClientLogger';
import { GhostManager } from '../combat/GhostProjectile';
import { HITSCAN_RANGE, WEAPON_COOLDOWN_TICKS, SHIP_MAX_HEALTH } from '@core/combat/Weapons';
import type { TouchInput } from '../input/TouchInput';
import { decodeSwarmPacket } from './BinarySwarmDecoder';
import { setSwarmDisplayDelayMs, ADAPTIVE_DELAY_FACTOR } from './swarmInterpolation';

export interface ColyseusClientCallbacks {
  onConnectionStatus: (s: ConnectionStatus) => void;
  onPlayerId: (id: string) => void;
}

/** Timestamped remote-ship state snapshot for 100 ms display-delay interpolation. */
interface RemoteEntry {
  ts: number;
  state: ShipPhysicsState;
}

const HISTORY_MAX = 30;

/** Live prediction/latency metrics readable from the DOM or tests. */
export interface PredictionStats {
  /** RTT estimate from last reconciliation (ms). */
  rttMs: number;
  /** Prediction position drift at last reconciliation (world units). */
  driftUnits: number;
  /** Prediction angle drift at last reconciliation (radians). */
  angleDriftRad: number;
  /** Whether a visual lerp correction is currently decaying. */
  lerping: boolean;
  /** Interval between the last two snapshots (ms). 0 if < 2 snapshots received. */
  snapshotIntervalMs: number;
  /** Total snapshots received since connect. */
  snapshotCount: number;
  /** How many client input ticks are ahead of the last server-acked tick. */
  ticksAhead: number;
  /** Server tick of the last received snapshot. */
  lastServerTick: number;
  /** Last server-acked input tick for the local player. */
  lastAckedTick: number;
  /** Reconciliations that produced position drift > 0.05 u (filters float32 noise). */
  significantCorrectionCount: number;
  /** Reconciliations that produced angle drift > 0.001 rad (filters float32 noise). */
  significantAngleCorrectionCount: number;
  /** Largest single-reconciliation position drift observed (world units). */
  maxDriftUnits: number;
  /** Sum of all position drift magnitudes. Divide by snapshotCount for mean. */
  totalDriftUnits: number;
  /** Largest single-reconciliation angle drift observed (radians). */
  maxAngleDriftRad: number;
  /** Sum of all angle drift magnitudes. Divide by snapshotCount for mean. */
  totalAngleDriftRad: number;
  /** Max − min of the last 10 snapshot intervals (ms). 0 if < 2 snapshots. */
  snapshotJitterMs: number;
  /** Correction rate over the most recent 10-snapshot rolling window (0–1). */
  rollingCorrRate: number;
}

/** Phase 5e DEV-only inbound bandwidth tally surfaced on `window.__EQX_BW_STATS`. */
interface BwStats {
  startedAt: number;
  swarmBytes: number;
  swarmPackets: number;
  snapshotBytes: number;
  snapshotCount: number;
  reset(): void;
}

function bwStats(): BwStats | null {
  if (!import.meta.env.DEV) return null;
  return (window as unknown as { __EQX_BW_STATS?: BwStats }).__EQX_BW_STATS ?? null;
}

/** Position drift below this is float32-serialisation noise. */
const NOISE_THRESHOLD = 0.05;
/** Angle drift below this is float32-serialisation noise (~0.057°). */
const ANGLE_NOISE_THRESHOLD = 0.001;

/** Scale render lerp duration to drift magnitude (used for remote ships).
 *  Larger drifts get longer lerps so post-collision corrections aren't snappy. */
function lerpFramesForDrift(drift: number): number {
  if (drift < 3.0)  return 6;   // 100 ms
  if (drift < 10.0) return 10;  // 167 ms
  return 14;                    // 233 ms — large post-collision snap
}

/** Simple monotonically incrementing shot ID generator. */
let _shotCounter = 0;
function nextShotId(): string {
  return `shot-${_shotCounter++}`;
}

/** Joystick magnitude below this is treated as idle (deadzone). */
const TOUCH_DEADZONE = 0.2;
/** Stick magnitude above this engages thrust (when roughly aligned with target). */
const TOUCH_THRUST_MAG = 0.4;
/** Allow thrust within this cone (radians) around the desired heading. */
const TOUCH_THRUST_CONE = Math.PI / 3; // 60°
/** Minimum |angular delta| (radians) before turning. Prevents jitter when aligned. */
const TOUCH_TURN_TOLERANCE = 0.08; // ~4.6°

export class ColyseusGameClient {
  readonly mirror: RenderMirror = {
    ships: new Map(),
    swarm: new Map(),
    projectiles: new Map(),
    localPlayerId: null,
    damagedShips: new Set(),
    explodingShips: new Set(),
    remoteLasers: new Map(),
    boostingShips: new Set(),
  };

  /** Keys (`swarm-${entityId}`) of swarm bodies currently spawned in the prediction world. */
  private predSwarmKeys = new Set<string>();

  /** IDs of remote ships currently spawned in the prediction world. */
  private predRemoteShipIds = new Set<string>();
  /** Per-remote-ship render lerp offsets — applied in updateMirror() to smooth server corrections. */
  private readonly _remoteShipOffsets = new Map<string, { ox: number; oy: number; framesLeft: number; totalFrames: number }>();

  /** Publicly readable prediction/latency stats. Updated on every snapshot. */
  readonly stats: PredictionStats = {
    rttMs: 0,
    driftUnits: 0,
    angleDriftRad: 0,
    lerping: false,
    snapshotIntervalMs: 0,
    snapshotCount: 0,
    ticksAhead: 0,
    lastServerTick: 0,
    lastAckedTick: 0,
    significantCorrectionCount: 0,
    significantAngleCorrectionCount: 0,
    maxDriftUnits: 0,
    totalDriftUnits: 0,
    maxAngleDriftRad: 0,
    totalAngleDriftRad: 0,
    snapshotJitterMs: 0,
    rollingCorrRate: 0,
  };

  private room: Room | null = null;
  private inputTick = 0;
  /** Raw server snapshot position — shown as the orange ghost ship. */
  private lastSnapshotPos: { x: number; y: number } | null = null;
  /**
   * Server physics tick recorded from the welcome message.
   * Used to normalise snap.serverTick into client-tick space.
   */
  private serverTickAtWelcome = 0;
  /**
   * `performance.now()` when the welcome message was processed. Used as the
   * initial anchor for `inputTick`; on every subsequent snapshot the anchor is
   * advanced to the snapshot's `serverTick` (`updateClockAnchor()`). See
   * `tickPhysics()`.
   */
  private welcomePerfNow = 0;
  /**
   * Server tick recorded at `clockAnchorPerfNow` — the live reference frame
   * the client uses to compute `targetTick`. Updated on every snapshot so a
   * server that's running below 60 Hz (overloaded) drags the client's tick
   * advance down with it instead of letting `inputTick` race ahead.
   */
  private clockAnchorServerTick = 0;
  private clockAnchorPerfNow = 0;
  /**
   * Estimated half-RTT in ticks. The client should aim to be this many ticks
   * AHEAD of the latest known server tick so its inputs arrive at the server
   * just-in-time for the corresponding server tick. Kept as a smoothed value;
   * jumpy RTT causes oscillation otherwise.
   */
  private leadTicks = 6;
  private disposed = false;

  // Wall-clock-anchored input loop (driven by rAF in App.tsx).
  private keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean; fireHeld: boolean; boost: boolean } } | null = null;
  private touchInput: TouchInput | null = null;
  private lastFiredAtTick = -999;
  /** Elapsed ms of the last frame — used by updateMirror() for ghost advancement. */
  private lastFrameMs = 1000 / 60;

  // Prediction
  private predWorld: PhysicsWorld | null = null;
  private reconciler: Reconciler | null = null;

  // Snapshot timing
  private lastSnapshotAt = 0;
  // Rolling buffers for jitter and correction-rate metrics (last 10 snapshots).
  private readonly _recentIntervals: number[] = [];
  /** Phase 6.5 — EWMA of `snapshotIntervalMs`, used to size the adaptive
   *  swarm display-delay buffer. 0 = uninitialised; first snapshot seeds. */
  private _intervalEwma = 0;
  private readonly _recentCorrFlags: number[] = [];

  // Remote ship interpolation: per-player timestamped history
  private remoteHistory = new Map<string, RemoteEntry[]>();

  // Combat
  private readonly ghostManager = new GhostManager();
  /** Damage flash: set of player IDs currently flashing red (cleared after one frame). */
  private readonly _damageFlashFrames = new Map<string, number>();
  /** Set when the local ship is destroyed — blocks firing until reconnect. */
  private localDead = false;

  async connect(
    wsUrl: string,
    storedPlayerId: string | null,
    keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean; fireHeld: boolean; boost: boolean } },
    callbacks: ColyseusClientCallbacks,
    roomName = 'sector',
    extraJoinOptions: Record<string, unknown> = {},
    touchInput?: TouchInput,
  ): Promise<void> {
    // Init client-side prediction world before joining so it is ready as soon as
    // we receive our playerId.
    this.predWorld = await PhysicsWorld.create();

    callbacks.onConnectionStatus('connecting');
    console.log('[ColyseusClient] connecting to', wsUrl, 'playerId:', storedPlayerId);
    const client = new Client(wsUrl);

    let resolvedRoom: Room;
    try {
      console.log('[ColyseusClient] calling joinOrCreate…');
      const { loadToken } = await import('../auth/tokenStorage.js');
      const authToken = loadToken();
      const joinPromise = client.joinOrCreate<unknown>(roomName, {
        playerId: storedPlayerId,
        ...(authToken ? { authToken } : {}),
        ...extraJoinOptions,
      });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('joinOrCreate timed out after 12 s — WS proxy likely broken')), 12000),
      );
      resolvedRoom = await Promise.race([joinPromise, timeoutPromise]);
    } catch (err) {
      console.error('[ColyseusClient] joinOrCreate failed:', err);
      callbacks.onConnectionStatus('error');
      throw err;
    }

    if (this.disposed) {
      resolvedRoom.leave();
      return;
    }

    this.room = resolvedRoom;
    console.log('[ColyseusClient] joinOrCreate resolved, roomId:', this.room.roomId);

    // Phase 5e: DEV-only inbound-bandwidth tally exposed on `window` so the
    // swarm-bandwidth E2E can sample bytes/sec without DPI-level WS plumbing.
    // Tracks `swarmBytes` (binary channel — the dominant cost) and
    // `snapshotBytes` (JSON-shape approximation). Production builds tree-
    // shake the window assignment via the import.meta.env.DEV branch.
    if (import.meta.env.DEV) {
      const w = window as unknown as { __EQX_BW_STATS?: BwStats };
      if (!w.__EQX_BW_STATS) {
        const stats: BwStats = {
          startedAt: performance.now(),
          swarmBytes: 0,
          swarmPackets: 0,
          snapshotBytes: 0,
          snapshotCount: 0,
          reset(): void {
            this.startedAt = performance.now();
            this.swarmBytes = 0;
            this.swarmPackets = 0;
            this.snapshotBytes = 0;
            this.snapshotCount = 0;
          },
        };
        w.__EQX_BW_STATS = stats;
      }
    }

    this.room.onMessage('welcome', (msg: WelcomeMessage) => {
      const idChanged = storedPlayerId && msg.playerId !== storedPlayerId;
      console.log(
        '[ColyseusClient] welcome received, playerId:', msg.playerId,
        idChanged ? '(server reassigned — collision guard)' : '',
        'serverTick:', msg.serverTick,
      );
      this.serverTickAtWelcome = msg.serverTick;
      this.welcomePerfNow = performance.now();
      this.clockAnchorServerTick = msg.serverTick;
      this.clockAnchorPerfNow = this.welcomePerfNow;
      this.inputTick = msg.serverTick; // Sync to server tick space so fire messages pass temporal plausibility check.
      logEvent('welcome', { playerId: msg.playerId, serverTick: msg.serverTick, idReassigned: !!idChanged });
      this.mirror.localPlayerId = msg.playerId;
      callbacks.onPlayerId(msg.playerId);
      // If state already arrived, bootstrap the prediction world now.
      this.tryInitPredWorld(msg.playerId);
    });

    this.room.onMessage('snapshot', (snap: SnapshotMessage) => {
      const bw = bwStats();
      if (bw) {
        // Approximation — Colyseus uses msgpack on the wire, which is
        // typically ~70% of the JSON length. Using JSON length is a
        // conservative upper bound that's easy to compute without DPI.
        bw.snapshotBytes += JSON.stringify(snap).length;
        bw.snapshotCount += 1;
      }
      this.handleSnapshot(snap);
    });

    // Phase 5c: binary swarm channel. Server packs asteroids/drones into a
    // fixed-stride buffer at 60 Hz (delta-encoded; full snapshot every 60th
    // tick). Decoder mutates `mirror.swarm` in place — zero per-frame alloc.
    // After decode we mirror swarm poses into predWorld so the local ship can
    // collide with them and the local hitscan can target them. The body is
    // keyed by `swarm-${entityId}` to avoid colliding with playerIds; the
    // server's `laser_fired` events use the same key for swarm hits.
    this.room.onMessage('swarm', (raw: unknown) => {
      const bw = bwStats();
      if (raw instanceof ArrayBuffer) {
        if (bw) { bw.swarmBytes += raw.byteLength; bw.swarmPackets += 1; }
        decodeSwarmPacket(raw, this.mirror);
      } else if (ArrayBuffer.isView(raw)) {
        if (bw) { bw.swarmBytes += raw.byteLength; bw.swarmPackets += 1; }
        decodeSwarmPacket(raw, this.mirror);
      }
      this.syncSwarmIntoPredWorld();
      // Phase 6 HUD readout. mirror.swarm is the live decoded set; .size is
      // O(1). At decimation-only ticks the count stays steady (no entities
      // come and go), so updating this on every packet is cheap.
      useUIStore.getState().setSwarmCount(this.mirror.swarm?.size ?? 0);
    });

    this.room.onMessage('damage', (evt: DamageEvent) => {
      this.handleDamage(evt);
    });

    this.room.onMessage('destroy', (evt: DestroyEvent) => {
      this.handleDestroy(evt);
    });

    this.room.onMessage('hit_ack', (ack: HitAckMessage) => {
      this.ghostManager.resolve(ack.clientShotId, ack.hit);
      if (ack.rejected) {
        useUIStore.getState().setSectorAlert('shot_rejected');
        setTimeout(() => useUIStore.getState().setSectorAlert(null), 1500);
      }
    });

    this.room.onMessage('laser_fired', (evt: LaserFiredEvent) => {
      // Own shots are already shown as liveBeam — only store remote ones.
      if (evt.shooterId === this.mirror.localPlayerId) return;
      const dx = evt.toX - evt.fromX;
      const dy = evt.toY - evt.fromY;
      const range = Math.hypot(dx, dy);
      // Upsert: replaces the previous beam from this shooter so there is never
      // more than one entry per shooter and the TTL resets on each shot.
      // Player beams are HELD weapons (cooldown 167 ms at 60 Hz; TTL 400 ms
      // keeps the visual continuous while space is held).
      //
      // For AI shooters (`swarm-${entityId}`) the iteration we converged on:
      //   - First attempt 400 ms: the beam endpoints were stamped at fire time
      //     and stayed frozen, but the drone moved underneath, so each new
      //     fire teleported the beam origin → "jittery and laggy" (5c smoke).
      //   - Second attempt 80 ms: gave a discrete flash, but cooldown is 167 ms,
      //     so there's an 87 ms gap between flashes → visible flicker.
      //   - Settled: 250 ms TTL (overlaps cooldown by ~83 ms, no gap) AND the
      //     renderer re-derives the beam ORIGIN from `mirror.swarm[entityId]`
      //     each frame so it tracks the moving drone smoothly. Same pattern
      //     player beams use against `mirror.ships[localId]`.
      const isAiShooter = evt.shooterId.startsWith('swarm-');
      const ttlMs = isAiShooter ? 250 : 400;
      (this.mirror.remoteLasers ??= new Map()).set(evt.shooterId, {
        range,
        hit: evt.hit,
        targetId: evt.targetId,
        expiresAt: performance.now() + ttlMs,
        fromX: evt.fromX,
        fromY: evt.fromY,
        toX: evt.toX,
        toY: evt.toY,
      });
    });

    this.room.onMessage('respawn_ack', (msg: RespawnAckMessage) => {
      this.handleRespawnAck(msg);
    });

    this.room.onStateChange((state: unknown) => {
      this.syncMirror(state);
    });

    this.room.onLeave((code) => {
      console.warn('[ColyseusClient] left room, code:', code);
      logEvent('disconnected', { code });
      callbacks.onConnectionStatus('disconnected');
      this.keyboard = null;
      this.touchInput = null;
    });

    this.room.onError((code, message) => {
      console.error('[ColyseusClient] room error', code, message);
      logEvent('room_error', { code, message });
      callbacks.onConnectionStatus('error');
    });

    callbacks.onConnectionStatus('connected');
    console.log('[ColyseusClient] connected — input loop driven by rAF');
    this.keyboard = keyboard;
    this.touchInput = touchInput ?? null;
  }

  // ── Combat event handlers ────────────────────────────────────────────────

  private handleDamage(evt: DamageEvent): void {
    const localId = this.mirror.localPlayerId;
    if (evt.targetId === localId) {
      const pct = Math.round((evt.newHealth / SHIP_MAX_HEALTH) * 100);
      useUIStore.getState().setHullPct(pct);
    }
    // Flash the damaged ship for 6 frames.
    this._damageFlashFrames.set(evt.targetId, 6);
  }

  /**
   * Single authoritative path for removing any entity from the simulation.
   * Called immediately on destroy event for both local and remote ships.
   * syncMirror acts as a defensive fallback only.
   */
  private killEntity(id: string): void {
    // Trigger explosion sprite on this frame (renderer consumes then App.tsx clears).
    this.mirror.explodingShips?.add(id);

    // Immediately remove physics body so hitscan and collisions cannot hit it.
    this.predWorld?.despawnShip(id);

    // Remove from render mirror so the sprite is culled this frame.
    this.mirror.ships.delete(id);

    if (id === this.mirror.localPlayerId) {
      this.localDead = true;
      this.mirror.liveBeam = null;
      this.ghostManager.clearForShip(id);
      useUIStore.getState().setHullPct(0);
      useUIStore.getState().setDead(true);
      useUIStore.getState().setSectorAlert('SHIP DESTROYED');
      setTimeout(() => useUIStore.getState().setSectorAlert(null), 3000);
    } else {
      this.predRemoteShipIds.delete(id);
      this.remoteHistory.delete(id);
      this._remoteShipOffsets.delete(id);
    }
  }

  private handleDestroy(evt: DestroyEvent): void {
    if (evt.targetId.startsWith('swarm-')) {
      this.killSwarmEntity(evt.targetId);
      return;
    }
    this.killEntity(evt.targetId);
  }

  /**
   * Remove a swarm entity (drone) immediately on a destroy event. Sweeps the
   * mirror entry, the predWorld body, and the damage-flash tracker. The next
   * binary swarm packet will confirm the entity is gone (delta packets won't
   * mention it; the next 60-tick full snapshot will sweep on the server's say-so).
   */
  private killSwarmEntity(wireId: string): void {
    const entityIdStr = wireId.slice('swarm-'.length);
    const entityId = parseInt(entityIdStr, 10);
    if (Number.isNaN(entityId)) return;
    this.mirror.swarm?.delete(entityId);
    if (this.predWorld?.hasShip(wireId)) this.predWorld.despawnShip(wireId);
    this.predSwarmKeys.delete(wireId);
    this._damageFlashFrames.delete(wireId);
    // Reuse the explosion sprite path — the renderer keys explosions off
    // sprite position (looked up by id), and `swarm-${entityId}` is the
    // sprite key, so the existing explosion machinery just works.
    this.mirror.explodingShips?.add(wireId);
    useUIStore.getState().setSwarmCount(this.mirror.swarm?.size ?? 0);
  }

  private handleRespawnAck(msg: RespawnAckMessage): void {
    const playerId = this.mirror.localPlayerId;
    if (!playerId || !this.predWorld) return;

    // Spawn new physics body at server-assigned position.
    this.predWorld.spawnShip(playerId, msg.x, msg.y);

    // Re-initialise reconciler so it doesn't try to replay inputs from before death.
    this.reconciler = new Reconciler(this.predWorld, playerId);

    // Sync input tick to server tick so first fire passes temporal plausibility,
    // and re-anchor the clock so tickPhysics()'s `targetTick` derivation stays
    // consistent with the new tick base.
    this.inputTick = msg.serverTick;
    this.serverTickAtWelcome = msg.serverTick;
    this.welcomePerfNow = performance.now();
    this.clockAnchorServerTick = msg.serverTick;
    this.clockAnchorPerfNow = this.welcomePerfNow;

    // Bootstrap mirror so the renderer shows the ship immediately (before next syncMirror).
    this.mirror.ships.set(playerId, { x: msg.x, y: msg.y, vx: 0, vy: 0, angle: 0 });

    this.localDead = false;
    useUIStore.getState().setDead(false);
    useUIStore.getState().setHullPct(100);
    useUIStore.getState().setSectorAlert(null);

    console.log('[ColyseusClient] respawned at', msg.x.toFixed(1), msg.y.toFixed(1));
  }

  /** Send a respawn request to the server. Only valid while the local ship is dead. */
  respawnShip(): void {
    if (!this.room || !this.localDead) return;
    this.room.send('respawn', { type: 'respawn' });
  }

  // ── Prediction bootstrap ────────────────────────────────────────────────

  private tryInitPredWorld(playerId: string): void {
    if (!this.predWorld || this.predWorld.hasShip(playerId)) return;
    const existing = this.mirror.ships.get(playerId);
    if (!existing) return;
    this.predWorld.spawnShip(playerId, existing.x, existing.y);
    this.predWorld.setShipState(playerId, existing);
    this.reconciler = new Reconciler(this.predWorld, playerId);
    console.log('[ColyseusClient] prediction world initialised at', existing.x.toFixed(1), existing.y.toFixed(1));
    // Retrospectively spawn any remote ships that arrived in the initial Colyseus
    // state patch (before localId was set, so syncMirror skipped predWorld spawn).
    for (const [id, state] of this.mirror.ships) {
      if (id === playerId) continue;
      if (this.predWorld.hasShip(id) || this.predRemoteShipIds.has(id)) continue;
      this.predWorld.spawnShip(id, state.x, state.y);
      this.predWorld.setShipState(id, state);
      this.predRemoteShipIds.add(id);
    }
    // Likewise for swarm entries: a binary `swarm` packet may have arrived
    // before predWorld existed; bring those bodies up now.
    this.syncSwarmIntoPredWorld();
  }

  // ── Snapshot / reconciliation ───────────────────────────────────────────

  private handleSnapshot(snap: SnapshotMessage): void {
    const localId = this.mirror.localPlayerId;
    const now = performance.now();

    // Apply the server-authoritative boost set into the render mirror so the
    // PixiRenderer can draw an exhaust trail for whichever ships are currently
    // boosting. Reset first so leavers / shift-released ships drop out.
    if (this.mirror.boostingShips) {
      this.mirror.boostingShips.clear();
      if (snap.boostingIds) {
        for (const id of snap.boostingIds) this.mirror.boostingShips.add(id);
      }
    }

    // Phase 6 — surface the server's TiDi rate to the HUD via Zustand. Schema
    // diff already updates `room.state.clockRate`; reading it on every
    // snapshot is a cheap polling heartbeat that avoids a separate listener.
    if (this.room) {
      const stateAny = this.room.state as unknown as { clockRate?: number };
      const rate = typeof stateAny.clockRate === 'number' ? stateAny.clockRate : 1.0;
      useUIStore.getState().setClockRate(rate);
    }

    // Update snapshot timing stats regardless of prediction state.
    const intervalMs = this.lastSnapshotAt > 0 ? now - this.lastSnapshotAt : 0;
    this.lastSnapshotAt = now;
    this.stats.snapshotCount++;
    this.stats.snapshotIntervalMs = intervalMs;
    this.stats.lastServerTick = snap.serverTick;

    // Phase 6 — derive effective server wall-clock tick rate. Snapshot
    // broadcasts every 3 ticks, so tickHz = 3000 / intervalMs. EWMA-smoothed
    // so single-snapshot jitter doesn't make the chip flicker.
    if (intervalMs > 0) {
      const instantHz = 3000 / intervalMs;
      const prev = useUIStore.getState().serverTickHz;
      const smoothed = prev * 0.8 + instantHz * 0.2;
      useUIStore.getState().setServerTickHz(smoothed);

      // Phase 6.5 — adapt the swarm display-delay buffer's lookback window
      // to the observed inter-arrival cadence. EWMA-smoothed so single-tick
      // jitter doesn't make sprites stutter as the delay snaps around.
      // Steady-state at 60 Hz server: intervalMs ≈ 50 → delay = 75 → clamped
      // to 100 (the floor). Burn / overload at 19 Hz: intervalMs ≈ 170 →
      // delay = 255 — buffer always has half an arrival of headroom.
      this._intervalEwma = this._intervalEwma === 0
        ? intervalMs
        : this._intervalEwma * 0.85 + intervalMs * 0.15;
      setSwarmDisplayDelayMs(this._intervalEwma * ADAPTIVE_DELAY_FACTOR);
    }

    // Rolling jitter: max − min of the last 10 snapshot intervals.
    if (intervalMs > 0) {
      this._recentIntervals.push(intervalMs);
      if (this._recentIntervals.length > 10) this._recentIntervals.shift();
    }
    this.stats.snapshotJitterMs = this._recentIntervals.length >= 2
      ? Math.max(...this._recentIntervals) - Math.min(...this._recentIntervals)
      : 0;

    // Re-anchor the input clock to this snapshot's server tick. Critical when
    // the server is over-budget and effectively running below 60 Hz: without
    // re-anchoring, the client's wall-clock-derived `targetTick` runs ahead
    // of `serverTick` and the reconciler's replay window grows unboundedly,
    // producing the 30-60% mobile `corr` rate observed in the May 2026 capture.
    this.clockAnchorServerTick = snap.serverTick;
    this.clockAnchorPerfNow = now;
    // Smooth the half-RTT lead so a single jitter spike doesn't whip targetTick
    // around. 1/60 s = 16.67 ms per tick; clamp to a sane window.
    if (this.reconciler) {
      const desiredLead = Math.max(3, Math.min(20, Math.round(this.reconciler.lastRtt / 33)));
      this.leadTicks = Math.round(this.leadTicks * 0.85 + desiredLead * 0.15);
    }

    if (!localId || !this.reconciler) {
      if (this.predWorld) {
        // Sync remote ships — keep them at their latest server position until
        // the reconciler bootstraps so they don't drift before the first reconcile.
        // Phase 5c: swarm entities (asteroids, drones) are not in predWorld;
        // they live render-only in mirror.swarm and lerp between binary
        // swarm packets server-authoritatively.
        for (const [remoteId, state] of Object.entries(snap.states)) {
          if (remoteId === localId) continue;
          if (this.predWorld.hasShip(remoteId)) this.predWorld.setShipState(remoteId, state);
        }
      }
      return;
    }

    const serverState = snap.states[localId];
    const ackedTick = snap.ackedTicks[localId];
    if (serverState && ackedTick !== undefined) {
      this.stats.lastAckedTick = ackedTick;
      this.stats.ticksAhead = this.inputTick - ackedTick;

      // Reset remote ships to serverTick state BEFORE reconcile.
      const preResetRemotePos = new Map<string, { x: number; y: number }>();
      for (const [remoteId, state] of Object.entries(snap.states)) {
        if (remoteId === localId) continue;
        if (!this.predWorld?.hasShip(remoteId)) continue;
        const current = this.predWorld.getShipState(remoteId);
        if (current) preResetRemotePos.set(remoteId, { x: current.x, y: current.y });
        this.predWorld.setShipState(remoteId, state);
      }

      this.lastSnapshotPos = { x: serverState.x, y: serverState.y };
      this.reconciler.reconcile(serverState, snap.serverTick, this.inputTick, ackedTick);

      // Compute remote ship lerp offsets.
      if (this.predWorld) {
        for (const [remoteId, preReset] of preResetRemotePos) {
          const postReconcile = this.predWorld.getShipState(remoteId);
          if (!postReconcile) continue;
          const ox = preReset.x - postReconcile.x;
          const oy = preReset.y - postReconcile.y;
          const dist = Math.hypot(ox, oy);
          if (dist > 1) {
            const frames = lerpFramesForDrift(dist);
            this._remoteShipOffsets.set(remoteId, { ox, oy, framesLeft: frames, totalFrames: frames });
          }
        }
      }

      const drift = this.reconciler.lastDrift;
      const angleDrift = this.reconciler.lastAngleDrift;
      this.stats.rttMs = Math.round(this.reconciler.lastRtt);
      this.stats.driftUnits = drift;
      this.stats.angleDriftRad = angleDrift;
      this.stats.lerping = this.reconciler.isLerping;
      this.stats.totalDriftUnits += drift;
      this.stats.totalAngleDriftRad += angleDrift;
      if (drift > this.stats.maxDriftUnits) this.stats.maxDriftUnits = drift;
      if (angleDrift > this.stats.maxAngleDriftRad) this.stats.maxAngleDriftRad = angleDrift;

      const posCorrection = drift > NOISE_THRESHOLD;
      const angCorrection = angleDrift > ANGLE_NOISE_THRESHOLD;
      if (posCorrection) {
        this.stats.significantCorrectionCount++;
      }
      if (angCorrection) {
        this.stats.significantAngleCorrectionCount++;
      }

      // Rolling correction rate over the last 10 snapshots.
      this._recentCorrFlags.push(posCorrection || angCorrection ? 1 : 0);
      if (this._recentCorrFlags.length > 10) this._recentCorrFlags.shift();
      this.stats.rollingCorrRate = this._recentCorrFlags.length > 0
        ? this._recentCorrFlags.reduce((a, b) => a + b, 0) / this._recentCorrFlags.length
        : 0;
      const rec = this.reconciler;
      const px = (n: number): number => parseFloat(n.toFixed(3));
      const recPositions = {
        serverX: px(rec.lastServerState.x), serverY: px(rec.lastServerState.y),
        beforeX: px(rec.lastBeforePos.x),   beforeY: px(rec.lastBeforePos.y),
        afterX:  px(rec.lastAfterPos.x),    afterY:  px(rec.lastAfterPos.y),
      };

      if (posCorrection || angCorrection) {
        logEvent('correction', {
          n: this.stats.significantCorrectionCount,
          nAngle: this.stats.significantAngleCorrectionCount,
          serverTick: snap.serverTick,
          ackedTick,
          ticksAhead: this.stats.ticksAhead,
          driftUnits: parseFloat(drift.toFixed(6)),
          angleDriftRad: parseFloat(angleDrift.toFixed(6)),
          lerping: this.reconciler.isLerping,
          ...recPositions,
        });
      }

      logEvent('snapshot', {
        n: this.stats.snapshotCount,
        serverTick: snap.serverTick,
        ackedTick,
        ticksAhead: this.stats.ticksAhead,
        intervalMs: parseFloat(intervalMs.toFixed(1)),
        rttMs: this.stats.rttMs,
        driftUnits: parseFloat(drift.toFixed(6)),
        angleDriftRad: parseFloat(angleDrift.toFixed(6)),
        maxDriftUnits: parseFloat(this.stats.maxDriftUnits.toFixed(6)),
        maxAngleDriftRad: parseFloat(this.stats.maxAngleDriftRad.toFixed(6)),
        corrections: this.stats.significantCorrectionCount,
        angleCorrections: this.stats.significantAngleCorrectionCount,
        lerping: this.reconciler.isLerping,
        ...recPositions,
      });

      useUIStore.getState().setDevData({
        rtt: this.stats.rttMs,
        drift: drift,
        angleDrift: angleDrift,
        lerping: this.reconciler.isLerping,
        snapshotIntervalMs: intervalMs,
        ticksAhead: this.stats.ticksAhead,
        snapshotCount: this.stats.snapshotCount,
        significantCorrectionCount: this.stats.significantCorrectionCount,
        significantAngleCorrectionCount: this.stats.significantAngleCorrectionCount,
        maxDriftUnits: this.stats.maxDriftUnits,
        maxAngleDriftRad: this.stats.maxAngleDriftRad,
        ackedTick: ackedTick,
        inputTick: this.inputTick,
        serverTick: snap.serverTick,
        serverX: this.reconciler.lastServerState.x,
        serverY: this.reconciler.lastServerState.y,
        beforeX: this.reconciler.lastBeforePos.x,
        beforeY: this.reconciler.lastBeforePos.y,
        afterX: this.reconciler.lastAfterPos.x,
        afterY: this.reconciler.lastAfterPos.y,
      });
    }
  }

  /**
   * Sync swarm entries into the prediction world. Called after every binary
   * `swarm` packet decode. New entries spawn predWorld bodies (so the local
   * ship can collide with them and the local hitscan can target them);
   * existing entries get setShipState; entries that vanish from the mirror
   * get despawned. The predWorld key is `swarm-${entityId}`, matching the
   * sprite key in PixiRenderer and the `targetId` the server emits in
   * `laser_fired` for swarm hits.
   */
  private syncSwarmIntoPredWorld(): void {
    if (!this.predWorld || !this.mirror.swarm) return;
    const seen = new Set<string>();
    for (const [entityId, entry] of this.mirror.swarm) {
      const key = `swarm-${entityId}`;
      seen.add(key);
      if (!this.predWorld.hasShip(key)) {
        this.predWorld.spawnObstacle(key, entry.x, entry.y, entry.radius, 3);
        // 5c-stabilise bonus: swarm bodies are collision-only on the client.
        // Locking translations/rotations means reconciler replay (which calls
        // world.step()) won't drift them; the binary swarm packet is the
        // single source of truth for pose.
        this.predWorld.lockBody(key);
        this.predSwarmKeys.add(key);
      }
      this.predWorld.setShipState(key, {
        x: entry.x, y: entry.y, vx: entry.vx, vy: entry.vy, angle: entry.angle,
      });
    }
    // Sweep predWorld bodies whose entityId no longer appears in mirror.swarm.
    for (const key of this.predSwarmKeys) {
      if (!seen.has(key)) {
        this.predWorld.despawnShip(key);
        this.predSwarmKeys.delete(key);
      }
    }
  }

  /** Sync authoritative projectile positions from Colyseus schema state. */
  private syncProjectiles(projectiles: Map<string, unknown> | undefined): void {
    if (!projectiles || !this.mirror.projectiles) return;
    const seen = new Set<string>();
    for (const [projId, raw] of projectiles.entries()) {
      const p = raw as Record<string, unknown>;
      if (p['destroyed']) continue;
      seen.add(projId);
      this.mirror.projectiles.set(projId, {
        x: Number(p['x'] ?? 0),
        y: Number(p['y'] ?? 0),
        vx: Number(p['vx'] ?? 0),
        vy: Number(p['vy'] ?? 0),
        ownerId: String(p['ownerId'] ?? ''),
        isGhost: false,
      } satisfies ProjectileRenderState);
    }
    for (const id of this.mirror.projectiles.keys()) {
      if (!seen.has(id)) this.mirror.projectiles.delete(id);
    }
  }

  // ── State mirror ────────────────────────────────────────────────────────

  private syncMirror(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const s = state as Record<string, unknown>;
    const ships = s['ships'] as Map<string, unknown> | undefined;
    const projectiles = s['projectiles'] as Map<string, unknown> | undefined;
    this.syncProjectiles(projectiles);
    if (!ships) return;

    const localId = this.mirror.localPlayerId;
    const now = performance.now();
    const seen = new Set<string>();

    for (const [playerId, ship] of ships.entries()) {
      const sh = ship as Record<string, unknown>;
      // Skip all dead ships — killEntity handles immediate cleanup when the destroy
      // event arrives; this guard is a defensive fallback for the case where the
      // state patch arrives before the destroy message.
      const alive = (sh['alive'] as boolean | undefined) !== false;
      if (!alive) continue;

      const parsed: ShipPhysicsState = {
        x: Number(sh['x'] ?? 0),
        y: Number(sh['y'] ?? 0),
        angle: Number(sh['angle'] ?? 0),
        vx: Number(sh['vx'] ?? 0),
        vy: Number(sh['vy'] ?? 0),
        angvel: sh['angvel'] !== undefined ? Number(sh['angvel']) : undefined,
      };
      seen.add(playerId);

      if (playerId !== localId) {
        // Store timestamped entry for spawn-detection fallback.
        const hist = this.remoteHistory.get(playerId) ?? [];
        hist.push({ ts: now, state: parsed });
        if (hist.length > HISTORY_MAX) hist.shift();
        this.remoteHistory.set(playerId, hist);
        this.mirror.ships.set(playerId, parsed);

        // Guard: only spawn if we know who the local player is.
        if (this.predWorld && !this.predWorld.hasShip(playerId) && localId !== null) {
          this.predWorld.spawnShip(playerId, parsed.x, parsed.y);
          this.predWorld.setShipState(playerId, parsed);
          this.predRemoteShipIds.add(playerId);
        }
      } else if (!this.predWorld?.hasShip(playerId)) {
        this.mirror.ships.set(playerId, parsed);
        this.tryInitPredWorld(playerId);
      }
    }

    // Remove departed ships.
    for (const key of this.mirror.ships.keys()) {
      if (!seen.has(key)) {
        this.mirror.ships.delete(key);
        this.remoteHistory.delete(key);
        if (this.predRemoteShipIds.has(key)) {
          this.predWorld?.despawnShip(key);
          this.predRemoteShipIds.delete(key);
          this._remoteShipOffsets.delete(key);
        }
      }
    }

    useUIStore.getState().setShipCount(this.mirror.ships.size);
  }

  /**
   * Called once per render frame by App.tsx before renderer.update().
   */
  updateMirror(): void {
    const localId = this.mirror.localPlayerId;

    // Local ship — prediction + lerp correction.
    if (localId && this.predWorld && this.reconciler) {
      const state = this.predWorld.getShipState(localId);
      if (state) {
        const ox = this.reconciler.lerpOffset.x;
        const oy = this.reconciler.lerpOffset.y;
        const oa = this.reconciler.lerpAngleOffset;
        this.reconciler.advanceLerp();
        this.mirror.ships.set(localId, {
          x: state.x + ox,
          y: state.y + oy,
          vx: state.vx,
          vy: state.vy,
          angle: state.angle + oa,
        });
      }
    }

    // Server ghost position — orange diamond drawn at the raw snapshot coords.
    this.mirror.serverGhostPos = this.lastSnapshotPos;
    // Snapshot the user's debug visibility preference into the mirror once per
    // frame so the Pixi renderer never reaches into the Zustand subscription
    // path (per src/client/CLAUDE.md Zustand-purity rule).
    this.mirror.showServerGhost = useUIStore.getState().showServerGhost;

    // Phase 5c: swarm entities (asteroids, drones) live in mirror.swarm,
    // populated by `decodeSwarmPacket` on every binary 'swarm' message. They
    // have no client prediction — server-authoritative @ 60 Hz lerped between
    // received frames. The renderer reads mirror.swarm directly each frame.

    // Remote ships — read from predWorld at 60 Hz with decaying lerp offsets.
    if (this.predWorld) {
      for (const remoteId of this.predRemoteShipIds) {
        if (remoteId === localId) continue;
        const s = this.predWorld.getShipState(remoteId);
        if (!s) continue;
        const off = this._remoteShipOffsets.get(remoteId);
        let ox = 0, oy = 0;
        if (off && off.framesLeft > 0) {
          const ratio = off.framesLeft / off.totalFrames;
          ox = off.ox * ratio;
          oy = off.oy * ratio;
          off.framesLeft--;
          if (off.framesLeft === 0) this._remoteShipOffsets.delete(remoteId);
        }
        this.mirror.ships.set(remoteId, { ...s, x: s.x + ox, y: s.y + oy });
      }
    }

    // Ghost projectiles — advance and write to mirror.projectiles.
    if (this.mirror.projectiles) {
      this.ghostManager.update(this.lastFrameMs, this.mirror.projectiles);
    }

    // Damage flash — advance counters, populate mirror.damagedShips.
    this.mirror.damagedShips?.clear();
    for (const [id, frames] of this._damageFlashFrames) {
      if (frames <= 0) {
        this._damageFlashFrames.delete(id);
      } else {
        this.mirror.damagedShips?.add(id);
        this._damageFlashFrames.set(id, frames - 1);
      }
    }

    // explodingShips is cleared in App.tsx AFTER renderer.update() so the renderer
    // actually sees the set on the frame it was populated.

    // Expire remote lasers past their TTL.
    if (this.mirror.remoteLasers && this.mirror.remoteLasers.size > 0) {
      const now = performance.now();
      for (const [id, laser] of this.mirror.remoteLasers) {
        if (laser.expiresAt <= now) this.mirror.remoteLasers.delete(id);
      }
    }
  }

  // ── Input loop (server-tick-anchored, driven by rAF in App.tsx) ───────

  /**
   * Called once per rAF frame. Catches `inputTick` up to the server-tick-
   * derived target (re-anchored on every snapshot), at most
   * `MAX_CATCH_UP_TICKS` per frame.
   *
   * Why we anchor on the latest `serverTick` instead of the welcome time:
   * if the server falls below 60 Hz (over-budget AI tick, swarm physics, etc.)
   * a wall-clock-from-welcome anchor advances `inputTick` at 60 Hz regardless,
   * leaving it tens of ticks ahead of the server within a few seconds. The
   * reconciler then replays a huge input window every snapshot and `corr`
   * climbs to 30-60% (May 2026 mobile capture: server measured at 46.3 Hz).
   *
   * Anchoring on the snapshot's server tick + half-RTT lead means a slow
   * server drags the client's tick advance down with it, keeping the replay
   * window small. `MAX_CATCH_UP_TICKS = 4` per RAF still bounds CPU after a
   * long background-tab pause.
   */
  tickPhysics(elapsedMs: number): void {
    if (!this.room || !this.keyboard) return;
    this.lastFrameMs = elapsedMs;
    if (this.welcomePerfNow === 0) return; // welcome not yet received
    const FIXED_MS = 1000 / 60;
    const MAX_CATCH_UP_TICKS = 4;
    const ticksSinceAnchor = Math.floor((performance.now() - this.clockAnchorPerfNow) / FIXED_MS);
    const targetTick = this.clockAnchorServerTick + ticksSinceAnchor + this.leadTicks;
    const tickDeficitBefore = targetTick - this.inputTick;
    let stepsThisFrame = 0;
    while (this.inputTick < targetTick && stepsThisFrame < MAX_CATCH_UP_TICKS) {
      stepsThisFrame++;
      const kb = this.keyboard.read();
      let tcThrust = false, tcTurnLeft = false, tcTurnRight = false, tcFire = false;
      if (this.touchInput) {
        tcFire = this.touchInput.getFireHeld();
        const v = this.touchInput.getJoystickVector();
        const localId = this.mirror.localPlayerId;
        const localShip = localId ? this.mirror.ships.get(localId) : null;
        if (v && localShip) {
          const mag = Math.hypot(v.x, v.y);
          if (mag > TOUCH_DEADZONE) {
            // Physics: ship at angle θ has forward = (-sin θ, cos θ) in world coords.
            // Renderer: sprite.y = -ship.y (world +Y → screen UP).
            // nipplejs: vector.y is already inverted from screen y, so stick UP → v.y > 0.
            // Mapping: stick UP (v=(0,1)) → forward=(0,1) → θ=0;
            //          stick RIGHT (v=(1,0)) → forward=(1,0) → θ=-π/2.
            const targetAngle = Math.atan2(-v.x, v.y);
            let delta = targetAngle - localShip.angle;
            // Wrap to [-π, π] so the ship turns the short way around.
            while (delta >  Math.PI) delta -= 2 * Math.PI;
            while (delta < -Math.PI) delta += 2 * Math.PI;
            // World.applyInput: turnLeft → +angvel (CCW, increasing angle).
            if (delta >  TOUCH_TURN_TOLERANCE) tcTurnLeft  = true;
            else if (delta < -TOUCH_TURN_TOLERANCE) tcTurnRight = true;
            // Thrust only when stick is pushed firmly AND ship roughly faces target.
            if (Math.abs(delta) < TOUCH_THRUST_CONE && mag > TOUCH_THRUST_MAG) {
              tcThrust = true;
            }
          }
        }
      }
      const thrust    = kb.thrust    || tcThrust;
      const turnLeft  = kb.turnLeft  || tcTurnLeft;
      const turnRight = kb.turnRight || tcTurnRight;
      const fireHeld  = kb.fireHeld  || tcFire;
      const boost     = kb.boost; // shift — keyboard-only, no touch button yet
      const tick = this.inputTick++;
      if (!this.localDead && this.predWorld && this.reconciler && this.mirror.localPlayerId) {
        const rec: InputRecord = { tick, thrust, turnLeft, turnRight, boost, sentAt: performance.now() };
        this.predWorld.applyInput(this.mirror.localPlayerId, { thrust, turnLeft, turnRight, boost });
        this.reconciler.recordInput(rec);
        this.room.send('input', { type: 'input', tick, thrust, turnLeft, turnRight, boost });
        // Show the local exhaust trail without waiting an RTT for the server
        // to confirm — the next snapshot will overwrite from server truth.
        if (this.mirror.boostingShips) {
          if (boost && thrust) this.mirror.boostingShips.add(this.mirror.localPlayerId);
          else this.mirror.boostingShips.delete(this.mirror.localPlayerId);
        }
        // Log only state-change-relevant inputs to avoid saturating the buffer:
        // every input where any control bit is on (carrying meaningful action),
        // plus a sparse heartbeat every 60th tick of all-idle.
        if (thrust || turnLeft || turnRight || boost || (tick % 60) === 0) {
          logEvent('inputSent', { tick, thrust, turnLeft, turnRight, boost });
        }
      }
      // Always advance physics — remote ships and obstacles must keep moving even while dead.
      if (this.predWorld) {
        this.predWorld.tick(1 / 60);
      }

      if (fireHeld && this.mirror.localPlayerId && !this.localDead) {
        this.updateLiveBeam();
        if (tick - this.lastFiredAtTick >= WEAPON_COOLDOWN_TICKS) {
          this.sendFire(tick);
          this.lastFiredAtTick = tick;
        }
      } else {
        this.mirror.liveBeam = null;
      }
    }

    // One ring-buffer entry per RAF — diagnostic data for capture analysis.
    // Sampled to keep buffer-friendly: every 6th RAF, plus any frame whose
    // catch-up window was non-trivial (≥ 2 ticks deficit). One log line per
    // frame would saturate the 500-entry buffer in ~10 s.
    const anomalous = tickDeficitBefore >= 2;
    if (anomalous || (this.inputTick & 0b11) === 0) {
      logEvent('rafTick', {
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        targetTick,
        inputTick: this.inputTick,
        deficitBefore: tickDeficitBefore,
        stepsThisFrame,
        capped: stepsThisFrame >= MAX_CATCH_UP_TICKS && this.inputTick < targetTick,
        anchorServerTick: this.clockAnchorServerTick,
        leadTicks: this.leadTicks,
      });
    }
  }

  /**
   * Stores the hit distance for the live hitscan beam. The renderer reads the
   * shooter's current pose from `mirror.ships[localId]` (which already includes
   * any active reconciler lerp offsets) and projects forward by `dist` — so the
   * beam stays glued to the ship sprite frame-by-frame even during corrections.
   * The hitscan query itself runs against raw predWorld state, which is what
   * the server's lag-comp will validate against.
   */
  private updateLiveBeam(): void {
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.predWorld) return;
    const state = this.predWorld.getShipState(localId);
    if (!state) return;
    const fwdX = -Math.sin(state.angle);
    const fwdY = Math.cos(state.angle);
    const fromX = state.x + fwdX * 20;
    const fromY = state.y + fwdY * 20;
    const hit = this.predWorld.hitscan(fromX, fromY, fwdX, fwdY, HITSCAN_RANGE, localId);
    this.mirror.liveBeam = {
      dist: hit ? hit.dist : HITSCAN_RANGE,
      hitId: hit?.hitId,
    };
  }

  private sendFire(tick: number): void {
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.predWorld || !this.room) return;
    // Always compute the fire ray from RAW prediction state — the server's
    // lag-comp plausibility check validates against unlerped trajectories.
    const state = this.predWorld.getShipState(localId);
    if (!state) return;
    const fwdX = -Math.sin(state.angle);
    const fwdY = Math.cos(state.angle);
    const fromX = state.x + fwdX * 20;
    const fromY = state.y + fwdY * 20;
    this.room.send('fire', {
      type: 'fire',
      tick,
      clientShotId: nextShotId(),
      weapon: 'hitscan',
      rayFromX: fromX,
      rayFromY: fromY,
      rayDirX: fwdX,
      rayDirY: fwdY,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.localDead = false;
    useUIStore.getState().setDead(false);
    this.keyboard = null;
    this.touchInput = null;
    this.room?.leave();
    this.room = null;
    this.predWorld?.dispose();
    this.predWorld = null;
    this.reconciler = null;
    this.remoteHistory.clear();
    this.predRemoteShipIds.clear();
    this._remoteShipOffsets.clear();
    this.predSwarmKeys.clear();
    this.mirror.swarm?.clear();
    this.mirror.projectiles?.clear();
    this.mirror.remoteLasers?.clear();
  }
}
