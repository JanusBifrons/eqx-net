import { defineConfig } from 'vitest/config';
import base, { ART_TEST_GLOBS } from './vitest.config';

/**
 * Vitest config — the pixel-heavy art tests (`ART_TEST_GLOBS` in
 * vitest.config.ts), run via `pnpm test:art`.
 *
 * Same plugins, aliases, setup and environments as the main suite; only the
 * file set differs. The main config excludes these globs, so every test runs
 * in exactly one of the two. CI runs this in the `unit-art` job WITHOUT
 * coverage: v8 instrumentation slows their pixel loops ~6× (a livery file
 * took ~17 min on CI under coverage). Never add `--coverage` here.
 */
const baseExclude = base.test?.exclude ?? [];

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Not concatenated with the base include (mergeConfig would).
    include: ART_TEST_GLOBS,
    exclude: baseExclude.filter((g) => !ART_TEST_GLOBS.includes(g)),
  },
});
