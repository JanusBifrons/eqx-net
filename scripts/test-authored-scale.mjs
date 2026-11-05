#!/usr/bin/env node
// Runs the tests that lock AUTHORED 1× ship numbers (gated on
// AT_AUTHORED_SHIP_SCALE) at 1×, profile A. The shipping default is 2× B, so a
// plain `pnpm test` skips them; CI runs this as a separate step.
// See docs/architecture/ship-scale.md.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.test\.tsx?$/.test(e.name) && !e.name.includes('.integration.')
      && readFileSync(p, 'utf8').includes('runIf(AT_AUTHORED_SHIP_SCALE)')) files.push(p.replaceAll('\\', '/'));
  }
};
walk('src');
walk('tests/unit');
if (files.length === 0) {
  console.error('test-authored-scale: no gated test files found');
  process.exit(1);
}
console.log(`test-authored-scale: ${files.length} file(s) at EQX_SHIP_SCALE=1 EQX_SHIP_TUNING=A`);
const r = spawnSync('pnpm', ['exec', 'vitest', 'run', ...files], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, EQX_SHIP_SCALE: '1', EQX_SHIP_TUNING: 'A', EQX_SHIP_KIND_SCALE: '' },
});
process.exit(r.status ?? 1);
