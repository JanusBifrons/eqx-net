/**
 * A small pool of physics workers, each hosting several sector worlds.
 *
 * Memory, 2026-11-07: a physics worker costs ~37 MB before it holds a single
 * body (a V8 isolate, the bundled code, the ship catalogue built at load).
 * One worker per sector held ~800 MB of worker heap for the 21-sector
 * galaxy with nobody connected (`GET /dev/memory`). Pooling keeps the
 * parallelism (one worker per core) and pays that floor once per worker.
 *
 * Each world keeps its own SAB, tick counter and Rapier world (see
 * `createWorld` in `src/core/physics/worker.ts`), so a room sees exactly what
 * it saw with a dedicated worker. Commands carry `worldId`; replies come back
 * tagged with it and are routed here.
 *
 * `EQX_PHYSICS_WORKERS`: pool size. `per-room` restores one worker per
 * sector (for A/B measurement).
 */
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { Logger } from 'pino';
import type { EventLoopUtilization } from 'node:perf_hooks';
import { bundleWorker } from '../workers/bundleWorker.js';

/** A message from a pooled worker for one world. */
export interface PooledWorkerMsg { type: string; worldId?: number; [k: string]: unknown }

interface PoolWorker {
  index: number;
  /** Resolves to the started worker. */
  worker: Promise<Worker>;
  worlds: number;
}

/** One sector's world inside a pooled worker. */
export interface PooledWorld {
  readonly worldId: number;
  readonly workerIndex: number;
  /** Post a command for this world. The command object is tagged in place
   *  (no copy: this runs on the per-tick input / AI path, #14). */
  post(cmd: { type: string }): void;
  /** Free the world (on room dispose). */
  detach(): void;
  /** This world's worker heap (shared with its other worlds). */
  /** `gc`: ask the worker to collect first (dev only; needs --expose-gc). */
  heapStats(gc?: boolean): Promise<{ usedBytes: number; totalBytes: number } | null>;
  /** This world's worker event-loop utilisation (shared with its other worlds).
   *  Perf scenes report it as the worker's busy fraction (print-only). */
  elu(prev?: EventLoopUtilization): EventLoopUtilization | null;
}

export function physicsPoolSize(env: NodeJS.ProcessEnv = process.env): number {
  const v = env['EQX_PHYSICS_WORKERS'];
  if (v === 'per-room') return Number.POSITIVE_INFINITY;
  const n = v !== undefined ? Number(v) : NaN;
  if (Number.isFinite(n) && n >= 1) return Math.floor(n);
  // One per core, leaving one for the room ticks on the main thread; capped.
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}

export class PhysicsWorkerPool {
  private readonly workers: PoolWorker[] = [];
  private readonly handlers = new Map<number, (msg: PooledWorkerMsg) => void>();
  private code: Promise<string> | null = null;
  private nextWorldId = 1;

  constructor(
    private readonly entryPath: string,
    private readonly size: number,
    private readonly logger: Logger,
  ) {}

  /** Worker count and worlds per worker (diagnostics). */
  stats(): Array<{ index: number; worlds: number }> {
    return this.workers.map((w) => ({ index: w.index, worlds: w.worlds }));
  }

  /** Host a world over `sab`; resolves once the worker reports it READY. */
  async attach(sab: SharedArrayBuffer, onMessage: (msg: PooledWorkerMsg) => void): Promise<PooledWorld> {
    const pw = this.pick();
    const worldId = this.nextWorldId++;
    pw.worlds++;
    let worker: Worker;
    try {
      worker = await pw.worker;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`physics world ${worldId} did not become READY within 10 s`)), 10_000);
        this.handlers.set(worldId, (msg) => {
          if (msg.type === 'READY') {
            clearTimeout(timer);
            this.handlers.set(worldId, onMessage);
            resolve();
            return;
          }
          onMessage(msg);
        });
        worker.postMessage({ type: 'ADD_WORLD', worldId, sab });
      });
    } catch (err) {
      this.handlers.delete(worldId);
      pw.worlds--;
      throw err;
    }
    let attached = true;
    return {
      worldId,
      workerIndex: pw.index,
      post: (cmd) => {
        if (!attached) return;
        (cmd as { worldId?: number }).worldId = worldId;
        worker.postMessage(cmd);
      },
      detach: () => {
        if (!attached) return;
        attached = false;
        this.handlers.delete(worldId);
        pw.worlds--;
        worker.postMessage({ type: 'REMOVE_WORLD', worldId });
      },
      elu: (prev) => {
        const p = (worker as Worker & { performance?: { eventLoopUtilization?: (a?: EventLoopUtilization) => EventLoopUtilization } }).performance;
        return p?.eventLoopUtilization ? p.eventLoopUtilization(prev) : null;
      },
      heapStats: async (gc = false) => {
        const w = worker as Worker & { getHeapStatistics?: () => Promise<{ used_heap_size: number; total_heap_size: number }> };
        if (!w.getHeapStatistics) return null;
        if (gc) {
          worker.postMessage({ type: 'GC' });
          await new Promise((r) => setTimeout(r, 300)); // let the worker run it first
        }
        try {
          const h = await w.getHeapStatistics();
          return { usedBytes: h.used_heap_size, totalBytes: h.total_heap_size };
        } catch { return null; }
      },
    };
  }

  /** The least-loaded worker, starting a new one while under the pool size. */
  private pick(): PoolWorker {
    if (this.workers.length < this.size) {
      const pw: PoolWorker = { index: this.workers.length, worker: this.spawn(this.workers.length), worlds: 0 };
      this.workers.push(pw);
      return pw;
    }
    let best = this.workers[0]!;
    for (const w of this.workers) if (w.worlds < best.worlds) best = w;
    return best;
  }

  private async spawn(index: number): Promise<Worker> {
    // Rapier ships a pre-built WASM binary; keep it external so the worker
    // loads the same copy as the main thread. Bundled once for the pool.
    this.code ??= bundleWorker({ entryPoint: this.entryPath, external: ['@dimforge/rapier2d-compat'] });
    const code = await this.code;
    return new Promise<Worker>((resolve, reject) => {
      const worker = new Worker(code, { eval: true, workerData: { pooled: true } });
      // Idle pool workers must not keep a process (or a test runner) alive.
      worker.unref();
      const timer = setTimeout(() => reject(new Error('physics pool worker did not start within 10 s')), 10_000);
      worker.on('message', (msg: PooledWorkerMsg) => {
        if (msg.type === 'POOL_READY') { clearTimeout(timer); resolve(worker); return; }
        if (msg.worldId !== undefined) this.handlers.get(msg.worldId)?.(msg);
      });
      worker.on('error', (err) => {
        const e = err as Error & { code?: string };
        this.logger.error({ err, errMessage: e?.message, errStack: e?.stack, errCode: e?.code, workerIndex: index }, 'physics pool worker error');
        reject(err);
      });
      worker.on('exit', (exitCode) => {
        if (exitCode !== 0) this.logger.error({ code: exitCode, workerIndex: index }, 'physics pool worker exited unexpectedly');
      });
    });
  }
}

let shared: PhysicsWorkerPool | null = null;

/** The process-wide pool (created on first use). */
export function getPhysicsWorkerPool(entryPath: string, logger: Logger): PhysicsWorkerPool {
  shared ??= new PhysicsWorkerPool(entryPath, physicsPoolSize(), logger);
  return shared;
}
