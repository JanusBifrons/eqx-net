import { describe, it, expect } from 'vitest';
import { createServerHealthPoller, type HealthSnapshot } from './serverHealthPoller.js';

/**
 * Pure-function tests for the server-health poller. No global timers /
 * no global fetch — every dependency is injected so the test drives
 * deterministic transitions without `vi.useFakeTimers()`.
 *
 * The harness is a tiny scheduler that captures `setTimeout` calls
 * into a queue and a `fetchImpl` that returns whatever response the
 * test queued. Each `tick()` fires the next pending timer.
 */

interface ScheduledTask {
  cb: () => void;
  delayMs: number;
}

function makeHarness(opts: {
  responses: Array<{ ok: true; body: unknown } | { ok: false } | 'network-error' | 'timeout'>;
}) {
  const tasks: ScheduledTask[] = [];
  const snapshots: HealthSnapshot[] = [];
  let nextHandle = 1;
  const handles = new Map<number, ScheduledTask>();

  const setTimeoutImpl = ((cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const handle = nextHandle++ as unknown as ReturnType<typeof setTimeout>;
    const task = { cb, delayMs: ms };
    tasks.push(task);
    handles.set(handle as unknown as number, task);
    return handle;
  }) as typeof setTimeout;

  const clearTimeoutImpl = (handle: ReturnType<typeof setTimeout>): void => {
    const task = handles.get(handle as unknown as number);
    if (task) {
      const idx = tasks.indexOf(task);
      if (idx !== -1) tasks.splice(idx, 1);
      handles.delete(handle as unknown as number);
    }
  };

  let responseIdx = 0;
  const fetchImpl: typeof fetch = (_url, options) => {
    const responseSpec = opts.responses[responseIdx++];
    if (responseSpec === 'network-error') {
      return Promise.reject(new TypeError('network error'));
    }
    if (responseSpec === 'timeout') {
      // Never resolves on its own — the poller's AbortController must
      // abort it. We honour the abort signal.
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }
    if (responseSpec && responseSpec.ok) {
      return Promise.resolve(new Response(JSON.stringify(responseSpec.body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }
    return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
  };

  const onChange = (snap: HealthSnapshot): void => { snapshots.push(snap); };

  /** Drain microtasks (fetch promise resolution + onChange) without
   *  firing additional timer tasks. The poller fires `poll()` directly
   *  in `start()`, so the FIRST snapshot resolves through microtask
   *  chains alone; subsequent polls are queued via setTimeoutImpl
   *  and only fire if the test calls `runScheduled()`. */
  const drainMicrotasks = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  /** Fire timer tasks UP TO `iterations` (default 1). Each iteration
   *  drains the currently-queued tasks (snapshot at iteration start),
   *  then drains microtasks. Bounded loop so a misbehaving poller
   *  can't hang the test. */
  const flush = async (iterations = 1): Promise<void> => {
    for (let i = 0; i < iterations; i++) {
      const ready = tasks.splice(0, tasks.length); // snapshot + clear
      for (const task of ready) task.cb();
      await drainMicrotasks();
    }
  };

  return { tasks, snapshots, setTimeoutImpl, clearTimeoutImpl, fetchImpl, onChange, flush };
}

const validBody = {
  status: 'ok' as const,
  ready: true,
  tick: 1_700_000_000_000,
  playersOnline: 750,
};

describe('serverHealthPoller', () => {
  it('emits a healthy snapshot when /healthz returns a valid body', async () => {
    const h = makeHarness({ responses: [{ ok: true, body: validBody }] });
    const poller = createServerHealthPoller({
      url: '/healthz',
      onChange: h.onChange,
      fetchImpl: h.fetchImpl,
      setTimeoutImpl: h.setTimeoutImpl,
      clearTimeoutImpl: h.clearTimeoutImpl,
    });
    poller.start();
    await h.flush();
    poller.stop();

    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]!.state).toBe('healthy');
    expect(h.snapshots[0]!.data?.playersOnline).toBe(750);
  });

  // Regression lock (plan squishy-canyon): the server's /healthz gained an
  // optional `persistence` ops block (R4). The schema is `.strict()`, so before
  // it was declared optional the extra key failed safeParse → playersOnline/
  // ready silently dropped → meta-landing "—" + join CTA stuck disabled (PR #19
  // e2e-smoke failures). A body WITH persistence must still parse healthy.
  it('parses a /healthz body that includes the optional persistence block', async () => {
    const withPersistence = {
      ...validBody,
      persistence: { selectFailures: 0, criticalFailures: 0, queueDepth: 0, exited: false },
    };
    const h = makeHarness({ responses: [{ ok: true, body: withPersistence }] });
    const poller = createServerHealthPoller({
      url: '/healthz',
      onChange: h.onChange,
      fetchImpl: h.fetchImpl,
      setTimeoutImpl: h.setTimeoutImpl,
      clearTimeoutImpl: h.clearTimeoutImpl,
    });
    poller.start();
    await h.flush();
    poller.stop();

    expect(h.snapshots[0]!.state).toBe('healthy');
    expect(h.snapshots[0]!.data?.playersOnline).toBe(750);
  });

  it('emits an unreachable snapshot on network error, with no data', async () => {
    const h = makeHarness({ responses: ['network-error'] });
    const poller = createServerHealthPoller({
      url: '/healthz',
      onChange: h.onChange,
      fetchImpl: h.fetchImpl,
      setTimeoutImpl: h.setTimeoutImpl,
      clearTimeoutImpl: h.clearTimeoutImpl,
    });
    poller.start();
    await h.flush();
    poller.stop();

    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]!.state).toBe('unreachable');
    expect(h.snapshots[0]!.data).toBeNull();
  });

  it('emits unreachable on a non-2xx response', async () => {
    const h = makeHarness({ responses: [{ ok: false }] });
    const poller = createServerHealthPoller({
      url: '/healthz',
      onChange: h.onChange,
      fetchImpl: h.fetchImpl,
      setTimeoutImpl: h.setTimeoutImpl,
      clearTimeoutImpl: h.clearTimeoutImpl,
    });
    poller.start();
    await h.flush();
    poller.stop();

    expect(h.snapshots).toHaveLength(1);
    expect(h.snapshots[0]!.state).toBe('unreachable');
  });

  it('emits unreachable when the JSON body is malformed', async () => {
    const h = makeHarness({ responses: [{ ok: true, body: { status: 'ok' /* missing fields */ } }] });
    const poller = createServerHealthPoller({
      url: '/healthz',
      onChange: h.onChange,
      fetchImpl: h.fetchImpl,
      setTimeoutImpl: h.setTimeoutImpl,
      clearTimeoutImpl: h.clearTimeoutImpl,
    });
    poller.start();
    await h.flush();
    poller.stop();

    expect(h.snapshots[0]!.state).toBe('unreachable');
  });

  it('schedules a faster re-poll while unreachable than while healthy', async () => {
    const h = makeHarness({
      responses: [
        'network-error', // unreachable → schedule at unreachableIntervalMs
        { ok: true, body: validBody }, // healthy → schedule at healthyIntervalMs
        { ok: true, body: validBody },
      ],
    });
    const intervalsObserved: number[] = [];
    const trackingSetTimeout = ((cb: () => void, ms: number) => {
      intervalsObserved.push(ms);
      return h.setTimeoutImpl(cb, ms);
    }) as typeof setTimeout;

    const poller = createServerHealthPoller({
      url: '/healthz',
      onChange: h.onChange,
      fetchImpl: h.fetchImpl,
      setTimeoutImpl: trackingSetTimeout,
      clearTimeoutImpl: h.clearTimeoutImpl,
      healthyIntervalMs: 8000,
      unreachableIntervalMs: 2000,
      fetchTimeoutMs: 3000,
    });
    poller.start();
    // Flush twice: first poll → unreachable → reschedules at 2000;
    // the rescheduled poll fires next → healthy → reschedules at 8000.
    await h.flush(2);
    poller.stop();

    // Each fetch sets a fetchTimeout (3000) — filter to scheduling delays
    // we care about (the re-poll delays after each onChange).
    const scheduledDelays = intervalsObserved.filter((ms) => ms === 2000 || ms === 8000);
    expect(scheduledDelays[0]).toBe(2000); // unreachable → fast retry
    expect(scheduledDelays[1]).toBe(8000); // healthy → slow steady-state
  });

  it('stop() cancels pending timers and prevents further onChange', async () => {
    const h = makeHarness({
      responses: [{ ok: true, body: validBody }, { ok: true, body: validBody }],
    });
    const poller = createServerHealthPoller({
      url: '/healthz',
      onChange: h.onChange,
      fetchImpl: h.fetchImpl,
      setTimeoutImpl: h.setTimeoutImpl,
      clearTimeoutImpl: h.clearTimeoutImpl,
    });
    poller.start();
    await h.flush();
    expect(h.snapshots).toHaveLength(1);
    poller.stop();
    // After stop, even if a queued task would fire we shouldn't see
    // another snapshot.
    await h.flush();
    expect(h.snapshots).toHaveLength(1);
  });

  it('start() is idempotent — re-entry is safe', async () => {
    const h = makeHarness({ responses: [{ ok: true, body: validBody }] });
    const poller = createServerHealthPoller({
      url: '/healthz',
      onChange: h.onChange,
      fetchImpl: h.fetchImpl,
      setTimeoutImpl: h.setTimeoutImpl,
      clearTimeoutImpl: h.clearTimeoutImpl,
    });
    poller.start();
    poller.start();
    poller.start();
    await h.flush();
    poller.stop();
    expect(h.snapshots).toHaveLength(1);
  });

  it('aborts the fetch on timeout and reports unreachable', async () => {
    const h = makeHarness({ responses: ['timeout'] });
    const poller = createServerHealthPoller({
      url: '/healthz',
      onChange: h.onChange,
      fetchImpl: h.fetchImpl,
      setTimeoutImpl: h.setTimeoutImpl,
      clearTimeoutImpl: h.clearTimeoutImpl,
      fetchTimeoutMs: 100,
    });
    poller.start();
    await h.flush();
    poller.stop();
    expect(h.snapshots[0]!.state).toBe('unreachable');
  });
});
