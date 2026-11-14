import { defineConfig } from 'vitest/config';
import integration from './vitest.integration.config';

/**
 * Integration tests under the real-scale naval range switch
 * (`EQX_NAVAL_RANGE=real`, docs/architecture/real-scale-ranges.md). The
 * weapon catalogue is built once at module load and the integration pool
 * shares one worker (no isolation), so these tests need their own run with
 * the env set before anything loads: `pnpm test:naval-real`. `real` is also
 * the default now; this run pins it explicitly so these tests stay put if the
 * default ever moves. The plain integration run excludes them.
 */
process.env['EQX_NAVAL_RANGE'] = 'real';

export default defineConfig({
  ...integration,
  test: {
    ...integration.test,
    // Not concatenated with the integration include (mergeConfig would).
    include: ['tests/integration/navalReal/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'dist/**', '**/.claude/**'],
    env: { EQX_NAVAL_RANGE: 'real' },
  },
});
