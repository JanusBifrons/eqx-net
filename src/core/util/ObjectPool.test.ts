import { describe, expect, it } from 'vitest';
import { ObjectPool, clearArray } from './ObjectPool.js';

interface Entry { x: number; y: number; label: string }
const makeEntry = (): Entry => ({ x: 0, y: 0, label: '' });
const resetEntry = (e: Entry): void => { e.x = 0; e.y = 0; e.label = ''; };

describe('ObjectPool', () => {
  it('allocates only on the first acquire, reuses thereafter', () => {
    const pool = new ObjectPool<Entry>(makeEntry, resetEntry);
    const a = pool.acquire(); a.x = 1;
    pool.release(a);
    const b = pool.acquire();
    expect(b).toBe(a);                  // same object reference
    expect(b.x).toBe(0);                 // reset cleared it
    expect(pool.allocations()).toBe(1);  // one factory call total
  });

  it('grows the pool when concurrent demand exceeds the free list', () => {
    const pool = new ObjectPool<Entry>(makeEntry);
    const out: Entry[] = [];
    for (let i = 0; i < 5; i++) out.push(pool.acquire());
    expect(pool.allocations()).toBe(5);
    expect(pool.stats().inUse).toBe(5);
    expect(pool.stats().free).toBe(0);
    for (const o of out) pool.release(o);
    expect(pool.stats().inUse).toBe(0);
    expect(pool.stats().free).toBe(5);
    // Re-acquire all five — no new allocations.
    for (let i = 0; i < 5; i++) pool.acquire();
    expect(pool.allocations()).toBe(5);
  });

  it('steady-state usage produces a tiny allocation count (HitPredictionLedger-style)', () => {
    const pool = new ObjectPool<Entry>(makeEntry, resetEntry);
    // Simulate 1000 tick cycles with peak-3 concurrent entries.
    for (let tick = 0; tick < 1000; tick++) {
      const a = pool.acquire(); a.x = tick;
      const b = pool.acquire(); b.x = tick + 1;
      const c = pool.acquire(); c.x = tick + 2;
      pool.release(a); pool.release(b); pool.release(c);
    }
    // Bounded by peak-concurrent count, NOT by tick count.
    expect(pool.allocations()).toBeLessThanOrEqual(3);
  });

  it('releaseAll empties the array and returns every entry to the pool', () => {
    const pool = new ObjectPool<Entry>(makeEntry, resetEntry);
    const scratch: Entry[] = [];
    for (let i = 0; i < 4; i++) {
      const e = pool.acquire(); e.x = i; scratch.push(e);
    }
    expect(scratch.length).toBe(4);
    pool.releaseAll(scratch);
    expect(scratch.length).toBe(0);
    expect(pool.stats().free).toBe(4);
    expect(pool.stats().inUse).toBe(0);
  });

  it('reset is called on release (clears stale state before reuse)', () => {
    const pool = new ObjectPool<Entry>(makeEntry, resetEntry);
    const a = pool.acquire();
    a.x = 42; a.y = 99; a.label = 'stale';
    pool.release(a);
    const b = pool.acquire();
    expect(b.x).toBe(0);
    expect(b.y).toBe(0);
    expect(b.label).toBe('');
  });

  it('works without a reset function (caller responsible for clearing)', () => {
    const pool = new ObjectPool<Entry>(makeEntry); // no reset
    const a = pool.acquire(); a.x = 5;
    pool.release(a);
    const b = pool.acquire();
    expect(b).toBe(a);
    expect(b.x).toBe(5); // unchanged — caller's job to clear
  });
});

describe('clearArray', () => {
  it('truncates length to 0 without reassigning', () => {
    const arr = [1, 2, 3, 4];
    const ref = arr;
    clearArray(arr);
    expect(arr.length).toBe(0);
    expect(arr).toBe(ref);
  });
});
