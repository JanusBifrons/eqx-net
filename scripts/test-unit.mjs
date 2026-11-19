#!/usr/bin/env node
// `pnpm test`: the unit suite in its two vitest configs — vitest.config.ts,
// then vitest.art.config.ts (the pixel-heavy art tests, split out so CI can
// run them without coverage). Extra args (file filters, -t) go to both; with
// a filter one config may match nothing, so --passWithNoTests is added then.
// Runs vitest's own bin through node (no shell), so quoted args like
// `-t "a name"` survive on Windows.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isFullVitestRun, requireHeavyQueue, shellLine } from './dev/heavy-queue-guard.mjs';

const require = createRequire(import.meta.url);
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const args = process.argv.slice(2);
// The FULL suite is heavy (queue it); a file or -t filter stays light.
requireHeavyQueue({ kind: 'suite', command: `pnpm test ${shellLine(args)}`.trim(), full: isFullVitestRun(args) });
const filtered = args.length > 0 ? ['--passWithNoTests'] : [];
let status = 0;
for (const config of [[], ['--config', 'vitest.art.config.ts']]) {
  const r = spawnSync(process.execPath, [vitestBin, 'run', ...config, ...filtered, ...args], {
    stdio: 'inherit',
    env: process.env,
  });
  if ((r.status ?? 1) !== 0) status = r.status ?? 1;
}
process.exit(status);
