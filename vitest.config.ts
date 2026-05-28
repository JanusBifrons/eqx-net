import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vitest config — main (unit + component + scenario) suite.
 *
 * - `pnpm test`              -> this config (default `vitest.config.ts`)
 * - `pnpm test:integration`  -> `vitest.integration.config.ts` (Phase A1+)
 * - `pnpm bench`             -> benchmarks (.bench.ts)
 *
 * Integration tests live under `tests/integration/` and run in a separate
 * vitest invocation because they need a different pool configuration
 * (Colyseus's process-level handlers fight with isolated fork workers —
 * see vitest.integration.config.ts for the full incident report).
 *
 * Per-file environment selection via `environmentMatchGlobs`:
 *   - `*.test.tsx` ⇒ jsdom (component tests need a DOM)
 *   - everything else ⇒ node (server logic, schemas, helpers — fastest)
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@shared-types': path.resolve(__dirname, 'src/shared-types'),
    },
  },
  test: {
    environment: 'node',
    environmentMatchGlobs: [
      ['src/**/*.test.tsx', 'jsdom'],
    ],
    setupFiles: ['./vitest.setup.ts'],
    globals: false,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'tests/unit/**/*.test.ts',
      // Stage 4.5 — scenario-harness regression fixtures (network-feel roadmap).
      'tests/scenarios/**/*.test.ts',
      // Netcode-health gate pure modules (plan: e2e-rebuild). Lives OUTSIDE
      // tests/e2e/ so Playwright (testDir ./tests/e2e, default *.test.ts
      // match) does not collide-collect these vitest units; the Playwright
      // spec imports the pure modules from here.
      'tests/netgate/**/*.test.ts',
      // Bench-budget pure module unit lock (plan: perf-floor, Phase 0).
      // The .bench.ts files in this directory are still excluded from the
      // unit run via the `benchmark.include` glob below — only .test.ts
      // files match this entry.
      'benchmarks/**/*.test.ts',
      // Perf-capture / perfBudget pure module unit locks (plan: perf-floor,
      // Phases 2 + 5). The .spec.ts Playwright spec lives in the same
      // directory but is excluded by the .test.ts-only match.
      'tests/perf/**/*.test.ts',
      // Mobile-perf budget pure module unit lock. Same pattern as
      // tests/netgate and tests/perf — vitest matches *.test.ts only,
      // Playwright matches *.spec.ts only in `playwright.mobile-perf.config.ts`.
      'tests/mobile-perf/**/*.test.ts',
      // Capture-driven replay harness + user-contract assertions
      // (plan: capture-driven replay infra, Phases C-F, 2026-05-21).
      // Drives the REAL ColyseusGameClient through captured on-device
      // sessions deterministically — the missing piece that lets a
      // smoke-test capture become a regression-locked test.
      'tests/replay/**/*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      'dist/**',
      // Agent worktrees under .claude/worktrees/<id> hold duplicated
      // *.test.ts (+ dist/*.test.js) — exclude so the parent suite does
      // not double-discover / fail to parse them.
      '**/.claude/**',
      'tests/e2e/**',
      // benchmarks/**/*.bench.ts is excluded by include-glob (matches only
      // *.test.ts); benchmarks/**/*.test.ts IS included (plan: perf-floor).
      // Phase A1 — integration tests run via `pnpm test:integration`.
      'tests/integration/**',
      // GC/heap-delta tests need --expose-gc + serial execution; they
      // live under vitest.gc.config.ts and run via `pnpm test:gc`
      // (plan: quirky-rabbit, Phase 1).
      '**/*.heapDelta.test.ts',
    ],
    benchmark: {
      include: ['benchmarks/**/*.bench.ts'],
    },
    // Coverage: dev-only v8 instrumentation over the UNIT suite (integration
    // and e2e are excluded by `exclude` above and run separately). Added for
    // the Architect's Master Directive — makes "coverage >= baseline" an
    // objective, falsifiable Phase-2 gate. See MANIFEST_APPARATUS.md §3.
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.test.tsx',
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        'src/**/__fixtures__/**',
      ],
    },
  },
});
