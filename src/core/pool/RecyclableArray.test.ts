/**
 * Unit tests for `createArrayPool` — the `T[]` wrapper around
 * `ObjectPool`.
 *
 * Locks the "logical length over physical slot" trick:
 *   1. `release()` truncates via `arr.length = 0` — the next acquirer
 *      sees an empty array but the backing buffer persists.
 *   2. Identity is preserved (the pool's purpose).
 *
 * Note: we cannot directly observe V8's backing-buffer capacity from
 * JS — `arr.length = 0` is documented in V8 release notes to retain
 * the buffer until the array itself is GC'd, but there's no public
 * API to assert capacity. The test below settles for "identity-stable
 * + length-zero on reuse," which is the user-visible contract.
 */
import { describe, it, expect } from 'vitest';
import { createArrayPool } from './RecyclableArray.js';

describe('createArrayPool', () => {
  it('acquire from an empty pool returns a fresh empty array', () => {
    const pool = createArrayPool<number>();
    const a = pool.acquire();
    expect(Array.isArray(a)).toBe(true);
    expect(a.length).toBe(0);
  });

  it('released array is length=0 on reuse (logical truncation)', () => {
    const pool = createArrayPool<number>();
    const first = pool.acquire();
    first.push(1, 2, 3);
    expect(first.length).toBe(3);
    pool.release(first);
    const second = pool.acquire();
    expect(second).toBe(first); // identity reused
    expect(second.length).toBe(0); // logical length wiped on release
  });

  it('a long acquire/release sequence reuses the same N instances', () => {
    const pool = createArrayPool<number>({ capacity: 4 });
    const seenInstances = new Set<number[]>();
    for (let i = 0; i < 100; i++) {
      const a = pool.acquire();
      seenInstances.add(a);
      a.push(i);
      pool.release(a);
    }
    expect(seenInstances.size).toBe(1);
  });

  it('capacity bound is enforced', () => {
    const pool = createArrayPool<string>({ capacity: 2 });
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    pool.release(a);
    pool.release(b);
    pool.release(c); // discarded
    expect(pool.size).toBe(2);
  });

  it('pre-filling via initial reuses instances on first N acquires', () => {
    const pool = createArrayPool<number>({ initial: 3 });
    expect(pool.size).toBe(3);
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    // All three came from the pre-fill (different instances).
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(pool.size).toBe(0);
  });
});
