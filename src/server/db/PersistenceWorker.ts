import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import { WorkerBackedSink, type WorkerHandle } from './WorkerBackedSink.js';
import { bundleWorker } from '../workers/bundleWorker.js';

/**
 * Process-global persistence singleton. `initWorker()` constructs a
 * `WorkerBackedSink`, awaits the DB worker's READY handshake, and swaps it
 * in via `setPersistence`. Until then, any write attempt throws — production
 * boot must call `initWorker()` before serving traffic, and tests must call
 * `setPersistence()` with their own adapter.
 *
 * Auth's read-only main-thread connection lives in `Database.ts`; this
 * module never imports it (so unit tests that mock `setPersistence` don't
 * pull `node:sqlite` transitively).
 */
class UninitializedSink implements IPersistenceSink {
  private fail(): never {
    throw new Error('persistence sink not initialised — call initWorker() or setPersistence()');
  }
  enqueueCritical(): void { this.fail(); }
  enqueueVolatile(): void { this.fail(); }
  enqueueCriticalAwaitable(): Promise<{ rowId?: number }> {
    return Promise.reject(new Error('persistence sink not initialised'));
  }
  shutdown(): Promise<{ drained: number }> {
    return Promise.resolve({ drained: 0 });
  }
}

let _sink: IPersistenceSink = new UninitializedSink();

export function getPersistence(): IPersistenceSink {
  return _sink;
}

export function setPersistence(s: IPersistenceSink): void {
  _sink = s;
}

/**
 * Convenience proxy: callers can `import { persistence }` and call methods
 * directly without ever holding a stale reference if `setPersistence` is
 * later used to swap in a worker-backed sink.
 */
export const persistence: IPersistenceSink = {
  enqueueCritical(op: PersistOp): void {
    _sink.enqueueCritical(op);
  },
  enqueueVolatile(op: PersistOp): void {
    _sink.enqueueVolatile(op);
  },
  enqueueCriticalAwaitable(op: PersistOp): Promise<{ rowId?: number }> {
    return _sink.enqueueCriticalAwaitable(op);
  },
  shutdown(opts: { timeoutMs: number }): Promise<{ drained: number }> {
    return _sink.shutdown(opts);
  },
};

const DB_WORKER_TS_PATH = fileURLToPath(new URL('./dbWorker.ts', import.meta.url));

/**
 * Bundle the DB worker, spawn it, await READY, and swap in the
 * WorkerBackedSink. Called once from `src/server/index.ts` at boot.
 */
export async function initWorker(opts: { dbPath: string }): Promise<void> {
  const code = await bundleWorker({ entryPoint: DB_WORKER_TS_PATH });
  const worker = new Worker(code, {
    eval: true,
    workerData: { dbPath: opts.dbPath },
  });
  const sink = new WorkerBackedSink();
  await sink.attach(worker as unknown as WorkerHandle);
  setPersistence(sink);
}
