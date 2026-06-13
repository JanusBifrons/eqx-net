/**
 * Owns the lifecycle + message-routing for the physics worker thread.
 *
 * Encapsulates:
 *   - `bundleWorker` esbuild bundle + Worker constructor
 *   - the `READY` handshake (Promise resolution gate)
 *   - the `SLEEP_TRANSITION` and `CONTACT_BATCH` message routing
 *   - error / exit handlers with structured logger output
 *   - the postMessage typed-command facade (`postCommand`)
 *   - `terminate()` lifecycle hook used by `onDispose`
 *
 * The room provides the message handlers via injected callbacks so
 * SectorRoom no longer references the Worker instance directly. The
 * single-writer / single-owner contract is preserved: this is the
 * only place that constructs the Worker, the only place the room's
 * physicsWorker reference is established.
 *
 * Extracted from SectorRoom (commit 20 of v3 refactor plan).
 */

import { Worker } from 'node:worker_threads';
import type { Logger } from 'pino';
import type { Vec2 } from '../../core/swarm/asteroidShape.js';
import { bundleWorker } from '../workers/bundleWorker.js';

/**
 * The closed-set discriminated union of worker commands. Mirrored from
 * `src/core/CLAUDE.md` "Physics Worker — Worker→Main Message Variants"
 * (main → worker direction). Adding a new variant must touch:
 *   - this union
 *   - the worker's command-dispatch site (`src/core/physics/worker.ts`)
 *   - this header docstring
 */
export type WorkerCmd =
  | { type: 'SPAWN';          slot: number; playerId: string; x: number; y: number; kindId?: string }
  | { type: 'DESPAWN';        slot: number; playerId: string }
  | { type: 'REKEY_SHIP';     oldId: string; newId: string }
  | { type: 'INPUT';          slot: number; inputTick: number; thrust: boolean; turnLeft: boolean; turnRight: boolean; boost: boolean; reverse: boolean }
  | { type: 'SPAWN_OBSTACLE'; slot: number; obstacleId: string; x: number; y: number; vx: number; vy: number; radius: number; mass: number; vertices?: ReadonlyArray<Vec2>; linearDamping?: number; staticBody?: boolean; collisionGroups?: number; angle?: number }
  | { type: 'AI_INTENT';      slot: number; fx: number; fy: number; torque: number; setAngvel?: number }
  | { type: 'CLOCK_RATE';     rate: number }
  | { type: 'SET_POSITION';   entityId: string; x: number; y: number; angle: number; vx: number; vy: number; angvel: number }
  | { type: 'SET_HULL_EXPOSED'; id: string; exposed: boolean; kindId: string; tick: number }
  /** Missile splash impulse. The server's MissileSimulation queues these on
   *  detonate; the SectorRoom drains the queue each tick and posts them as
   *  individual commands. The worker resolves `entityId` to a Rapier body
   *  (same id used in player→body and drone→body maps) and applies the
   *  impulse via `physics.applyImpulse(id, fx, fy, 0)`. Cleanly no-ops on
   *  despawned entities. See docs/architecture/missile-simulation.md. */
  | { type: 'MISSILE_IMPULSE'; entityId: string; fx: number; fy: number }
  /** Shield-fence plan — manage a shield-wall span (a static cuboid between two
   *  pylon poses that blocks ships). `SET_WALL_ACTIVE` toggles its collider on
   *  stun / power loss without churning the body. See PhysicsWorld.spawnWall. */
  | { type: 'SPAWN_WALL';      id: string; ax: number; ay: number; bx: number; by: number; thickness: number }
  | { type: 'SET_WALL_ACTIVE'; id: string; active: boolean }
  | { type: 'REMOVE_WALL';     id: string };

/** Per-tick contact payload extracted from the worker's CONTACT_BATCH message.
 *  Mirrors `core/physics/contactDrain.ts` `Contact` across the postMessage
 *  boundary (structured-clone preserves every field). */
export interface ContactPayload {
  aId: string;
  bId: string;
  vAxPost: number;
  vAyPost: number;
  vBxPost: number;
  vByPost: number;
  forceMagnitude: number;
  /** Closing speed (game u/s) at impact — drives the ramming-damage gate. */
  impactSpeed?: number;
}

/** Generic worker-to-main message shape (loosely typed; the worker
 *  doesn't have a strict union today — see CLAUDE.md note). */
interface WorkerToMainMsg {
  type: string;
  entityId?: string;
  sleeping?: boolean;
  tick?: number;
  contacts?: ContactPayload[];
}

export interface PhysicsWorkerProxyDeps {
  /** Absolute path to the worker entry-point .ts file (bundled by esbuild). */
  workerEntryPath: string;
  /** The SAB the worker shares with the main thread for state. */
  sab: SharedArrayBuffer;
  /** Pino logger for error/exit output. */
  logger: Logger;
  /** Diagnostic shape included in error logs — read at error time. */
  stats: () => { playerCount: number; swarmCount: number };
  /** Sleep-transition handler — the room emits ENTITY_SLEPT/ENTITY_WOKE. */
  onSleepTransition: (entityId: string, sleeping: boolean) => void;
  /** Contact-batch handler — the room broadcasts collision_resolved + ramming. */
  onContactBatch: (tick: number, contacts: ContactPayload[]) => void;
}

export class PhysicsWorkerProxy {
  private worker: Worker | null = null;

  constructor(private readonly deps: PhysicsWorkerProxyDeps) {}

  /**
   * Bundle + spawn the physics worker. Resolves after the worker posts
   * `READY`. Rejects if the worker errors / exits / times out before
   * 10 s. Mirrors the original `spawnWorker` exactly.
   */
  async start(): Promise<void> {
    const workerCode = await bundleWorker({
      entryPoint: this.deps.workerEntryPath,
      // Rapier ships a pre-built WASM binary; keep it external so the
      // worker accesses the same copy as the main thread (avoids
      // double-init).
      external: ['@dimforge/rapier2d-compat'],
    });
    return new Promise<void>((resolve, reject) => {
      this.worker = new Worker(workerCode, {
        eval: true,
        workerData: { sab: this.deps.sab },
      });

      let ready = false;

      this.worker.on('message', (msg: WorkerToMainMsg) => {
        if (!ready && msg.type === 'READY') {
          ready = true;
          resolve();
          return;
        }
        if (msg.type === 'SLEEP_TRANSITION' && typeof msg.entityId === 'string' && typeof msg.sleeping === 'boolean') {
          this.deps.onSleepTransition(msg.entityId, msg.sleeping);
        }
        if (msg.type === 'CONTACT_BATCH' && Array.isArray(msg.contacts) && typeof msg.tick === 'number') {
          this.deps.onContactBatch(msg.tick, msg.contacts);
        }
      });

      this.worker.on('error', (err) => {
        // Surface the full error — message, stack, name, code — so
        // OOM / assertion failures from Rapier WASM are diagnostic
        // rather than mute. Without `err.stack`, pino's serializer may
        // drop the underlying crash site.
        const errAny = err as Error & { code?: string };
        const stats = this.deps.stats();
        this.deps.logger.error(
          {
            err,
            errMessage: errAny?.message,
            errStack: errAny?.stack,
            errName: errAny?.name,
            errCode: errAny?.code,
            ...stats,
          },
          'physics worker error',
        );
        if (!ready) reject(err);
      });

      this.worker.on('exit', (code) => {
        if (code !== 0) {
          const stats = this.deps.stats();
          this.deps.logger.error(
            { code, ...stats },
            'physics worker exited unexpectedly',
          );
          if (!ready) reject(new Error(`physics worker exited with code ${code}`));
        }
      });

      setTimeout(() => {
        if (!ready) reject(new Error('physics worker did not become READY within 10 s'));
      }, 10_000);
    });
  }

  /** Type-safe postMessage facade — the only sanctioned path to the worker. */
  postCommand(cmd: WorkerCmd): void {
    if (!this.worker) return;
    this.worker.postMessage(cmd);
  }

  /** Used by `onDispose`. Worker may not exist if start() never ran. */
  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
