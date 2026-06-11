import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config — integration tests (Phase A1+).
 *
 * Why a separate config? Integration tests spin up a real Colyseus
 * `Server` + `SectorRoom` + WebSocket transport per test. The default
 * vitest config breaks for these tests in three ways:
 *
 *  1. **Module resolution** — `SectorRoom` transitively imports
 *     `node:sqlite` (via `Database.ts` → `PersistenceWorker.ts`). Vite's
 *     resolver mishandles the `node:` prefix in some configurations,
 *     failing with `Failed to load url sqlite`. We alias it to a no-op
 *     `DatabaseSync` stub since the harness stubs the persistence layer
 *     at a higher boundary (`setPersistence`, `setLimboStore`,
 *     `setPlayerShipStore`).
 *
 *  2. **Decorators** — `@colyseus/schema@3.x` uses legacy
 *     `experimentalDecorators`. The default esbuild transform applies
 *     TC39 stage-3 decorators, which silently turn `@type('boolean')`
 *     calls into no-ops. We pass `tsconfigRaw` to opt esbuild into the
 *     legacy mode for these tests.
 *
 *  3. **Pool** — Colyseus's `registerGracefulShutdown` installs a
 *     `process.on('uncaughtException')` handler that crashes test
 *     teardown if test results contain `@colyseus/schema` instances
 *     (those aren't `structuredClone`-able across worker IPC). Pinned to
 *     `threads` with `singleThread: true, isolate: false` so everything
 *     stays in one worker — no IPC, no serialization, no crash.
 *
 * Running the main suite with these settings would break tests that
 * rely on `process.chdir()` (workers don't support it — e.g.
 * `src/server/routes/diagRouter.test.ts`). So integration tests live in
 * their own config invoked via `pnpm test:integration`.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared-types': path.resolve(__dirname, 'src/shared-types'),
      'node:sqlite': path.resolve(__dirname, 'tests/integration/sectorRoom/sqliteStub.ts'),
    },
  },
  esbuild: {
    target: 'es2022',
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
        useDefineForClassFields: false,
      },
    },
  },
  test: {
    environment: 'node',
    globals: false,
    // CI-only flake shield: a real Colyseus server + WS transport per test
    // means runner-load transients (socket hang up / ECONNRESET) can fail a
    // test the code didn't break — the same class the harness's bounded
    // matchmake retry and the netgate's auto-retry ride out. Two retries on
    // CI; locally zero so flakes stay loud during development.
    retry: process.env.CI ? 2 : 0,
    include: [
      'tests/integration/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', 'dist/**', '**/.claude/**'],
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
        isolate: false,
      },
    },
  },
});
