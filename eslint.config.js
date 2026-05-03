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
