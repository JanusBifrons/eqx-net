/**
 * Unit lock for the sim-loop/timer error boundary (campaign PR 1.1).
 * The integration lock is tests/integration/sectorRoom/simLoopErrorBoundary.test.ts
 * (a poisoned update() must not stop a real room's sim loop); this file locks
 * the wrapper's own contract: containment, pass-through, and log throttling.
 */
import { describe, it, expect, vi } from 'vitest';
import { guarded, GUARDED_LOG_THROTTLE_MS } from './guardedLoop.js';

describe('guarded()', () => {
  it('happy path calls through every time and never logs', () => {
    const fn = vi.fn();
    const sink = vi.fn();
    const wrapped = guarded('test', fn, sink);
    wrapped();
    wrapped();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sink).not.toHaveBeenCalled();
  });

  it('a throwing callback does not propagate and the loop can keep calling', () => {
    let calls = 0;
    const wrapped = guarded(
      'test',
      () => {
        calls++;
        throw new Error('boom');
      },
      vi.fn(),
    );
    expect(() => {
      wrapped();
      wrapped();
      wrapped();
    }).not.toThrow();
    expect(calls).toBe(3);
  });

  it('logs the first error immediately with the label and the error', () => {
    const sink = vi.fn();
    const err = new Error('boom');
    const wrapped = guarded(
      'sim-update',
      () => {
        throw err;
      },
      sink,
      () => 1_000,
    );
    wrapped();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith('sim-update', err, 0);
  });

  it('throttles repeat errors and reports the suppressed count on the next log', () => {
    const sink = vi.fn();
    let now = 0;
    const wrapped = guarded(
      'test',
      () => {
        throw new Error('boom');
      },
      sink,
      () => now,
    );
    wrapped(); // logged (suppressed=0)
    now += 100;
    wrapped(); // suppressed
    now += 100;
    wrapped(); // suppressed
    expect(sink).toHaveBeenCalledTimes(1);
    now += GUARDED_LOG_THROTTLE_MS;
    wrapped(); // window elapsed -> logged with suppressed=2
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[1]![2]).toBe(2);
  });
});
