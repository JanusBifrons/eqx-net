import { Client, Room } from 'colyseus.js';
import type { RenderMirror, ObstacleRenderState, ProjectileRenderState } from '@core/contracts/IRenderer';
import type { WelcomeMessage, SnapshotMessage, HitAckMessage, DamageEvent, DestroyEvent } from '@shared-types/messages';
import { PhysicsWorld, type ShipPhysicsState } from '@core/physics/World';
import { Reconciler, type InputRecord } from '@core/prediction/Reconciler';
import { useUIStore, type ConnectionStatus } from '../state/store';
import { logEvent } from '../debug/ClientLogger';
import { GhostManager } from '../combat/GhostProjectile';
import { HITSCAN_RANGE, WEAPON_COOLDOWN_TICKS } from '@core/combat/Weapons';

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

/** Position drift below this is float32-serialisation noise. */
const NOISE_THRESHOLD = 0.05;
/** Angle drift below this is float32-serialisation noise (~0.057°). */
const ANGLE_NOISE_THRESHOLD = 0.001;

/** Scale obstacle lerp duration to correction magnitude. */
function lerpFramesForObstacleDrift(drift: number): number {
  if (drift < 3.0)  return 6;   // 100 ms
  if (drift < 10.0) return 10;  // 167 ms
  return 14;                    // 233 ms — large post-collision snap
}

/** Simple monotonically incrementing shot ID generator. */
let _shotCounter = 0;
function nextShotId(): string {
  return `shot-${_shotCounter++}`;
}

export class ColyseusGameClient {
  readonly mirror: RenderMirror = {
    ships: new Map(),
    obstacles: new Map(),
    projectiles: new Map(),
    localPlayerId: null,
    damagedShips: new Set(),
    explodingShips: new Set(),
  };

  /** Radii of obstacles we've spawned in the prediction world, keyed by id. */
  private predObstacleRadii = new Map<string, number>();

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
  private disposed = false;

  // Fixed-timestep accumulator for the input loop (driven by rAF in App.tsx).
  private keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean; fireHeld: boolean } } | null = null;
  private lastFiredAtTick = -999;
  private accumulator = 0;
  /** Elapsed ms of the last frame — used by updateMirror() for ghost advancement. */
  private lastFrameMs = 1000 / 60;

  // Prediction
  private predWorld: PhysicsWorld | null = null;
  private reconciler: Reconciler | null = null;

  // Snapshot timing
  private lastSnapshotAt = 0;
  // Rolling buffers for jitter and correction-rate metrics (last 10 snapshots).
  private readonly _recentIntervals: number[] = [];
  private readonly _recentCorrFlags: number[] = [];

  // Per-obstacle render lerp offsets — applied in updateMirror() to smooth corrections.
  private readonly _obstacleOffsets = new Map<string, { ox: number; oy: number; framesLeft: number; totalFrames: number }>();

  // Remote ship interpolation: per-player timestamped history
  private remoteHistory = new Map<string, RemoteEntry[]>();

  // Combat
  private readonly ghostManager = new GhostManager();
  /** Damage flash: set of player IDs currently flashing red (cleared after one frame). */
  private readonly _damageFlashFrames = new Map<string, number>();

  async connect(
    wsUrl: string,
    storedPlayerId: string | null,
    keyboard: { read: () => { thrust: boolean; turnLeft: boolean; turnRight: boolean; fireHeld: boolean } },
    callbacks: ColyseusClientCallbacks,
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
      const joinPromise = client.joinOrCreate<unknown>('sector', { playerId: storedPlayerId });
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

    this.room.onMessage('welcome', (msg: WelcomeMessage) => {
      const idChanged = storedPlayerId && msg.playerId !== storedPlayerId;
      console.log(
        '[ColyseusClient] welcome received, playerId:', msg.playerId,
        idChanged ? '(server reassigned — collision guard)' : '',
        'serverTick:', msg.serverTick,
      );
      this.serverTickAtWelcome = msg.serverTick;
      this.inputTick = msg.serverTick; // Sync to server tick space so fire messages pass temporal plausibility check.
      logEvent('welcome', { playerId: msg.playerId, serverTick: msg.serverTick, idReassigned: !!idChanged });
      this.mirror.localPlayerId = msg.playerId;
      callbacks.onPlayerId(msg.playerId);
      // If state already arrived, bootstrap the prediction world now.
      this.tryInitPredWorld(msg.playerId);
    });

    this.room.onMessage('snapshot', (snap: SnapshotMessage) => {
      this.handleSnapshot(snap);
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

    this.room.onStateChange((state: unknown) => {
      this.syncMirror(state);
    });

    this.room.onLeave((code) => {
      console.warn('[ColyseusClient] left room, code:', code);
      logEvent('disconnected', { code });
      callbacks.onConnectionStatus('disconnected');
      this.keyboard = null;
    });

    this.room.onError((code, message) => {
      console.error('[ColyseusClient] room error', code, message);
      logEvent('room_error', { code, message });
      callbacks.onConnectionStatus('error');
    });

    callbacks.onConnectionStatus('connected');
    console.log('[ColyseusClient] connected — input loop driven by rAF');
    this.keyboard = keyboard;
  }

  // ── Combat event handlers ────────────────────────────────────────────────

  private handleDamage(evt: DamageEvent): void {
    const localId = this.mirror.localPlayerId;
    if (evt.targetId === localId) {
      const pct = Math.round((evt.newHealth / 100) * 100);
      useUIStore.getState().setHullPct(pct);
    }
    // Flash the damaged ship for 6 frames.
    this._damageFlashFrames.set(evt.targetId, 6);
  }

  private handleDestroy(evt: DestroyEvent): void {
    this.mirror.explodingShips?.add(evt.targetId);
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
  }

  // ── Snapshot / reconciliation ───────────────────────────────────────────

  private handleSnapshot(snap: SnapshotMessage): void {
    const localId = this.mirror.localPlayerId;
    const now = performance.now();

    // Update snapshot timing stats regardless of prediction state.
    const intervalMs = this.lastSnapshotAt > 0 ? now - this.lastSnapshotAt : 0;
    this.lastSnapshotAt = now;
    this.stats.snapshotCount++;
    this.stats.snapshotIntervalMs = intervalMs;
    this.stats.lastServerTick = snap.serverTick;

    // Rolling jitter: max − min of the last 10 snapshot intervals.
    if (intervalMs > 0) {
      this._recentIntervals.push(intervalMs);
      if (this._recentIntervals.length > 10) this._recentIntervals.shift();
    }
    this.stats.snapshotJitterMs = this._recentIntervals.length >= 2
      ? Math.max(...this._recentIntervals) - Math.min(...this._recentIntervals)
      : 0;

    if (!localId || !this.reconciler) {
      if (this.predWorld) {
        // Sync obstacles.
        if (snap.obstacles) {
          for (const [id, state] of Object.entries(snap.obstacles)) {
            if (this.predWorld.hasShip(id)) this.predWorld.setShipState(id, state);
          }
        }
        // Sync remote ships — keep them at their latest server position until
        // the reconciler bootstraps so they don't drift before the first reconcile.
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

      // Reset obstacles to serverTick state BEFORE reconcile.
      const preResetObstaclePos = new Map<string, { x: number; y: number }>();
      if (this.predWorld && snap.obstacles) {
        for (const [id, state] of Object.entries(snap.obstacles)) {
          if (!this.predWorld.hasShip(id)) continue;
          const current = this.predWorld.getShipState(id);
          if (current) preResetObstaclePos.set(id, { x: current.x, y: current.y });
          this.predWorld.setShipState(id, {
            x: state.x, y: state.y, vx: state.vx, vy: state.vy, angle: state.angle,
          });
        }
      }

      this.lastSnapshotPos = { x: serverState.x, y: serverState.y };
      this.reconciler.reconcile(serverState, snap.serverTick, this.inputTick, ackedTick);

      // Compute obstacle lerp offsets.
      if (this.predWorld && snap.obstacles) {
        for (const [id] of Object.entries(snap.obstacles)) {
          const preReset = preResetObstaclePos.get(id);
          if (!preReset) continue;
          const postReconcile = this.predWorld.getShipState(id);
          if (!postReconcile) continue;
          const ox = preReset.x - postReconcile.x;
          const oy = preReset.y - postReconcile.y;
          const dist = Math.hypot(ox, oy);
          if (dist > 1) {
            const frames = lerpFramesForObstacleDrift(dist);
            this._obstacleOffsets.set(id, { ox, oy, framesLeft: frames, totalFrames: frames });
          }
        }
      }

      // Compute remote ship lerp offsets.
      if (this.predWorld) {
        for (const [remoteId, preReset] of preResetRemotePos) {
          const postReconcile = this.predWorld.getShipState(remoteId);
          if (!postReconcile) continue;
          const ox = preReset.x - postReconcile.x;
          const oy = preReset.y - postReconcile.y;
          const dist = Math.hypot(ox, oy);
          if (dist > 1) {
            const frames = lerpFramesForObstacleDrift(dist);
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
   * Bootstrap any obstacles we haven't seen yet into the prediction world and
   * publish their current state to the render mirror.
   */
  private syncObstacles(obstacles: Map<string, unknown> | undefined): void {
    if (!obstacles) return;
    const mirrorObstacles = this.mirror.obstacles!;
    const seen = new Set<string>();

    for (const [id, raw] of obstacles.entries()) {
      seen.add(id);
      const o = raw as Record<string, unknown>;
      const state: ShipPhysicsState = {
        x: Number(o['x'] ?? 0),
        y: Number(o['y'] ?? 0),
        angle: Number(o['angle'] ?? 0),
        vx: Number(o['vx'] ?? 0),
        vy: Number(o['vy'] ?? 0),
      };
      const radius = Number(o['radius'] ?? 24);

      if (this.predWorld && !this.predWorld.hasShip(id)) {
        this.predWorld.spawnObstacle(id, state.x, state.y, radius, 3);
        this.predWorld.setShipState(id, state);
        this.predObstacleRadii.set(id, radius);
      }

      const entry: ObstacleRenderState = { ...state, radius };
      mirrorObstacles.set(id, entry);
    }

    for (const id of mirrorObstacles.keys()) {
      if (!seen.has(id)) {
        mirrorObstacles.delete(id);
        this.predWorld?.despawnShip(id);
        this.predObstacleRadii.delete(id);
        this._obstacleOffsets.delete(id);
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
    const obstacles = s['obstacles'] as Map<string, unknown> | undefined;
    const projectiles = s['projectiles'] as Map<string, unknown> | undefined;
    this.syncObstacles(obstacles);
    this.syncProjectiles(projectiles);
    if (!ships) return;

    const localId = this.mirror.localPlayerId;
    const now = performance.now();
    const seen = new Set<string>();

    for (const [playerId, ship] of ships.entries()) {
      const sh = ship as Record<string, unknown>;
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

    // Obstacles — read from prediction world at 60 Hz with decaying lerp offsets.
    if (this.predWorld && this.mirror.obstacles) {
      for (const [id, radius] of this.predObstacleRadii) {
        const s = this.predWorld.getShipState(id);
        if (!s) continue;
        const off = this._obstacleOffsets.get(id);
        let ox = 0, oy = 0;
        if (off && off.framesLeft > 0) {
          const ratio = off.framesLeft / off.totalFrames;
          ox = off.ox * ratio;
          oy = off.oy * ratio;
          off.framesLeft--;
          if (off.framesLeft === 0) this._obstacleOffsets.delete(id);
        }
        this.mirror.obstacles.set(id, { ...s, x: s.x + ox, y: s.y + oy, radius });
      }
    }

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

    // Exploding ships are a one-frame trigger — clear after renderer sees them.
    this.mirror.explodingShips?.clear();
  }

  // ── Input loop (fixed-timestep, driven by rAF in App.tsx) ─────────────

  /**
   * Called once per rAF frame. Steps the input loop by however many 1/60-s
   * ticks fit in the elapsed time.
   */
  tickPhysics(elapsedMs: number): void {
    if (!this.room || !this.keyboard) return;
    this.lastFrameMs = elapsedMs;
    const FIXED_MS = 1000 / 60;
    // Cap to 5 ticks to avoid spiral-of-death after long frames or background tabs.
    this.accumulator += Math.min(elapsedMs, FIXED_MS * 5);
    while (this.accumulator >= FIXED_MS) {
      this.accumulator -= FIXED_MS;
      const { thrust, turnLeft, turnRight, fireHeld } = this.keyboard.read();
      const tick = this.inputTick++;
      if (this.predWorld && this.reconciler && this.mirror.localPlayerId) {
        const rec: InputRecord = { tick, thrust, turnLeft, turnRight, sentAt: performance.now() };
        this.predWorld.applyInput(this.mirror.localPlayerId, { thrust, turnLeft, turnRight });
        this.predWorld.tick(1 / 60);
        this.reconciler.recordInput(rec);
      }
      this.room.send('input', { type: 'input', tick, thrust, turnLeft, turnRight });

      if (fireHeld && this.mirror.localPlayerId) {
        this.updateLiveBeam();
        if (tick - this.lastFiredAtTick >= WEAPON_COOLDOWN_TICKS) {
          this.sendFire(tick);
          this.lastFiredAtTick = tick;
        }
      } else {
        this.mirror.liveBeam = null;
      }
    }
  }

  /** Recomputes mirror.liveBeam from current predWorld ship state + client-side hitscan. */
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
      fromX,
      fromY,
      toX: hit ? fromX + fwdX * hit.dist : fromX + fwdX * HITSCAN_RANGE,
      toY: hit ? fromY + fwdY * hit.dist : fromY + fwdY * HITSCAN_RANGE,
      hitId: hit?.hitId,
    };
  }

  private sendFire(tick: number): void {
    const localId = this.mirror.localPlayerId;
    if (!localId || !this.predWorld || !this.room) return;
    const beam = this.mirror.liveBeam;
    if (!beam) return;
    const fwdX = -Math.sin(this.predWorld.getShipState(localId)?.angle ?? 0);
    const fwdY = Math.cos(this.predWorld.getShipState(localId)?.angle ?? 0);
    this.room.send('fire', {
      type: 'fire',
      tick,
      clientShotId: nextShotId(),
      weapon: 'hitscan',
      rayFromX: beam.fromX,
      rayFromY: beam.fromY,
      rayDirX: fwdX,
      rayDirY: fwdY,
    });
  }

  dispose(): void {
    this.disposed = true;
    this.keyboard = null;
    this.room?.leave();
    this.room = null;
    this.predWorld?.dispose();
    this.predWorld = null;
    this.reconciler = null;
    this.remoteHistory.clear();
    this.predRemoteShipIds.clear();
    this._remoteShipOffsets.clear();
    this.mirror.obstacles?.clear();
    this.mirror.projectiles?.clear();
    this.predObstacleRadii.clear();
  }
}
