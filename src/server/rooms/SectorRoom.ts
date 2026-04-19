import { Room, Client } from 'colyseus';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { z } from 'zod';
import { pino } from 'pino';
import { Bus } from '../../core/events/Bus.js';
import { SectorState, ShipState } from './schema/SectorState.js';
import { assignPlayerId } from '../identity/PlayerIdentity.js';
import { InputMessageSchema } from '../../shared-types/messages.js';
import type { WelcomeMessage } from '../../shared-types/messages.js';
import {
  SEQLOCK_IDX,
  TICK_IDX,
  SLOT_X_OFF,
  SLOT_Y_OFF,
  SLOT_VX_OFF,
  SLOT_VY_OFF,
  SLOT_ANGLE_OFF,
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
  | { type: 'SPAWN';   slot: number; playerId: string; x: number; y: number }
  | { type: 'DESPAWN'; slot: number; playerId: string }
  | { type: 'INPUT';   slot: number; thrust: boolean; turnLeft: boolean; turnRight: boolean };

export class SectorRoom extends Room<SectorState> {
  private physicsWorker!: Worker;
  private sab!: SharedArrayBuffer;
  private sabU32!: Uint32Array;
  private sabF32!: Float32Array;

  // Slot management — maps playerId ↔ integer SAB slot index.
  private playerToSlot = new Map<string, number>();
  private slotToPlayer = new Map<number, string>();
  private freeSlots: number[] = [];

  private bus!: Bus;
  private sessionToPlayer = new Map<string, string>();
  private playerToSession = new Map<string, string>();
  private inputCountThisTick = new Map<string, number>();
  private serverTick = 0;

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
      const { thrust, turnLeft, turnRight } = result.data;
      const slot = this.playerToSlot.get(playerId);
      if (slot !== undefined) {
        this.postToWorker({ type: 'INPUT', slot, thrust, turnLeft, turnRight });
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

    const welcome: WelcomeMessage = { type: 'welcome', playerId };
    client.send('welcome', welcome);

    this.bus.emit('SHIP_SPAWNED', { type: 'SHIP_SPAWNED' as const, playerId, x: spawnX, y: spawnY });
    logger.info({ playerId, sessionId: client.sessionId }, 'player joined');
  }

  override onLeave(client: Client, _consented: boolean): void {
    const playerId = this.sessionToPlayer.get(client.sessionId);
    if (!playerId) return;

    this.sessionToPlayer.delete(client.sessionId);
    this.playerToSession.delete(playerId);

    const slot = this.playerToSlot.get(playerId);
    if (slot !== undefined) {
      this.playerToSlot.delete(playerId);
      this.slotToPlayer.delete(slot);
      this.freeSlots.push(slot);
      this.postToWorker({ type: 'DESPAWN', slot, playerId });
    }

    this.state.ships.delete(playerId);
    this.bus.emit('SHIP_DESPAWNED', { type: 'SHIP_DESPAWNED' as const, playerId });
    logger.info({ playerId }, 'player left');
  }

  override onDispose(): void {
    this.physicsWorker?.terminate();
    logger.info('SectorRoom disposed');
  }

  // ── Simulation loop (main thread — reads SAB, updates Colyseus schema) ──

  private update(): void {
    this.inputCountThisTick.clear();
    if (this.playerToSlot.size === 0) return;

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
      }

      const seq2 = Atomics.load(this.sabU32, SEQLOCK_IDX);
      if (seq1 === seq2) break; // consistent read
      // seq changed during read → writer modified data, retry
    }

    this.serverTick = Atomics.load(this.sabU32, TICK_IDX);
    this.state.tick = this.serverTick;
  }
}
