/**
 * Unit tests for `createSetPool` — the `Set<T>` wrapper around
 * `ObjectPool`.
 *
 * Locks the two reset-semantics requirements:
 *   1. Released Set is `.clear()`'d before reuse — the next acquirer
 *      never sees a populated Set.
 *   2. Instance identity is preserved across acquire/release cycles
 *      (the pool's purpose).
 */
import { describe, it, expect } from 'vitest';
import { createSetPool } from './RecyclableSet.js';

describe('createSetPool', () => {
  it('acquire from an empty pool returns a fresh empty Set', () => {
    const pool = createSetPool<string>();
    const s = pool.acquire();
    expect(s).toBeInstanceOf(Set);
    expect(s.size).toBe(0);
  });

  it('released Set is .clear()ed before being reused', () => {
    const pool = createSetPool<string>();
    const first = pool.acquire();
    first.add('a');
    first.add('b');
    expect(first.size).toBe(2);
    pool.release(first);
    const second = pool.acquire();
    expect(second).toBe(first); // identity reused
    expect(second.size).toBe(0); // contents wiped on release
  });

  it('a long acquire/release sequence reuses the same N instances', () => {
    const pool = createSetPool<number>({ capacity: 4 });
    const seenInstances = new Set<Set<number>>();
    for (let i = 0; i < 100; i++) {
      const s = pool.acquire();
      seenInstances.add(s);
      s.add(i);
      pool.release(s);
    }
    // Sequential acquire/release of a single live Set — the pool
    // reuses the same instance every iteration.
    expect(seenInstances.size).toBe(1);
  });

  it('capacity bound is enforced', () => {
    const pool = createSetPool<string>({ capacity: 2 });
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    pool.release(a);
    pool.release(b);
    pool.release(c); // discarded
    expect(pool.size).toBe(2);
  });
});
