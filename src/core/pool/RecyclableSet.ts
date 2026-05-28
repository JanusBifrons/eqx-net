/**
 * Pool of `Set<T>` instances — acquire a cleared Set, release returns
 * it (`.clear()`'d) to the pool.
 *
 * Use this when:
 *   - The Set is short-lived inside a hot-loop function.
 *   - The typical population is small (<16) AND stable. Above ~16
 *     entries V8 frees the backing `OrderedHashTable` on `.clear()`,
 *     so the pool saves only the object header (~32 B per acquire).
 *     For large variable populations, a plain field with `.clear()`
 *     is equivalent and simpler.
 *
 * Prefer the **generation-counter pattern** (R5 in the paradigm doc)
 * over this for any "build set of seen ids, then sweep cache" loop —
 * that pattern allocates zero, no pool needed.
 *
 * Constructed via `createSetPool<T>()` to keep call-site type
 * inference clean.
 */
import { ObjectPool, type ObjectPoolOptions } from './ObjectPool.js';

export type SetPoolOptions = Pick<ObjectPoolOptions<unknown>, 'capacity' | 'initial' | 'onOverrun'>;

export function createSetPool<T>(options: SetPoolOptions = {}): ObjectPool<Set<T>> {
  return new ObjectPool<Set<T>>({
    factory: () => new Set<T>(),
    reset: (s) => s.clear(),
    capacity: options.capacity,
    initial: options.initial,
    onOverrun: options.onOverrun as ((item: Set<T>) => void) | undefined,
  });
}
