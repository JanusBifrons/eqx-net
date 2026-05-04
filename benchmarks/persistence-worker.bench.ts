/**
 * Phase 7 — persistence worker load benchmark.
 *
 * Run: pnpm bench
 *
 * Goal: prove that pumping CRITICAL ops + VOLATILE telemetry through the
 * `WorkerBackedSink` does not impose meaningful per-call cost on the calling
 * (i.e., simulated game-loop) thread. The worker absorbs the SQL writes;
 * the main-thread cost is just `postMessage` plus WAB bookkeeping.
 *
 * What we measure:
 *   - `enqueueCritical(KILL)` cost — main-thread should be O(1) push into
 *     the WAB; the actual transaction commit happens off-thread.
 *   - `enqueueVolatile(TELEMETRY_SHED)` cost — same shape, fire-and-forget.
 *
 * Acceptance shape: each individual enqueue costs micro-seconds, not
 * milliseconds. Headline number is "enqueues per ms" — should comfortably
 * exceed 100 (i.e., < 10 µs each), even with the worker spinning.
 *
 * Caveat: vitest 2.1 + Node 24 reports NaN for hz/ms in some bench runs
 * (pre-existing issue noted in Phase 5 closure). We exercise the path
 * regardless so regressions in cost surface as obvious slow-downs.
 */
import { bench, describe, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { bundleWorker } from '../src/server/workers/bundleWorker.js';
import { WorkerBackedSink, type WorkerHandle } from '../src/server/db/WorkerBackedSink.js';
import type { PersistOp } from '../src/core/contracts/IPersistenceSink.js';

const DB_WORKER_TS = fileURLToPath(
  new URL('../src/server/db/dbWorker.ts', import.meta.url),
);

const KILL_OP: PersistOp = {
  type: 'KILL',
  killerUserId: 'killer',
  victimUserId: 'victim',
  weapon: 'hitscan',
  sectorId: 'sector',
  ts: Date.now(),
};

const SHED_OP: PersistOp = {
  type: 'TELEMETRY_SHED',
  entityId: 'swarm-1',
  sectorId: 'sector',
  ts: Date.now(),
};

describe('WorkerBackedSink — enqueue cost on the main thread', () => {
  let tempDir: string;
  let sink: WorkerBackedSink;
  let worker: Worker;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'eqx-bench-'));
    const dbPath = path.join(tempDir, 'bench.db');
    const code = await bundleWorker({ entryPoint: DB_WORKER_TS });
    worker = new Worker(code, { eval: true, workerData: { dbPath } });
    sink = new WorkerBackedSink();
    await sink.attach(worker as unknown as WorkerHandle);
  });

  afterAll(async () => {
    try {
      await sink.shutdown({ timeoutMs: 5000 });
    } catch {
      try { await worker.terminate(); } catch { /* noop */ }
    }
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* noop */ }
  });

  bench('enqueueCritical(KILL)', () => {
    sink.enqueueCritical(KILL_OP);
  });

  bench('enqueueVolatile(TELEMETRY_SHED)', () => {
    sink.enqueueVolatile(SHED_OP);
  });
});
