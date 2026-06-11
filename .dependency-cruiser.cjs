/**
 * dependency-cruiser ruleset — encodes Cross-Phase Invariant #1 (zone boundary
 * integrity) as a real module graph, complementing the string-pattern ESLint
 * `no-restricted-imports` rules (plan squishy-canyon, C1 — closes the
 * MANIFEST_APPARATUS §2 acknowledged gap).
 *
 * The canary fixture src/core/__fixtures__/leak.ts.disabled exists to prove this
 * is live: rename it to `.ts` and `pnpm exec depcruise src` must go red on
 * `core-stays-pure`.
 */
module.exports = {
  forbidden: [
    {
      name: 'core-stays-pure',
      severity: 'error',
      comment: 'src/core must not import from src/client or src/server (invariant #1). Use a core contract + inject.',
      from: { path: '^src/core' },
      to: { path: '^src/(client|server)' },
    },
    {
      name: 'core-no-ui-or-node-libs',
      severity: 'error',
      comment: 'src/core must not import client/UI or Node-only libraries (invariant #1). This is what the leak.ts.disabled canary trips.',
      from: { path: '^src/core' },
      to: { path: 'node_modules/(pixi\\.js|pixi-viewport|react|react-dom|@mui|@emotion|howler|zustand|colyseus|@colyseus|express)(/|$)' },
    },
    {
      name: 'server-not-client',
      severity: 'error',
      comment: 'src/server must not import from src/client.',
      from: { path: '^src/server' },
      to: { path: '^src/client' },
    },
    {
      name: 'client-not-server',
      severity: 'error',
      comment: 'src/client must not import from src/server.',
      from: { path: '^src/client' },
      to: { path: '^src/server' },
    },
    {
      name: 'shared-types-pure',
      severity: 'error',
      comment: 'src/shared-types is a leaf contract zone — it must not import core/client/server.',
      from: { path: '^src/shared-types' },
      to: { path: '^src/(core|client|server)' },
    },
    {
      name: 'render-worker-no-ui',
      severity: 'error',
      comment: 'The render worker has no DOM — it must not import react / react-dom / @mui / @emotion / zustand.',
      from: { path: '^src/client/render/worker' },
      to: { path: 'node_modules/(react|react-dom|@mui|@emotion|zustand)' },
    },
    {
      name: 'no-circular',
      severity: 'warn',
      comment: 'Circular dependencies make the graph hard to reason about; flagged as a warning.',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    // Record edges INTO node_modules (so core→pixi.js is evaluated against the
    // rules) but don't recurse through them. Note: NOT `exclude` — excluding
    // would drop those edges from the graph and the canary would pass.
    doNotFollow: { path: 'node_modules' },
  },
};
