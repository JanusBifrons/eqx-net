import { Room, Client } from 'colyseus';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
import { pino } from 'pino';
import { Bus } from '../../core/events/Bus.js';
import { serverLogEvent } from '../debug/ServerEventLog.js';
import { SectorState, ShipState, ObstacleState } from './schema/SectorState.js';
import { assignPlayerId } from '../identity/PlayerIdentity.js';
import { InputMessageSchema } from '../../shared-types/messages.js';
import type { WelcomeMessage, SnapshotMessage } from '../../shared-types/messages.js';
import {
  SEQLOCK_IDX,
  TICK_IDX,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
  SLOT_ANGVEL_OFF,
  SLOT_APPLIED_TICK_OFF,
  slotBase,
  SAB_TOTAL_BYTES,
  MAX_ENTITIES,
} from '../../shared-types/sabLayout.js';

const logger = pino({
  name: 'SectorRoom',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

const WORKER_TS_PATH = fileURLToPath(
  new URL('../../core/physics/worker.ts', import.meta.url),
);

// Bundle worker.ts to a self-contained JS string at startup. tsx's ESM loader
// hook does not reliably rewrite .js/.extensionless imports inside
// worker_threads on Node.js v22+; esbuild bundling sidesteps this entirely.
async function bundleWorker(): Promise<string> {
  const result = await build({
    entryPoints: [WORKER_TS_PATH],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    // Rapier ships a pre-built WASM binary; keep it external so the worker
    // accesses the same copy as the main thread (avoids double-init).
    external: ['@dimforge/rapier2d-compat'],
    sourcemap: 'inline',
  });
  return result.outputFiles[0]!.text;
}

const JoinOptionsSchema = z
  .object({ playerId: z.string().nullable().optional() })
  .passthrough();

const MAX_INPUTS_PER_TICK = 3;

type WorkerCmd =
  | { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number }
  | { type: 'DESPAWN';        slot: number; playerId: string }
  | { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean }
  | { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number };

/** Fixed asteroid roster for the multiplayer diagnostic. Deterministic so both
 *  server and client-side prediction worlds stay in agreement. */
const ASTEROIDS: ReadonlyArray<{ id: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number }> = [
  { id: 'asteroid-0', x:  200, y:    0, vx: 0,   vy: 0,    radius: 32, mass: 5 },
  { id: 'asteroid-1', x: -180, y:  120, vx: 0.3, vy: -0.2, radius: 24, mass: 3 },
  { id: 'asteroid-2', x:   80, y: -220, vx: 0,   vy: 0,    radius: 40, mass: 7 },
];

export class SectorRoom extends Room<SectorState> {
  private physicsWorker!: Worker;
  private sab!: SharedArrayBuffer;
  private sabU32!: Uint32Array;
  private sabF32!: Float32Array;

  // Slot management — maps playerId ↔ integer SAB slot index.
  private playerToSlot = new Map<string, number>();
  private slotToPlayer = new Map<number, string>();
  private freeSlots: number[] = [];

  // Obstacles live in the same SAB slot pool as ships so the worker's state-
  // readout loop treats them uniformly; these maps let update() know which
  // entries feed the ships schema vs. the obstacles schema.
  private obstacleIdToSlot = new Map<string, number>();
  private slotToObstacleId = new Map<number, string>();

  private bus!: Bus;
  private sessionToPlayer = new Map<string, string>();
  private playerToSession = new Map<string, string>();
  private inputCountThisTick = new Map<string, number>();
  /** Last client input tick the physics worker confirmed it applied, read from SAB. */
  private sabAppliedTicks = new Map<string, number>();
  private serverTick = 0;
  private lastBroadcastTick = -1;

  override async onCreate(_options: unknown): Promise<void> {
    this.setState(new SectorState());
    this.bus = new Bus();

    // Fill slot pool (push in reverse so slot 0 is popped first).
    for (let i = MAX_ENTITIES - 1; i >= 0; i--) this.freeSlots.push(i);

    // Shared memory buffer for zero-copy physics state transfer.
    this.sab    = new SharedArrayBuffer(SAB_TOTAL_BYTES);
    this.sabU32 = new Uint32Array(this.sab);
    this.sabF32 = new Float32Array(this.sab);

    await this.spawnWorker();

    // Seed the room with the deterministic asteroid roster. These exist for
    // the lifetime of the room and are never respawned.
    for (const a of ASTEROIDS) {
      const slot = this.freeSlots.pop();
      if (slot === undefined) {
        logger.error({ obstacleId: a.id }, 'no free SAB slots for asteroid');
        break;
      }
      this.obstacleIdToSlot.set(a.id, slot);
      this.slotToObstacleId.set(slot, a.id);

      const base = slotBase(slot);
      this.sabF32[base + SLOT_X_OFF]  = a.x;
      this.sabF32[base + SLOT_Y_OFF]  = a.y;
      this.sabF32[base + SLOT_VX_OFF] = a.vx;
      this.sabF32[base + SLOT_VY_OFF] = a.vy;

      const entry = new ObstacleState();
      entry.obstacleId = a.id;
      entry.x = a.x; entry.y = a.y;
      entry.vx = a.vx; entry.vy = a.vy;
      entry.radius = a.radius;
      this.state.obstacles.set(a.id, entry);

      this.postToWorker({
        type: 'SPAWN_OBSTACLE', slot,
        obstacleId: a.id,
        x: a.x, y: a.y, vx: a.vx, vy: a.vy,
        radius: a.radius, mass: a.mass,
      });
    }

    this.onMessage('input', (client: Client, raw: unknown) => {
      const playerId = this.sessionToPlayer.get(client.sessionId);
      if (!playerId) return;

      const count = this.inputCountThisTick.get(playerId) ?? 0;
      if (count >= MAX_INPUTS_PER_TICK) return;
      this.inputCountThisTick.set(playerId, count + 1);

      const result = InputMessageSchema.safeParse(raw);
      if (!result.success) {
        logger.warn({ sessionId: client.sessionId }, 'malformed input message');
        return;
      }
      const { tick, thrust, turnLeft, turnRight } = result.data;
      const slot = this.playerToSlot.get(playerId);
      if (slot !== undefined) {
        this.postToWorker({ type: 'INPUT', slot, inputTick: tick, thrust, turnLeft, turnRight });
      }
    });

    this.setSimulationInterval(() => this.update(), 1000 / 60);
    logger.info('SectorRoom created');
  }

  // ── Worker lifecycle ────────────────────────────────────────────────────

  private async spawnWorker(): Promise<void> {
    const workerCode = await bundleWorker();
    return new Promise<void>((resolve, reject) => {
      this.physicsWorker = new Worker(workerCode, {
        eval: true,
        workerData: { sab: this.sab },
      });

      let ready = false;

      this.physicsWorker.on('message', (msg: { type: string }) => {
        if (!ready && msg.type === 'READY') {
          ready = true;
          resolve();
        }
      });

      this.physicsWorker.on('error', (err) => {
        logger.error({ err }, 'physics worker error');
        if (!ready) reject(err);
      });

      this.physicsWorker.on('exit', (code) => {
        if (code !== 0) {
          logger.error({ code }, 'physics worker exited unexpectedly');
          if (!ready) reject(new Error(`physics worker exited with code ${code}`));
        }
      });

      setTimeout(() => {
        if (!ready) reject(new Error('physics worker did not become READY within 10 s'));
      }, 10_000);
    });
  }

  private postToWorker(cmd: WorkerCmd): void {
    this.physicsWorker.postMessage(cmd);
  }

  // ── Colyseus room hooks ─────────────────────────────────────────────────

  override onJoin(client: Client, options: unknown): void {
    logger.info({ sessionId: client.sessionId, options }, 'onJoin called');
    const parsed = JoinOptionsSchema.safeParse(options);
    const requestedId = parsed.success ? parsed.data.playerId : null;
    let playerId = assignPlayerId(requestedId);

    // If the requested ID is already held by an active session (e.g. two tabs
    // sharing the same localStorage), assign a fresh UUID.
    if (this.playerToSession.has(playerId)) {
      playerId = assignPlayerId(null);
    }

    this.sessionToPlayer.set(client.sessionId, playerId);
    this.playerToSession.set(playerId, client.sessionId);

    const slot = this.freeSlots.pop();
    if (slot === undefined) {
      logger.error({ playerId }, 'no free SAB slots — room is full');
      client.leave(1001);
      return;
    }
    this.playerToSlot.set(playerId, slot);
    this.slotToPlayer.set(slot, playerId);

    const spawnX = (Math.random() - 0.5) * 400;
    const spawnY = (Math.random() - 0.5) * 400;

    // Pre-populate the SAB slot so the update() loop sees a sane position
    // immediately, before the worker processes the SPAWN command.
    const base = slotBase(slot);
    this.sabF32[base + SLOT_X_OFF] = spawnX;
    this.sabF32[base + SLOT_Y_OFF] = spawnY;

    // Create Colyseus schema entry.
    const ship = new ShipState();
    ship.playerId = playerId;
    ship.x = spawnX;
    ship.y = spawnY;
    this.state.ships.set(playerId, ship);

    this.postToWorker({ type: 'SPAWN', slot, playerId, x: spawnX, y: spawnY });

    const currentServerTick = Atomics.load(this.sabU32, TICK_IDX);
    const welcome: WelcomeMessage = { type: 'welcome', playerId, serverTick: currentServerTick };
    client.send('welcome', welcome);

    this.bus.emit('SHIP_SPAWNED', { type: 'SHIP_SPAWNED' as const, playerId, x: spawnX, y: spawnY });
    serverLogEvent('player_join', { playerId, sessionId: client.sessionId, spawnX, spawnY });
    logger.info({ playerId, sessionId: client.sessionId }, 'player joined');
  }

  override onLeave(client: Client, _consented: boolean): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    this.sessionToPlayer.delete(client.sessionId);
    this.playerToSession.delete(playerId);
    this.sabAppliedTicks.delete(playerId);

    const slot = this.playerToSlot.get(playerId);
    if (slot !== undefined) {
      this.playerToSlot.delete(playerId);
      this.slotToPlayer.delete(slot);
      this.freeSlots.push(slot);
      this.postToWorker({ type: 'DESPAWN', slot, playerId });
    }

    this.state.ships.delete(playerId);
    this.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    serverLogEvent('player_leave', { playerId });
    logger.info({ playerId }, 'player left');
  }

  override onDispose(): void {
    this.physicsWorker?.terminate();
    logger.info('SectorRoom disposed');
  }

  // ── Simulation loop (main thread — reads SAB, updates Colyseus schema) ──

  private update(): void {
    this.inputCountThisTick.clear();
    if (this.playerToSlot.size === 0 && this.obstacleIdToSlot.size === 0) return;

    // Seqlock read: retry if a write is in progress or if data was torn
    // (seqlock changed between the two loads).
    for (;;) {
      const seq1 = Atomics.load(this.sabU32, SEQLOCK_IDX);
      if (seq1 & 1) continue; // odd → write in progress, spin

      for (const [playerId, slot] of this.playerToSlot) {
        const ship = this.state.ships.get(playerId);
        if (!ship) continue;
        const b = slotBase(slot);
        ship.x     = this.sabF32[b + SLOT_X_OFF]!;
        ship.y     = this.sabF32[b + SLOT_Y_OFF]!;
        ship.angle = this.sabF32[b + SLOT_ANGLE_OFF]!;
        ship.vx    = this.sabF32[b + SLOT_VX_OFF]!;
        ship.vy    = this.sabF32[b + SLOT_VY_OFF]!;
        ship.angvel = this.sabF32[b + SLOT_ANGVEL_OFF]!;
        // Decode applied tick: storedValue=0 means no input applied yet (use 0);
        // storedValue=N+1 means client tick N was applied.
        const storedTick = this.sabU32[b + SLOT_APPLIED_TICK_OFF]!;
        this.sabAppliedTicks.set(playerId, storedTick === 0 ? 0 : storedTick - 1);
      }

      for (const [obstacleId, slot] of this.obstacleIdToSlot) {
        const obs = this.state.obstacles.get(obstacleId);
        if (!obs) continue;
        const b = slotBase(slot);
        obs.x     = this.sabF32[b + SLOT_X_OFF]!;
        obs.y     = this.sabF32[b + SLOT_Y_OFF]!;
        obs.angle = this.sabF32[b + SLOT_ANGLE_OFF]!;
        obs.vx    = this.sabF32[b + SLOT_VX_OFF]!;
        obs.vy    = this.sabF32[b + SLOT_VY_OFF]!;
      }

      const seq2 = Atomics.load(this.sabU32, SEQLOCK_IDX);
      if (seq1 === seq2) break; // consistent read
      // seq changed during read → writer modified data, retry
    }

    this.serverTick = Atomics.load(this.sabU32, TICK_IDX);
    this.state.tick = this.serverTick;

    // Broadcast authoritative snapshot every 10 ticks for client-side reconciliation.
    // Guard lastBroadcastTick so we never broadcast the same tick twice when the
    // physics worker is slightly ahead and the SAB read lands on two consecutive
    // multiples of 10 within a single Colyseus simulation-interval window.
    if (this.serverTick > 0 && this.serverTick % 10 === 0 && this.serverTick !== this.lastBroadcastTick) {
      this.lastBroadcastTick = this.serverTick;
      const states: SnapshotMessage['states'] = {};
      const ackedTicks: SnapshotMessage['ackedTicks'] = {};
      for (const [playerId] of this.playerToSlot) {
        const ship = this.state.ships.get(playerId);
        if (ship) {
          states[playerId] = { x: ship.x, y: ship.y, vx: ship.vx, vy: ship.vy, angle: ship.angle, angvel: ship.angvel };
          ackedTicks[playerId] = this.sabAppliedTicks.get(playerId) ?? 0;
        }
      }
      const obstacles: SnapshotMessage['obstacles'] = {};
      for (const [id] of this.obstacleIdToSlot) {
        const o = this.state.obstacles.get(id);
        if (o) obstacles[id] = { x: o.x, y: o.y, vx: o.vx, vy: o.vy, angle: o.angle };
      }
      const snap: SnapshotMessage = { type: 'snapshot', serverTick: this.serverTick, states, ackedTicks, obstacles };
      this.broadcast('snapshot', snap);
      serverLogEvent('snapshot_broadcast', {
        serverTick: this.serverTick,
        playerCount: this.playerToSlot.size,
        ackedTicks,
        states: Object.fromEntries(
          Object.entries(states).map(([id, s]) => [id, { x: parseFloat(s.x.toFixed(3)), y: parseFloat(s.y.toFixed(3)), vx: parseFloat(s.vx.toFixed(3)), vy: parseFloat(s.vy.toFixed(3)) }]),
        ),
      });
    }
  }
}
