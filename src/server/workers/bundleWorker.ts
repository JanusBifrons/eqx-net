import { build } from 'esbuild';

/**
 * Bundle a `worker_threads` entrypoint to a self-contained CJS string at
 * runtime. Reused by:
 *   - `SectorRoom.spawnWorker()` for the physics worker (with Rapier external).
 *   - `PersistenceWorker.initWorker()` for the DB worker (no externals).
 *
 * tsx's ESM loader hook does not reliably rewrite `.js`-extension imports
 * inside `worker_threads` on Node v22+; esbuild bundling sidesteps the
 * loader entirely. See `docs/LESSONS.md` and the `feedback_worker_tsx.md`
 * memory entry for the full incident report.
 */
// One bundle per (entry, externals): every SectorRoom spawns the same physics
// worker, so re-running esbuild per room only cost boot time and held one more
// copy of the code string. Caching the PROMISE also dedupes concurrent calls.
const bundleCache = new Map<string, Promise<string>>();

export function bundleWorker(opts: {
  entryPoint: string;
  external?: string[];
}): Promise<string> {
  const key = `${opts.entryPoint}|${(opts.external ?? []).join(',')}`;
  let cached = bundleCache.get(key);
  if (!cached) {
    cached = buildWorker(opts);
    bundleCache.set(key, cached);
    // A failed build must not poison the cache for later callers.
    cached.catch(() => bundleCache.delete(key));
  }
  return cached;
}

async function buildWorker(opts: {
  entryPoint: string;
  external?: string[];
}): Promise<string> {
  const result = await build({
    entryPoints: [opts.entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
    external: opts.external ?? [],
    // Inline maps are ~75% of the bundle and are held in every worker's
    // memory; keep them for dev stack traces only.
    sourcemap: process.env['NODE_ENV'] === 'production' ? false : 'inline',
  });
  return result.outputFiles[0]!.text;
}
