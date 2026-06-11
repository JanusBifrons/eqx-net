import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WorkerBackedSink, type WorkerHandle } from './WorkerBackedSink.js';
import type { WorkerInbound, WorkerOutbound } from './workerProtocol.js';

class FakeWorker implements WorkerHandle {
  readonly posted: WorkerInbound[] = [];
  private messageCb?: (msg: WorkerOutbound) => void;
  private exitCb?: (code: number) => void;
  private errorCb?: (err: Error) => void;
  terminated = false;

  postMessage(msg: WorkerInbound): void {
    this.posted.push(msg);
  }
  on(event: 'message', cb: (msg: WorkerOutbound) => void): void;
  on(event: 'exit', cb: (code: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(event: string, cb: (arg: never) => void): void {
    if (event === 'message') this.messageCb = cb as (msg: WorkerOutbound) => void;
    else if (event === 'exit') this.exitCb = cb as (code: number) => void;
    else if (event === 'error') this.errorCb = cb as (err: Error) => void;
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  // Test-side helpers — drive the sink as if the worker had replied.
  simulateMessage(msg: WorkerOutbound): void {
    this.messageCb?.(msg);
  }
  simulateExit(code: number): void {
    this.exitCb?.(code);
  }
  simulateError(err: Error): void {
    this.errorCb?.(err);
  }
}

const KILL_OP = {
  type: 'KILL',
  killerUserId: 'k',
  victimUserId: 'v',
  weapon: 'hitscan',
  sectorId: 's',
  ts: 1,
} as const;

async function attachReady(sink: WorkerBackedSink, worker: FakeWorker): Promise<void> {
  const p = sink.attach(worker);
  worker.simulateMessage({ type: 'READY' });
  await p;
}

describe('WorkerBackedSink', () => {
  let sink: WorkerBackedSink;
  let worker: FakeWorker;

  beforeEach(() => {
    vi.useFakeTimers();
    sink = new WorkerBackedSink();
    worker = new FakeWorker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces enqueueCritical ops into one BATCH per 50ms flush window', async () => {
    await attachReady(sink, worker);
    for (let i = 0; i < 5; i++) sink.enqueueCritical({ ...KILL_OP, ts: i });
    expect(worker.posted.filter((m) => m.type === 'BATCH')).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(50);
    const batches = worker.posted.filter((m) => m.type === 'BATCH');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.type).toBe('BATCH');
    if (batches[0]!.type === 'BATCH') {
      expect(batches[0]!.ops).toHaveLength(5);
    }
  });

  it('VOLATILE ops drain immediately as individual postMessages', async () => {
    await attachReady(sink, worker);
    sink.enqueueVolatile({ type: 'TELEMETRY_SHED', entityId: 'e1', sectorId: 's', ts: 1 });
    sink.enqueueVolatile({ type: 'TELEMETRY_SHED', entityId: 'e2', sectorId: 's', ts: 2 });
    const volatiles = worker.posted.filter((m) => m.type === 'VOLATILE');
    expect(volatiles).toHaveLength(2);
  });

  it('WAB cap (10 000) force-flushes synchronously on overrun', async () => {
    await attachReady(sink, worker);
    // 10 000 ops triggers the cap exactly when the 10 000th op is pushed.
    for (let i = 0; i < 10_000; i++) sink.enqueueCritical({ ...KILL_OP, ts: i });
    const batches = worker.posted.filter((m) => m.type === 'BATCH');
    expect(batches).toHaveLength(1);
    if (batches[0]!.type === 'BATCH') {
      expect(batches[0]!.ops).toHaveLength(10_000);
    }
    // Subsequent ops accumulate normally for the next window.
    sink.enqueueCritical({ ...KILL_OP, ts: 10_001 });
    expect(worker.posted.filter((m) => m.type === 'BATCH')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(worker.posted.filter((m) => m.type === 'BATCH')).toHaveLength(2);
  });

  it('enqueueCriticalAwaitable resolves with the rowId from AWAITABLE_ACK', async () => {
    await attachReady(sink, worker);
    const promise = sink.enqueueCriticalAwaitable({
      type: 'USER_REGISTER',
      userId: 'u1',
      email: 'a@b',
      passwordHash: null,
      displayName: null,
      ts: 1,
    });
    const sent = worker.posted.find((m) => m.type === 'AWAITABLE');
    expect(sent).toBeDefined();
    if (sent && sent.type === 'AWAITABLE') {
      worker.simulateMessage({ type: 'AWAITABLE_ACK', opId: sent.opId, rowId: 42 });
    }
    await expect(promise).resolves.toEqual({ rowId: 42 });
  });

  it('enqueueCriticalAwaitable rejects after 2 s with no ack', async () => {
    await attachReady(sink, worker);
    const promise = sink.enqueueCriticalAwaitable({
      type: 'USER_REGISTER',
      userId: 'u1',
      email: 'a@b',
      passwordHash: null,
      displayName: null,
      ts: 1,
    });
    // Catch the rejection eagerly to avoid a tracked unhandled rejection.
    const settled = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/);
  });

  it('VOLATILE drops oldest when buffer exceeds cap', async () => {
    // Pre-attach: enqueueVolatile is no-op when worker isn't set, so we
    // attach BUT crash the connection right after, so the cap kicks in
    // against the buffer rather than against the worker queue.
    await attachReady(sink, worker);
    // Override postMessage to drop sends so buffer fills up. Using the
    // private buffer directly is the cleanest unit-level inspection.
    const sinkAny = sink as unknown as { volatileBuffer: unknown[]; worker: WorkerHandle | null };
    sinkAny.worker = null;
    for (let i = 0; i < 5_001; i++) {
      sink.enqueueVolatile({ type: 'TELEMETRY_SHED', entityId: `e${i}`, sectorId: 's', ts: i });
    }
    expect((sink as unknown as { _volatileDropped: number })._volatileDropped).toBe(1);
    expect(sinkAny.volatileBuffer.length).toBeLessThanOrEqual(5_000);
  });

  it('shutdown flushes pending CRITICAL, awaits BATCH_ACK, then SHUTDOWN_ACK', async () => {
    await attachReady(sink, worker);
    sink.enqueueCritical({ ...KILL_OP, ts: 1 });
    sink.enqueueCritical({ ...KILL_OP, ts: 2 });

    const shutdownPromise = sink.shutdown({ timeoutMs: 1000 });
    // Eager flush should have posted a BATCH.
    await vi.advanceTimersByTimeAsync(0);
    const batch = worker.posted.find((m) => m.type === 'BATCH');
    expect(batch).toBeDefined();
    if (batch && batch.type === 'BATCH') {
      worker.simulateMessage({ type: 'BATCH_ACK', batchId: batch.batchId });
    }

    // Shutdown polls pendingBatches every 5 ms; tick past that.
    await vi.advanceTimersByTimeAsync(10);
    // Now SHUTDOWN should have been posted.
    const shut = worker.posted.find((m) => m.type === 'SHUTDOWN');
    expect(shut).toBeDefined();

    worker.simulateMessage({ type: 'SHUTDOWN_ACK', drained: 2 });
    await expect(shutdownPromise).resolves.toEqual({ drained: 2 });
  });

  it('shutdown rejects and force-terminates worker after timeout', async () => {
    await attachReady(sink, worker);
    sink.enqueueCritical({ ...KILL_OP, ts: 1 });
    const shutdownPromise = sink.shutdown({ timeoutMs: 500 });
    const settled = shutdownPromise.catch((e: Error) => e);
    // No BATCH_ACK ever arrives — drain timeout fires.
    await vi.advanceTimersByTimeAsync(600);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/timed out/);
    expect(worker.terminated).toBe(true);
  });

  it('worker exit mid-flight rejects in-flight awaitables and disables further writes', async () => {
    await attachReady(sink, worker);
    const promise = sink.enqueueCriticalAwaitable({
      type: 'USER_REGISTER',
      userId: 'u',
      email: 'a@b',
      passwordHash: null,
      displayName: null,
      ts: 1,
    });
    const settled = promise.catch((e: Error) => e);
    worker.simulateExit(1);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/exited/);

    // Subsequent enqueueCritical is dropped silently (logs criticalSinkLost).
    expect(() => sink.enqueueCritical(KILL_OP)).not.toThrow();
    expect((sink as unknown as { _pendingCriticalSize: number })._pendingCriticalSize).toBe(0);
  });

  it('attach rejects if worker exits before READY', async () => {
    const p = sink.attach(worker);
    const settled = p.catch((e: Error) => e);
    worker.simulateExit(1);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
  });

  describe('health() observability (R4)', () => {
    it('starts at zero failures and reports queue depth', async () => {
      await attachReady(sink, worker);
      sink.enqueueCritical(KILL_OP);
      const h = sink.health();
      expect(h.criticalFailures).toBe(0);
      expect(h.queueDepth).toBe(1);
      expect(h.exited).toBe(false);
    });

    it('increments criticalFailures on a BATCH_ERROR', async () => {
      await attachReady(sink, worker);
      sink.enqueueCritical(KILL_OP);
      await vi.advanceTimersByTimeAsync(50); // flush → BATCH posted
      const batch = worker.posted.find((m) => m.type === 'BATCH') as { batchId: number };
      worker.simulateMessage({ type: 'BATCH_ERROR', batchId: batch.batchId, message: 'disk full' });
      expect(sink.health().criticalFailures).toBe(1);
    });

    it('flags exited + counts a failure on an unexpected worker exit', async () => {
      await attachReady(sink, worker);
      worker.simulateExit(1); // unexpected (not via shutdown())
      const h = sink.health();
      expect(h.exited).toBe(true);
      expect(h.criticalFailures).toBe(1);
    });
  });
});
