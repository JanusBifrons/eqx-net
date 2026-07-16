/**
 * Lint-fixture lock for the Zustand store purity rule (invariant #2) —
 * campaign 3.4 (anti-patterns review C-client 3 / Part D #21).
 *
 * The original rule exact-matched bare spatial keys (`x`, `y`, `vx`, ...), so
 * SUFFIXED coordinates (`ghostX`, `targetY`, ...) slid straight past it — the
 * store already carried `devData.serverX/beforeX/...` and `arrivalTargetX/Y`
 * under names the lint could not see. Those existing fields are all discrete /
 * gated (settings written on input blur; drawer-gated diagnostics) so they are
 * ALLOWLISTED BY NAME in the rule; anything new ending in a coordinate suffix
 * is now flagged and must either live in the render mirror or argue its way
 * onto the allowlist in `eslint.config.js`.
 *
 * The fixtures lint SYNTHETIC text at the store's real path so the flat-config
 * `files` scoping applies. Only `no-restricted-syntax` messages are counted —
 * the snippets are not meant to satisfy the rest of the ruleset.
 */
import { describe, it, expect } from 'vitest';
import { ESLint } from 'eslint';

const STORE_PATH = 'src/client/state/store.ts';

async function purityErrors(snippet: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: process.cwd() });
  const results = await eslint.lintText(snippet, { filePath: STORE_PATH, warnIgnored: false });
  return results.flatMap((r) =>
    r.messages.filter((m) => m.ruleId === 'no-restricted-syntax').map((m) => m.message),
  );
}

describe('Zustand store purity lint (invariant #2)', () => {
  it('still blocks the bare spatial keys', async () => {
    const errs = await purityErrors('export const s = { x: 1, angle: 2 };\n');
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it('blocks SUFFIXED coordinate keys (campaign 3.4 — failed pre-fix)', async () => {
    const errs = await purityErrors('export const s = { ghostX: 1, targetY: 2 };\n');
    // Pre-fix the exact-match rule saw neither key. Both must flag now.
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });

  it('permits the named discrete allowlist (settings + gated devData)', async () => {
    const errs = await purityErrors(
      'export const s = { arrivalTargetX: 0, arrivalTargetY: 0, homePosX: 0, homePosY: 0, serverX: 0, serverY: 0, beforeX: 0, beforeY: 0, afterX: 0, afterY: 0 };\n',
    );
    expect(errs).toEqual([]);
  });

  it('does not false-positive on UPPERCASE identifiers ending in X/Y', async () => {
    // The suffix heuristic requires a camelCase boundary ([a-z0-9] before X/Y),
    // so constants like MAX / BBOX_Y-style keys are not spatial coordinates.
    const errs = await purityErrors('export const s = { MAX: 1 };\n');
    expect(errs).toEqual([]);
  });
});
