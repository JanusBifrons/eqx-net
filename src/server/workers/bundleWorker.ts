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
export async function bundleWorker(opts: {
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
    sourcemap: 'inline',
  });
  return result.outputFiles[0]!.text;
}
