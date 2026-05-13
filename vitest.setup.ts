/**
 * Vitest setup. Loaded once before every test file via `vitest.config.ts`
 * `setupFiles`. Per-file env (node vs jsdom) is selected via the
 * `environmentMatchGlobs` rule in the same config:
 *
 *   - `*.test.tsx` ⇒ jsdom (component tests need a DOM)
 *   - everything else ⇒ node (default, unchanged from Phase 0)
 *
 * We only register `@testing-library/jest-dom` matchers when we're in
 * a DOM environment so the node-environment tests don't pay the cost.
 */
import { afterEach } from 'vitest';

// `globalThis.document` only exists under the jsdom environment. Guarding
// avoids importing `@testing-library/*` (which depends on browser APIs)
// inside node-env tests.
if (typeof document !== 'undefined') {
  // Dynamic import keeps these out of the node-env code path entirely.
  // jest-dom v6+ exports matchers as named exports, not default.
  const matchers = await import('@testing-library/jest-dom/matchers');
  const { expect } = await import('vitest');
  expect.extend(matchers as unknown as Parameters<typeof expect.extend>[0]);
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());
}
