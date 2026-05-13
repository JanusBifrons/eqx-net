/**
 * Phase A4 — Stryker mutation-testing configuration.
 *
 * Scope: the transit-orchestrator subsystem (the densest-tested
 * module in the repo today, ~430 lines of TransitOrchestrator.test.ts
 * with 21+ cases). Mutation testing this slice first establishes a
 * baseline mutation score and validates the test methodology before
 * we expand to other modules.
 *
 * Run with: `pnpm mutation` (or `pnpm stryker run`).
 *
 * **Why limit scope** — full-suite mutation would take hours. By
 * pinning `mutate` to two source files (TransitOrchestrator.ts +
 * sessionRegistry.ts), each run is under a minute. Target mutation
 * score: >85% killed. Below that means tests pass even when the code
 * is wrong — gaps to fix.
 *
 * **When to expand** — add files to `mutate` after they accumulate
 * dense test coverage (>200 lines of test per source file, or full
 * branch coverage from a single test). Premature mutation testing
 * (low-coverage modules) produces a misleadingly low score and wastes
 * dev time chasing kills.
 *
 * **Known caveats**:
 *  - The TransitOrchestrator tests use `vi.useFakeTimers()`. Stryker
 *    runs each mutant in isolation; if a mutant's behaviour changes
 *    timing (e.g. swallows a setTimeout), the test may TIMEOUT instead
 *    of failing — that still counts as "killed" but takes 8 s per
 *    mutant. Hence the per-mutant 8 s timeout.
 *  - The Colyseus `matchMaker` is imported transitively; Stryker may
 *    try to mutate it. The `mutate` glob is deliberately tight to
 *    avoid touching node_modules.
 */
export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.config.ts',
  },
  mutate: [
    'src/server/transit/TransitOrchestrator.ts',
    'src/server/transit/sessionRegistry.ts',
  ],
  checkers: ['typescript'],
  tsconfigFile: 'tsconfig.server.json',
  timeoutMS: 8000,
  // Vitest is single-process when invoked this way; running multiple
  // mutant runners in parallel would race on a shared vitest state.
  concurrency: 1,
  thresholds: {
    high: 85,
    low: 70,
    break: 60,
  },
  reporters: ['progress', 'clear-text', 'html'],
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
};
