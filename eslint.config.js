import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

/**
 * Zone import boundaries (see docs/blueprint.md and plan file).
 *
 * These patterns are the single source of truth for CI-enforced "no web leaks."
 * Any violation fails the build before it can be merged. Keep this list in
 * sync with the Technology Stack Matrix in the root CLAUDE.md.
 */
const coreForbidden = [
  'pixi.js',
  'pixi.js/*',
  'pixi-viewport',
  'react',
  'react-dom',
  '@mui/*',
  '@emotion/*',
  'howler',
  'zustand',
  'colyseus',
  'colyseus.js',
  'better-sqlite3',
  'express',
  'pino',
  'node:fs',
  'node:fs/*',
  'node:http',
  'node:https',
  'fs',
  'http',
  'https',
];

const serverForbidden = [
  'pixi.js',
  'pixi.js/*',
  'pixi-viewport',
  'react',
  'react-dom',
  '@mui/*',
  '@emotion/*',
  'howler',
  'zustand',
  'colyseus.js',
];

const clientForbidden = [
  'colyseus',
  '@colyseus/ws-transport',
  'better-sqlite3',
  'express',
  'pino',
  'worker_threads',
  'node:worker_threads',
  'fs',
  'node:fs',
  'node:fs/*',
  'http',
  'node:http',
];

export default [
  {
    ignores: [
      'dist/**',
      // Agent worktrees (.claude/worktrees/<id>) are transient nested git
      // clones incl. their dist/ build output; `eslint .` would recurse
      // into them and flag compiled JS. Nothing under .claude is project
      // source — never lint it.
      '.claude/**',
      'node_modules/**',
      '.pnpm-store/**',
      'playwright-report/**',
      'test-results/**',
      'scripts/**',
      'diag/**',
      '**/*.disabled',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
      globals: {
        // TypeScript handles undefined-identifier checks with full type info;
        // ESLint's no-undef is redundant and fights against ambient globals.
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-unused-vars': 'off',
      'no-undef': 'off',
      // B5 (plan squishy-canyon, R7): app code routes through pino (server) /
      // ClientLogger (client), never raw console. The legitimate console homes
      // (the ClientLogger sink itself, the render/physics workers which have no
      // DOM logger, debug utilities, offscreen spikes, tests, scripts) are
      // allow-listed in the override block below. Adding the rule IS the
      // regression test for the sweep. console.profile/profileEnd are CDP
      // profiler controls (not logging) and stay allowed everywhere.
      'no-console': ['error', { allow: ['profile', 'profileEnd'] }],
    },
  },
  {
    // Legitimate console homes — see the no-console rationale above.
    files: [
      '**/*.test.{ts,tsx}',
      '*.config.{ts,js}',
      'tests/**',
      'scripts/**',
      'benchmarks/**',
      'src/client/debug/**',
      'src/client/__offscreen-spike__/**',
      'src/client/render/worker/**/*.ts',
      'src/core/physics/worker.ts',
    ],
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...coreForbidden.map((p) => ({
              group: [p],
              message: `src/core must remain zone-pure (no DOM, no server-only APIs). Forbidden import: ${p}. See root CLAUDE.md.`,
            })),
            {
              group: ['**/src/server/**', '../server/**', '../../server/**'],
              message: 'src/core must not import from src/server. Use a core contract (IRenderer, INetworkSink, ...) and inject from the server zone.',
            },
            {
              group: ['**/src/client/**', '../client/**', '../../client/**'],
              message: 'src/core must not import from src/client. Use a core contract and inject from the client zone.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/server/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...serverForbidden.map((p) => ({
              group: [p],
              message: `src/server must not import client-only libraries. Forbidden: ${p}.`,
            })),
            {
              group: ['**/src/client/**', '../client/**', '../../client/**'],
              message: 'src/server must not import from src/client.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/client/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...clientForbidden.map((p) => ({
              group: [p],
              message: `src/client must not import server-only libraries or Node-only APIs. Forbidden: ${p}.`,
            })),
            {
              group: ['**/src/server/**', '../server/**', '../../server/**'],
              message: 'src/client must not import from src/server.',
            },
          ],
        },
      ],
      // A no-argument `useUIStore()` subscribes the component to the ENTIRE
      // store, re-rendering it on every write. In a component that renders the
      // HUD subtree (GameSurface), that cascaded an Emotion/MUI re-render storm
      // that pegged the main thread during combat — the on-device "lag"
      // (CPU profile 2026-06-06: ~44% React+MUI+Emotion vs ~9% Pixi). Always
      // pass a selector: `useUIStore((s) => s.thing)`. Setters are stable refs,
      // so selecting them never triggers a re-render. See root CLAUDE.md #2.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='useUIStore'][arguments.length=0]",
          message: 'Do not call useUIStore() with no selector — it subscribes to the WHOLE store and re-renders on every write (Emotion/MUI re-render storm = the 2026-06-06 combat lag). Pass a selector: useUIStore((s) => s.x). Setters are stable, so selecting them never re-renders.',
        },
      ],
    },
  },
  {
    // Renderer worker boundary (Phase 3 of the OffscreenCanvas migration).
    // The worker has no DOM, no React, no MUI, no Zustand. Importing any
    // of these would either fail at runtime or smuggle DOM dependencies
    // into the worker bundle. The protocol in `protocol.ts` is the only
    // sanctioned communication channel. See
    // `~/.claude/plans/humble-strolling-coral.md` Phase 3.
    files: ['src/client/render/worker/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...clientForbidden.map((p) => ({
              group: [p],
              message: `Renderer worker must not import server-only libraries or Node-only APIs. Forbidden: ${p}.`,
            })),
            {
              group: ['react', 'react-dom', 'react/*', 'react-dom/*'],
              message: 'Renderer worker has no DOM — React is not available. Render via Pixi only. Communicate with main thread via the protocol in protocol.ts.',
            },
            {
              group: ['@mui/*', '@emotion/*'],
              message: 'Renderer worker has no DOM — MUI/emotion are not usable. Move UI to main-thread React or expose a state field via the protocol.',
            },
            {
              group: ['zustand', 'zustand/*'],
              message: 'Renderer worker must not subscribe to Zustand directly — state crosses the boundary via the protocol. Main thread reads Zustand and posts the resulting messages.',
            },
            {
              group: ['**/src/server/**', '../server/**', '../../server/**'],
              message: 'Renderer worker must not import from src/server.',
            },
          ],
        },
      ],
    },
  },
  {
    // Zustand store purity: no spatial fields in the UI state.
    // See root CLAUDE.md cross-phase invariant #2.
    files: ['src/client/state/store.ts', 'src/client/state/store.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Property[key.name=/^(x|y|vx|vy|angle|rotation|position|velocity)$/]",
          message: 'Spatial fields (x, y, vx, vy, angle, rotation, position, velocity) must NEVER appear in the Zustand store. They belong in the render state mirror polled by Pixi. See root CLAUDE.md invariant #2.',
        },
      ],
    },
  },
];
