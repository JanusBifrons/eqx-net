import { describe, it, expect, vi, afterEach } from 'vitest';
import { WorkerBakeRunner } from './ArtService.js';
import type { Baked, BakeJob } from './bake.js';
import type { LightRig } from './shade.js';

/** A worker that answers every bake at once (the bake itself is instant). */
function fakeWorker(): Worker {
  const w = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    onerror: null,
    postMessage(msg: { seq: number }) {
      queueMicrotask(() => w.onmessage?.({ data: { seq: msg.seq, baked: { seq: msg.seq } } }));
    },
    terminate() {},
  };
  return w as unknown as Worker;
}

const job = {} as BakeJob;
const rig = {} as LightRig;

afterEach(() => { vi.useRealTimers(); });

describe('the test bake delay (?artDelayMs) holds results, not workers', () => {
  // CI e2e-smoke, 2026-11-18: join-art-ready timed out waiting for the
  // loading screen to lift. The delay held the worker, so with the 36 warm-up
  // bakes queued first, the pilot's own ship waited two or more 8 s rounds
  // per worker (4 vCPUs = 3 workers) and the reveal ran past the 30 s wait.
  it('a queue of bakes on one worker all land one delay after they are done', async () => {
    vi.useFakeTimers();
    const r = new WorkerBakeRunner(1, fakeWorker, 1000);
    const landed: Baked[] = [];
    for (let i = 0; i < 3; i++) void r.run(job, rig).then((b) => { landed.push(b); });
    await vi.advanceTimersByTimeAsync(999);
    expect(landed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(landed).toHaveLength(3);
    r.destroy();
  });

  it('no delay: each bake lands as soon as the worker answers', async () => {
    const r = new WorkerBakeRunner(1, fakeWorker);
    const all = await Promise.all([r.run(job, rig), r.run(job, rig)]);
    expect(all).toHaveLength(2);
    r.destroy();
  });
});
