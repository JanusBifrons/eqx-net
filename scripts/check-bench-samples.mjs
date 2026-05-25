/**
 * Invariant-#8 bench-rung guard (plan: wrap-up-known-issues, Phase 5).
 *
 * `pnpm bench` exits 0 even when a suite produces ZERO samples — the
 * `NaNx faster than` rows. Under vitest 2.x, benchmark mode does NOT run
 * `beforeAll`/`beforeEach` suite hooks, so any `bench()` whose body
 * depends on hook-initialised state throws every iteration → no samples
 * → NaN stats. A green `pnpm bench` was therefore a hollow rung: the
 * perf-budget-relevant suites (physics-tick, swarm-broadcast,
 * persistence-worker) measured nothing while the pure-sync micro-benches
 * (spring, weapon-hittest) looked fine.
 *
 * This guard runs the real bench suite to JSON and FAILS (exit 1) if any
 * benchmark has no samples or non-finite stats — so a regressed/hollow
 * bench can never silently pass CI again.
 *
 * Usage: `node scripts/check-bench-samples.mjs`  (alias: `pnpm bench:check`)
 */
import { execSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const out = join(mkdtempSync(join(tmpdir(), 'eqx-bench-')), 'bench.json');

try {
  // Shell string (not execFileSync) so `pnpm` resolves via the shim on
  // every platform — `pnpm.cmd` + execFileSync needs shell:true on
  // Windows and silently fails without it.
  execSync(`pnpm exec vitest bench --run --outputJson="${out}"`, { stdio: 'inherit' });
} catch {
  // vitest itself failed (compile/runtime) — that is a hard fail too.
  console.error('\n[bench-check] vitest bench did not complete cleanly.');
  process.exit(1);
}

const report = JSON.parse(readFileSync(out, 'utf8'));
rmSync(out, { force: true });

/** @type {{file:string,name:string,reason:string}[]} */
const hollow = [];
let total = 0;

for (const file of report.files ?? []) {
  for (const group of file.groups ?? []) {
    for (const b of group.benchmarks ?? []) {
      total++;
      const sampleCount = b.sampleCount ?? (Array.isArray(b.samples) ? b.samples.length : 0);
      if (!sampleCount || sampleCount <= 0) {
        hollow.push({ file: file.filepath, name: b.name, reason: 'zero samples' });
      } else if (!Number.isFinite(b.hz) || !Number.isFinite(b.mean)) {
        hollow.push({ file: file.filepath, name: b.name, reason: `non-finite stats (hz=${b.hz}, mean=${b.mean})` });
      }
    }
  }
}

if (total === 0) {
  console.error('[bench-check] no benchmarks found in the report — bench discovery broke.');
  process.exit(1);
}

if (hollow.length > 0) {
  console.error(`\n[bench-check] ${hollow.length}/${total} benchmark(s) are HOLLOW (invariant #8 rung is fake):`);
  for (const h of hollow) console.error(`  ✗ ${h.name}  (${h.reason})  — ${h.file}`);
  console.error('\nLikely cause: a beforeAll/beforeEach hook (vitest 2.x bench mode does not run them).');
  process.exit(1);
}

console.log(`\n[bench-check] OK — all ${total} benchmarks produced samples.`);
