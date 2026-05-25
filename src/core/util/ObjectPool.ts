/**
 * Hot-path allocation discipline — the canonical object pool primitive.
 *
 * Modelled on `HitPredictionLedger`'s inline pool (`src/core/combat/HitPrediction.ts:226-241`),
 * generalised so the entire codebase consumes ONE allocator. Pure (no zone
 * awareness, no DOM, no Node-only), so both server and client paths can use it.
 *
 * Contract:
 *  - `acquire()` returns a pooled instance (factory-created on first miss).
 *  - `release(o)` returns it to the free list; the optional `reset` is called.
 *  - `releaseAll(items)` releases every entry of an array, then clears the
 *    array length to 0 (the canonical "collection-resident release" idiom).
 *  - `allocations()` returns the lifetime alloc counter — the regression
 *    probe used by `tests/integration/allocations/*`.
 *
 * Collection-resident release contract (load-bearing):
 *
 * When a pooled object lives inside a reused collection for a tick, the
 * caller MUST release every prior entry before re-populating, or the pool
 * leaks (acquire grows, release never fires).
 *
 *   // Array form — cheap, single pass:
 *   pool.releaseAll(scratch.projectiles);  // clears length to 0
 *
 *   // Object-map form — `for…in + delete` is O(N):
 *   for (const k in scratch.states) {
 *     pool.release(scratch.states[k]!);
 *     delete scratch.states[k];
 *   }
 *
 * Prefer `[]` over `{}` for hot-path scratch collections where the keys
 * are not load-bearing.
 *
 * See [docs/architecture/gc-discipline.md] for the full paradigm.
 */

export interface PoolStats {
  readonly allocations: number;
  readonly inUse: number;
  readonly free: number;
}

export class ObjectPool<T> {
  private readonly freeList: T[] = [];
  private inUseCount = 0;
  private allocCount = 0;

  constructor(
    private readonly factory: () => T,
    private readonly reset?: (o: T) => void,
  ) {}

  acquire(): T {
    const reused = this.freeList.pop();
    if (reused !== undefined) {
      this.inUseCount++;
      return reused;
    }
    this.allocCount++;
    this.inUseCount++;
    return this.factory();
  }

  release(o: T): void {
    if (this.reset) this.reset(o);
    this.inUseCount--;
    this.freeList.push(o);
  }

  /** Release every item, then clear the array length to 0. The standard
   *  "end-of-tick" call for array-shaped scratch collections. */
  releaseAll(items: T[]): void {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item !== undefined) this.release(item);
    }
    items.length = 0;
  }

  stats(): PoolStats {
    return { allocations: this.allocCount, inUse: this.inUseCount, free: this.freeList.length };
  }

  /** Lifetime allocation count. The regression probe — assertions in
   *  `tests/integration/allocations/*` use this to lock steady-path
   *  allocation budgets. Matches `HitPredictionLedger.allocations()`. */
  allocations(): number {
    return this.allocCount;
  }
}

/** Clears an array's length to 0 without allocating. Codifies the
 *  `arr.length = 0` idiom so callers can express intent. */
export function clearArray<T>(arr: T[]): void {
  arr.length = 0;
}
