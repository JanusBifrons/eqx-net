/**
 * `src/core/pool` — minimal allocation-pool utilities for invariant #14.
 *
 * See [docs/architecture/memory-allocation-paradigm.md](../../../docs/architecture/memory-allocation-paradigm.md)
 * for the paradigm. This barrel is the only public entry point;
 * consumers should not reach into individual files.
 */
export { ObjectPool, type ObjectPoolOptions } from './ObjectPool.js';
export { createSetPool, type SetPoolOptions } from './RecyclableSet.js';
export { createArrayPool, type ArrayPoolOptions } from './RecyclableArray.js';
