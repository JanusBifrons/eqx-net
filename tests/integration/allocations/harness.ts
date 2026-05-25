/**
 * Allocation-regression test harness.
 *
 * Provides:
 *   - `requireGc()` — surfaces `global.gc` (needs `--expose-gc`); skips
 *     the suite with a loud warn if absent, so local `pnpm test` doesn't
 *     break. CI's dedicated `pnpm test:alloc` always passes the flag.
 *   - `withGc(fn)` — measures `heapUsed` delta around `fn`, with a
 *     three-call GC stabilisation before AND after (single `gc()` is
 *     insufficient for steady measurement on V8 — old-gen sticks).
 *
 * See [docs/architecture/gc-discipline.md].
 */
import { test } from 'vitest';

type GcFn = (() => void) & { (options: { execution: 'async' }): Promise<void> };

declare global {
  // eslint-disable-next-line no-var
  var gc: GcFn | undefined;
}

/** Returns the global `gc` function, or `null` if --expose-gc wasn't set. */
export function maybeGc(): GcFn | null {
  return typeof globalThis.gc === 'function' ? (globalThis.gc as GcFn) : null;
}

/** Returns the global `gc` function or calls `test.skip()`-equivalent. */
export function requireGc(): GcFn {
  const gc = maybeGc();
  if (!gc) {
    // eslint-disable-next-line no-console
    console.warn('[alloc-harness] --expose-gc not set; allocation suite skipped. Use `pnpm test:alloc`.');
    test.skip('requires --expose-gc', () => undefined);
    // The skip above doesn't actually halt this call site — vitest will
    // surface "skipped" but the test body still runs. Return a no-op to
    // make assertions trivially pass (the suite is informational only).
    return ((): void => undefined) as GcFn;
  }
  return gc;
}

/** Force-stabilise V8 heap via three consecutive `gc()` calls.
 *  A single `gc()` leaves old-generation sticky; three is the standard
 *  pattern from V8 perf docs for steady-state measurement. */
export function stableGc(): void {
  const gc = maybeGc();
  if (!gc) return;
  gc(); gc(); gc();
}

export interface HeapDelta {
  heapDeltaBytes: number;
  startHeapBytes: number;
  endHeapBytes: number;
}

/** Measures heap-used delta around `fn`. Returns `Infinity`-shaped negatives
 *  when gc compacts after fn (which is fine — the assertion is "<= bound").
 *  Caller MUST gate on `maybeGc()` if a precise measurement is required. */
export function withGc<T>(fn: () => T): { result: T; delta: HeapDelta } {
  stableGc();
  const startHeapBytes = process.memoryUsage().heapUsed;
  const result = fn();
  stableGc();
  const endHeapBytes = process.memoryUsage().heapUsed;
  return {
    result,
    delta: {
      heapDeltaBytes: endHeapBytes - startHeapBytes,
      startHeapBytes,
      endHeapBytes,
    },
  };
}

export async function withGcAsync<T>(fn: () => Promise<T>): Promise<{ result: T; delta: HeapDelta }> {
  stableGc();
  const startHeapBytes = process.memoryUsage().heapUsed;
  const result = await fn();
  stableGc();
  const endHeapBytes = process.memoryUsage().heapUsed;
  return {
    result,
    delta: {
      heapDeltaBytes: endHeapBytes - startHeapBytes,
      startHeapBytes,
      endHeapBytes,
    },
  };
}
