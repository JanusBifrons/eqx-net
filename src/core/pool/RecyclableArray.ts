/**
 * Pool of `T[]` instances — acquire an empty array, release truncates
 * via `arr.length = 0` (preserves backing capacity for the next
 * acquire — the "logical length over physical slot" trick).
 *
 * Use this when the consumer pushes a variable count of items each
 * tick, and the array's backing buffer can be reused next tick.
 *
 * The `logical length` trick is load-bearing: setting `arr.length = 0`
 * does NOT release the underlying buffer in V8 (until the array is
 * GC'd entirely). The next `push` starts at index 0 with the buffer
 * already sized to the previous high-water — so per-tick pushes
 * amortise to zero allocations once the pool stabilises.
 *
 * Note: if your scratch holds OBJECT references (`{id, x, y, ...}`),
 * those object instances also need to be pooled — the array reset
 * only truncates the array, it doesn't return the contained items
 * to a pool. Either:
 *   1. Pool the contents separately (an `ObjectPool<MountTargetView>`
 *      whose items live AS array slots — acquire on `push`, release
 *      on truncate), or
 *   2. Use the "reuse-or-create in-slot" pattern: `targets[i] ??=
 *      makeView(); writeView(targets[i], data); i++`. After the loop,
 *      `targets.length = i`. The view instances persist across ticks
 *      (no per-item pool needed); only the array's logical length
 *      changes.
 */
import { ObjectPool, type ObjectPoolOptions } from './ObjectPool.js';

export type ArrayPoolOptions = Pick<ObjectPoolOptions<unknown>, 'capacity' | 'initial' | 'onOverrun'>;

export function createArrayPool<T>(options: ArrayPoolOptions = {}): ObjectPool<T[]> {
  return new ObjectPool<T[]>({
    factory: () => [],
    reset: (a) => {
      a.length = 0;
    },
    capacity: options.capacity,
    initial: options.initial,
    onOverrun: options.onOverrun as ((item: T[]) => void) | undefined,
  });
}
