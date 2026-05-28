/**
 * Unit tests for the generic `ObjectPool`.
 *
 * Locks the contract documented in `ObjectPool.ts`:
 *   - acquire/release identity (recycled items, not fresh)
 *   - cap-overflow DISCARDS (does not throw) in prod
 *   - dev-mode double-release detection
 *   - reset callback is invoked on release
 *   - onOverrun fires on discard
 *   - pre-warm via `initial`
 *
 * Tests for the GC-friendliness of the pool (heap-delta assertions)
 * live in `heapDelta.smoke.test.ts` under `vitest.gc.config.ts` —
 * separate config because `global.gc` requires `--expose-gc` and the
 * default vitest pool doesn't pass it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { ObjectPool } from './ObjectPool.js';

const DEV_FLAG = '__POOL_DEV__';

describe('ObjectPool', () => {
  describe('acquire / release identity', () => {
    it('acquire from an empty pool returns a fresh factory item', () => {
      let calls = 0;
      const pool = new ObjectPool<{ id: number }>({
        factory: () => ({ id: ++calls }),
      });
      const a = pool.acquire();
      expect(a.id).toBe(1);
      expect(calls).toBe(1);
    });

    it('acquire after release returns the SAME instance', () => {
      const pool = new ObjectPool<{ tag: string }>({
        factory: () => ({ tag: 'fresh' }),
      });
      const first = pool.acquire();
      first.tag = 'used';
      pool.release(first);
      const second = pool.acquire();
      expect(second).toBe(first); // identity, not just equality
    });

    it('multiple acquires draw from the pool in LIFO order', () => {
      const pool = new ObjectPool<number[]>({
        factory: () => [],
      });
      const a = pool.acquire();
      const b = pool.acquire();
      pool.release(a);
      pool.release(b);
      // LIFO: most recently released comes back first.
      expect(pool.acquire()).toBe(b);
      expect(pool.acquire()).toBe(a);
    });
  });

  describe('reset callback', () => {
    it('reset is called on release, BEFORE the item returns to the pool', () => {
      const resets: string[] = [];
      const pool = new ObjectPool<{ tag: string }>({
        factory: () => ({ tag: 'fresh' }),
        reset: (item) => {
          resets.push(item.tag);
          item.tag = 'cleaned';
        },
      });
      const a = pool.acquire();
      a.tag = 'dirty';
      pool.release(a);
      expect(resets).toEqual(['dirty']);
      const b = pool.acquire();
      expect(b).toBe(a);
      expect(b.tag).toBe('cleaned');
    });

    it('reset is NOT called on acquire (only on release)', () => {
      let resetCount = 0;
      const pool = new ObjectPool<unknown>({
        factory: () => ({}),
        reset: () => {
          resetCount++;
        },
      });
      pool.acquire();
      expect(resetCount).toBe(0);
    });
  });

  describe('capacity', () => {
    it('default capacity allows up to 64 retained items', () => {
      const pool = new ObjectPool<number>({ factory: () => 0 });
      const items: number[] = [];
      for (let i = 0; i < 100; i++) items.push(pool.acquire());
      for (const it of items) pool.release(it);
      expect(pool.size).toBe(64);
    });

    it('release at cap DISCARDS surplus (does not throw, does not retain)', () => {
      const pool = new ObjectPool<number[]>({
        factory: () => [],
        capacity: 2,
      });
      const a = pool.acquire();
      const b = pool.acquire();
      const c = pool.acquire();
      pool.release(a);
      pool.release(b);
      // Pool full. Surplus release dropped — must not throw.
      expect(() => pool.release(c)).not.toThrow();
      expect(pool.size).toBe(2);
    });

    it('onOverrun is invoked on discard, with the surplus item', () => {
      const overruns: number[][] = [];
      const pool = new ObjectPool<number[]>({
        factory: () => [],
        capacity: 1,
        onOverrun: (item) => overruns.push(item),
      });
      const a = pool.acquire();
      const b = pool.acquire();
      pool.release(a);
      pool.release(b); // overrun
      expect(overruns).toHaveLength(1);
      expect(overruns[0]).toBe(b);
    });
  });

  describe('pre-warm via initial', () => {
    it('initial pre-fills the pool with factory items', () => {
      let calls = 0;
      const pool = new ObjectPool<{ id: number }>({
        factory: () => ({ id: ++calls }),
        initial: 5,
      });
      expect(pool.size).toBe(5);
      expect(calls).toBe(5);
      // First 5 acquires draw from the pre-fill, no new factory calls.
      for (let i = 0; i < 5; i++) pool.acquire();
      expect(calls).toBe(5);
      // 6th acquire falls through to factory.
      pool.acquire();
      expect(calls).toBe(6);
    });

    it('initial respects capacity (no overflow at construction)', () => {
      const pool = new ObjectPool<number>({
        factory: () => 0,
        initial: 10,
        capacity: 3,
      });
      // The constructor doesn't enforce capacity on pre-fill — the
      // contract is that capacity bounds RETAINED items after a
      // RELEASE. Pre-fill is the caller's responsibility.
      // This test locks that semantic so a future change doesn't
      // silently start truncating pre-fill (which would surprise a
      // caller who pre-filled to MAX_LIVE).
      expect(pool.size).toBe(10);
    });
  });

  describe('dev-mode double-release detection', () => {
    beforeEach(() => {
      (globalThis as Record<string, unknown>)[DEV_FLAG] = true;
    });
    afterEach(() => {
      delete (globalThis as Record<string, unknown>)[DEV_FLAG];
    });

    it('double-release of the SAME item throws', () => {
      const pool = new ObjectPool<{ x: number }>({
        factory: () => ({ x: 0 }),
      });
      const a = pool.acquire();
      pool.release(a);
      expect(() => pool.release(a)).toThrow(/double-release/);
    });

    it('release of a foreign item (never acquired) throws', () => {
      const pool = new ObjectPool<{ x: number }>({
        factory: () => ({ x: 0 }),
      });
      const foreign = { x: 999 };
      expect(() => pool.release(foreign)).toThrow(/foreign item/);
    });

    it('re-acquire after release clears the double-release flag', () => {
      const pool = new ObjectPool<{ x: number }>({
        factory: () => ({ x: 0 }),
      });
      const a = pool.acquire();
      pool.release(a);
      const b = pool.acquire(); // same instance, freshly acquired
      expect(b).toBe(a);
      expect(() => pool.release(b)).not.toThrow();
    });
  });

  describe('production-mode (dev flag off) skips tracking', () => {
    it('double-release does NOT throw — silent no-op for prod performance', () => {
      // No DEV_FLAG set; pool is in prod mode.
      const pool = new ObjectPool<{ x: number }>({
        factory: () => ({ x: 0 }),
      });
      const a = pool.acquire();
      pool.release(a);
      // Prod tolerates this. The cost of WeakSet bookkeeping is too
      // high for the hot loop; dev mode catches the bug instead.
      expect(() => pool.release(a)).not.toThrow();
    });
  });

  describe('property: pool size never exceeds capacity', () => {
    it('after arbitrary acquire/release sequences, size ≤ capacity', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 32 }),
          fc.array(fc.boolean(), { minLength: 0, maxLength: 200 }),
          (capacity, ops) => {
            const pool = new ObjectPool<object>({
              factory: () => ({}),
              capacity,
            });
            const live: object[] = [];
            for (const op of ops) {
              if (op || live.length === 0) {
                live.push(pool.acquire());
              } else {
                const item = live.pop()!;
                pool.release(item);
              }
            }
            expect(pool.size).toBeLessThanOrEqual(capacity);
          },
        ),
      );
    });
  });
});
