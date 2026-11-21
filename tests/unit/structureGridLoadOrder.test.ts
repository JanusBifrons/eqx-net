/**
 * The structure grid modules load under native ES modules from any entry.
 *
 * `cableCurve.ts`, `Grid.ts` and `socketReseat.ts` form an import cycle. The
 * client reaches it through `cableCurve.ts` first (`previewConn.ts`,
 * `mirrorToGridNode.ts`), so `socketReseat.ts` runs before `cableCurve.ts`
 * has. A module on the cycle that reads a binding cableCurve re-exports at
 * load time then throws a TDZ ReferenceError in the browser, and the client
 * never boots (netgate: "Ships: 0" forever). vitest's module runner does not
 * keep native cycle semantics, so this test loads each entry in a fresh Node
 * process (tsx loader, real ESM).
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(__dirname, '../..');
const ENTRIES = [
  'src/core/structures/cableCurve.ts',
  'src/core/structures/Grid.ts',
  'src/core/structures/socketReseat.ts',
  'src/client/render/pixi/previewConn.ts',
  'src/client/structures/mirrorToGridNode.ts',
];

describe('structure grid modules load under native ESM from any entry', () => {
  for (const entry of ENTRIES) {
    it(`loads with ${entry} first`, () => {
      const url = pathToFileURL(path.join(ROOT, entry)).href;
      const res = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(url)});`], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(res.stderr.split('\n').find((l) => /Error/.test(l)) ?? '').toBe('');
      expect(res.status).toBe(0);
    }, 70_000);
  }
});
