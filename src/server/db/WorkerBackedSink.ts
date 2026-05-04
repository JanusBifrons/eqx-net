import { pino } from 'pino';
import type { IPersistenceSink, PersistOp } from '../../core/contracts/IPersistenceSink.js';
import type { WorkerInbound, WorkerOutbound } from './workerProtocol.js';

const logger = pino({
  name: 'WorkerBackedSink',
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

/**
 * Worker handle abstraction. Production passes a `node:worker_threads.Worker`;
 * unit tests pass a fake whose `simulateMessage()` triggers handlers as if the
 * worker had replied. Methods mirror the subset of Worker we use.
 */
export interface WorkerHandle {
  postMessage(msg: WorkerInbound): void;
  on(event: 'message', cb: (msg: WorkerOutbound) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  terminate(): Promise<number>;
}

const WAB_FLUSH_MS = 50;
const CRITICAL_CAP = 10_000;
const VOLATILE_CAP = 5_000;
const AWAITABLE_TIMEOUT_MS = 2_000;

interface PendingAwaitable {
  resolve: (v: { rowId?: number }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Main-thread sink: coalesces CRITICAL ops into 50 ms transaction batches,
 * caps VOLATILE telemetry under memory pressure, supports awaitable ops with
 * a 2 s timeout, and drains the queue on graceful shutdown.
 */
export class WorkerBackedSink implements IPersistenceSink {
  private worker: WorkerHandle | null = null;
  private ready = false;
  private exited = false;

  private readonly pendingCritical: PersistOp[] = [];
  private readonly volatileBuffer: PersistOp[] = [];
  private volatileDropped = 0;

  private nextBatchId = 1;
  private nextOpId = 1;
  private readonly pendingAwaitables = new Map<string, PendingAwaitable>();
  private readonly pendingBatches = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();

  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private shutdownAck: ((res: { drained: number }) => void) | null = null;

  /**
   * Wire up a pre-spawned worker handle and return a promise that resolves
   * once the worker posts READY.
   */
  attach(worker: WorkerHandle): Promise<void> {
    this.worker = worker;
    return new Promise((resolve, reject) => {
      const readyTimeout = setTimeout(() => {
        reject(new Error('DB worker did not become READY within 5s'));
      }, 5_000);

      worker.on('message', (msg: WorkerOutbound) => {
        if (msg.type === 'READY') {
          this.ready = true;
          clearTimeout(readyTimeout);
          this.startFlushTimer();
          resolve();
          return;
        }
        if (msg.type === 'BATCH_ACK') {
          this.pendingBatches.get(msg.batchId)?.resolve();
          this.pendingBatches.delete(msg.batchId);
          return;
        }
        if (msg.type === 'BATCH_ERROR') {
          const message = `DB worker BATCH_ERROR: ${msg.message}`;
          logger.error({ batchId: msg.batchId, message: msg.message }, 'critical batch failure');
          this.pendingBatches.get(msg.batchId)?.reject(new Error(message));
          this.pendingBatches.delete(msg.batchId);
          return;
        }
        if (msg.type === 'AWAITABLE_ACK') {
          const p = this.pendingAwaitables.get(msg.opId);
          if (p) {
            clearTimeout(p.timer);
            p.resolve({ rowId: msg.rowId });
            this.pendingAwaitables.delete(msg.opId);
          }
          return;
        }
        if (msg.type === 'AWAITABLE_ERROR') {
          const p = this.pendingAwaitables.get(msg.opId);
          if (p) {
            clearTimeout(p.timer);
            p.reject(new Error(`DB worker AWAITABLE_ERROR: ${msg.message}`));
            this.pendingAwaitables.delete(msg.opId);
          }
          return;
        }
        if (msg.type === 'SHUTDOWN_ACK') {
          if (this.shutdownAck) {
            this.shutdownAck({ drained: msg.drained });
            this.shutdownAck = null;
          }
          return;
        }
      });

      worker.on('exit', (code: number) => {
        this.handleExit(code);
        if (!this.ready) {
          clearTimeout(readyTimeout);
          reject(new Error(`DB worker exited before READY (code ${code})`));
        }
      });

      worker.on('error', (err: Error) => {
        logger.error({ err }, 'DB worker error');
      });
    });
  }

  enqueueCritical(op: PersistOp): void {
    if (this.exited) {
      logger.error({ opType: op.type }, 'criticalSinkLost — worker exited; dropping op');
      return;
    }
    this.pendingCritical.push(op);
    if (this.pendingCritical.length >= CRITICAL_CAP) {
      logger.error(
        { pending: this.pendingCritical.length, cap: CRITICAL_CAP },
        'WAB cap exceeded — force-flushing',
      );
      this.flushCritical();
    }
  }

  enqueueVolatile(op: PersistOp): void {
    if (this.exited) return;
    if (this.volatileBuffer.length >= VOLATILE_CAP) {
      this.volatileBuffer.shift();
      this.volatileDropped += 1;
      if (this.volatileDropped % 100 === 1) {
        logger.warn({ dropped: this.volatileDropped }, 'volatile telemetry dropped (oldest)');
      }
    }
    this.volatileBuffer.push(op);
    // Drain immediately if the worker is available — VOLATILE has no
    // batching benefit and the worker swallows errors. The buffer accumulates
    // (capped, oldest-drop) only when the worker is unavailable: pre-READY
    // window, or if a future variant transiently disconnects.
    if (this.worker) {
      while (this.volatileBuffer.length > 0) {
        const next = this.volatileBuffer.shift()!;
        this.worker.postMessage({ type: 'VOLATILE', op: next });
      }
    }
  }

  enqueueCriticalAwaitable(op: PersistOp): Promise<{ rowId?: number }> {
    if (this.exited || !this.worker) {
      return Promise.reject(new Error('persistence worker not available'));
    }
    const opId = `op-${this.nextOpId++}`;
    return new Promise<{ rowId?: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAwaitables.delete(opId);
        reject(new Error(`DB worker awaitable timed out after ${AWAITABLE_TIMEOUT_MS}ms`));
      }, AWAITABLE_TIMEOUT_MS);
      this.pendingAwaitables.set(opId, { resolve, reject, timer });
      this.worker!.postMessage({ type: 'AWAITABLE', opId, op });
    });
  }

  async shutdown(opts: { timeoutMs: number }): Promise<{ drained: number }> {
    if (this.shuttingDown) {
      return Promise.reject(new Error('shutdown already in progress'));
    }
    this.shuttingDown = true;
    this.stopFlushTimer();

    if (!this.worker || this.exited) {
      return { drained: 0 };
    }

    // Eager flush of any queued CRITICAL ops, then wait for all in-flight
    // BATCH_ACKs before issuing SHUTDOWN.
    this.flushCritical();

    const pollEmpty = (): Promise<void> =>
      new Promise((resolve) => {
        const tick = (): void => {
          if (this.pendingBatches.size === 0) {
            resolve();
            return;
          }
          setTimeout(tick, 5);
        };
        tick();
      });

    const ackPromise = new Promise<{ drained: number }>((resolve) => {
      this.shutdownAck = resolve;
    });

    const deadline = Date.now() + opts.timeoutMs;
    const timeoutSignal = (): Promise<never> =>
      new Promise((_, reject) => {
        const ms = Math.max(0, deadline - Date.now());
        setTimeout(
          () => reject(new Error(`shutdown drain timed out after ${opts.timeoutMs}ms`)),
          ms,
        );
      });

    try {
      await Promise.race([pollEmpty(), timeoutSignal()]);
      this.worker.postMessage({ type: 'SHUTDOWN' });
      return await Promise.race([ackPromise, timeoutSignal()]);
    } catch (err) {
      // Force-terminate on timeout — better to lose the tail than hang.
      try {
        await this.worker.terminate();
      } catch {
        /* noop */
      }
      throw err;
    } finally {
      // Reject any still-in-flight awaitables so callers don't hang forever.
      for (const [opId, p] of this.pendingAwaitables) {
        clearTimeout(p.timer);
        p.reject(new Error('shutdown'));
        this.pendingAwaitables.delete(opId);
      }
    }
  }

  /** Internal: flush all currently-buffered CRITICAL ops as one BATCH. */
  private flushCritical(): void {
    if (!this.worker || this.pendingCritical.length === 0) return;
    const batchId = this.nextBatchId++;
    const ops = this.pendingCritical.splice(0, this.pendingCritical.length);
    // Track the in-flight batch so shutdown() can wait for the ACK. Errors
    // are surfaced via the BATCH_ERROR pino log; we don't block the caller.
    this.pendingBatches.set(batchId, {
      resolve: () => {},
      reject: () => {},
    });
    this.worker.postMessage({ type: 'BATCH', batchId, ops });
  }

  private startFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => {
      if (this.pendingCritical.length > 0) this.flushCritical();
    }, WAB_FLUSH_MS);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private handleExit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.stopFlushTimer();
    if (!this.shuttingDown) {
      logger.error({ code }, 'criticalSinkLost — DB worker exited unexpectedly');
    }
    // Reject any in-flight awaitables; their callers will see the error.
    for (const [opId, p] of this.pendingAwaitables) {
      clearTimeout(p.timer);
      p.reject(new Error(`DB worker exited (code ${code})`));
      this.pendingAwaitables.delete(opId);
    }
    for (const [batchId, b] of this.pendingBatches) {
      b.reject(new Error(`DB worker exited (code ${code})`));
      this.pendingBatches.delete(batchId);
    }
    // If a shutdown is in flight, resolve it — the worker has exited, so
    // we know the drain is done. Without this, a lost SHUTDOWN_ACK message
    // (race between postMessage and process.exit in the worker) would hang
    // the main thread forever waiting for an ack that never arrives.
    if (this.shutdownAck) {
      this.shutdownAck({ drained: 0 });
      this.shutdownAck = null;
    }
  }

  // Test inspection hooks — exposed for unit tests to verify internal state.
  /** @internal */ get _volatileDropped(): number { return this.volatileDropped; }
  /** @internal */ get _pendingCriticalSize(): number { return this.pendingCritical.length; }
}
