/**
 * Generic object pool — acquire / release with optional capacity.
 *
 * The foundational utility behind invariant #14 ("no new hot-loop
 * allocation"). Used by `RecyclableSet`, `RecyclableArray`, and any
 * future per-consumer pool that needs richer lifecycle than a single
 * module-scope scratch field.
 *
 * Design choices (all intentional, all driven by the hostile-review
 * findings on the GC-reduction plan — see
 * `docs/architecture/memory-allocation-paradigm.md`):
 *
 * 1. **Soft cap, discard-on-overflow.** When `release()` is called and
 *    the pool is already at `capacity`, the surplus item is dropped
 *    (returned to GC) and a `pool_overrun` is emitted via the
 *    `onOverrun` callback if provided. We do NOT throw in production —
 *    a crash on an unexpected overrun is strictly worse than letting GC
 *    reclaim the surplus. Tests can opt into throwing by passing
 *    `onOverrun: () => { throw ... }`.
 *
 * 2. **Double-release detection in dev.** When `globalThis.__POOL_DEV__`
 *    is truthy, a `WeakSet` tracks acquired items and `release()` throws
 *    if an item is returned twice. In production the WeakSet is never
 *    populated, so the check is a single boolean read per call.
 *
 * 3. **Pre-warm.** `initial` lets the consumer fill the pool at
 *    construction so the first N `acquire()` calls don't allocate
 *    through the factory. Useful for bench warmup and for consumers
 *    with a known minimum live count.
 *
 * 4. **No `acquire(): T | undefined` variant.** `acquire()` always
 *    returns a `T`; an empty pool falls through to the factory. The
 *    pool is never a permission gate, only a recycling cache.
 *
 * 5. **No async API.** `generic-pool` and friends model
 *    resource-lifecycle pools (DB connections) which need async
 *    acquire. Our pools recycle plain objects synchronously inside the
 *    frame budget — async would just add a microtask.
 */

/** Configuration for an `ObjectPool`. */
export interface ObjectPoolOptions<T> {
  /** Construct a fresh item when the pool is empty. */
  readonly factory: () => T;
  /** Optional cleanup called on `release()` before the item is
   *  returned to the pool. Use this to clear references the item
   *  holds so the GC isn't kept from collecting them.
   *
   *  For `Set`/`Map`/`Array` reset, prefer the dedicated wrappers
   *  (`RecyclableSet`, `RecyclableArray`) — they encode the correct
   *  reset semantics. */
  readonly reset?: (item: T) => void;
  /** Soft cap on retained items. Surplus releases are discarded
   *  (and `onOverrun` is invoked if provided). Default: 64.
   *  Pick this based on the consumer's realistic peak; pools that
   *  are larger than the working set waste memory without payoff. */
  readonly capacity?: number;
  /** Pre-fill the pool with `initial` items at construction. */
  readonly initial?: number;
  /** Hook fired when `release()` discards an item due to cap
   *  overflow. Default: silent. Tests use this to assert balanced
   *  acquire/release; prod can plumb it into a diagnostic. */
  readonly onOverrun?: (item: T) => void;
}

const DEV_FLAG = '__POOL_DEV__' as const;

function devMode(): boolean {
  // Single boolean read per call; safe in any JS host.
  return Boolean((globalThis as Record<string, unknown>)[DEV_FLAG]);
}

export class ObjectPool<T> {
  private readonly factory: () => T;
  private readonly reset: ((item: T) => void) | undefined;
  private readonly capacity: number;
  private readonly onOverrun: ((item: T) => void) | undefined;
  private readonly stack: T[] = [];
  /** Dev-only — never populated when `__POOL_DEV__` is falsy. */
  private readonly acquired: WeakSet<object> | null;

  constructor(options: ObjectPoolOptions<T>) {
    this.factory = options.factory;
    this.reset = options.reset;
    this.capacity = options.capacity ?? 64;
    this.onOverrun = options.onOverrun;
    this.acquired = devMode() ? new WeakSet() : null;

    const initial = options.initial ?? 0;
    for (let i = 0; i < initial; i++) {
      this.stack.push(this.factory());
    }
  }

  acquire(): T {
    const reused = this.stack.pop();
    const item = reused ?? this.factory();
    if (this.acquired !== null && typeof item === 'object' && item !== null) {
      this.acquired.add(item);
    }
    return item;
  }

  release(item: T): void {
    if (this.acquired !== null && typeof item === 'object' && item !== null) {
      if (!this.acquired.has(item)) {
        throw new Error('ObjectPool: double-release or release of foreign item');
      }
      this.acquired.delete(item);
    }
    if (this.reset !== undefined) this.reset(item);
    if (this.stack.length >= this.capacity) {
      if (this.onOverrun !== undefined) this.onOverrun(item);
      return; // discard surplus; let GC reclaim it
    }
    this.stack.push(item);
  }

  /** Items currently retained in the pool. Diagnostic only — not for
   *  control-flow decisions. */
  get size(): number {
    return this.stack.length;
  }
}
