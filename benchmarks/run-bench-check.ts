/**
 * `pnpm bench:check` driver — runs the bench suite, normalises the
 * output, compares against `benchmarks/baseline.json`, and exits 0/1
 * with a human-readable verdict. Plan: perf-floor, Phase 0.
 *
 * Usage:
 *   pnpm bench:check                  # check current run vs baseline.json
 *   pnpm bench:check --update         # overwrite baseline.json with current
 *   pnpm bench:check --print          # print current run + verdict, exit 0
 *
 * Invariant: vitest 2.1.x bench mode does NOT run beforeAll hooks; every
 * bench file in this repo uses module-level setup or per-bench
 * setup/teardown. See benchmarks/README.md.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateBench,
  normaliseVitestBench,
  type BenchSample,
  type BenchVerdict,
} from './benchBudget.js';

const REPO_ROOT = process.cwd();
const BASELINE_PATH = join(REPO_ROOT, 'benchmarks', 'baseline.json');

interface BaselineFile {
  /** Schema version. Bump on shape changes. */
  v: 1;
  /** ISO timestamp of when this baseline was captured. */
  capturedAt: string;
  /** The slim per-bench aggregate records. */
  samples: BenchSample[];
}

function isUpdate(): boolean {
  return process.argv.includes('--update');
}
function isPrintOnly(): boolean {
  return process.argv.includes('--print');
}

function runVitestBench(): unknown {
  const tmp = mkdtempSync(join(tmpdir(), 'eqx-bench-check-'));
  const outFile = join(tmp, 'bench.json');
  try {
    const result = spawnSync(
      'npx',
      ['vitest', 'bench', '--run', '--outputJson', outFile],
      { stdio: 'inherit', shell: process.platform === 'win32' },
    );
    if (result.status !== 0) {
      console.error(`[bench:check] vitest bench exited ${result.status}`);
      process.exit(2);
    }
    if (!existsSync(outFile)) {
      console.error(`[bench:check] expected output at ${outFile} but it was not created`);
      process.exit(2);
    }
    const raw = readFileSync(outFile, 'utf8');
    return JSON.parse(raw) as unknown;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* noop */ }
  }
}

function loadBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_PATH)) return null;
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as BaselineFile;
  if (parsed.v !== 1) {
    console.error(`[bench:check] baseline version ${parsed.v} unsupported (expected 1)`);
    process.exit(2);
  }
  return parsed;
}

function writeBaseline(samples: BenchSample[]): void {
  const file: BaselineFile = {
    v: 1,
    capturedAt: new Date().toISOString(),
    samples: [...samples].sort((a, b) => {
      const ka = `${a.file}|${a.group}|${a.name}`;
      const kb = `${b.file}|${b.group}|${b.name}`;
      return ka.localeCompare(kb);
    }),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(file, null, 2) + '\n', 'utf8');
  console.log(`[bench:check] wrote baseline ${BASELINE_PATH} (${samples.length} samples)`);
}

function reportVerdict(verdict: BenchVerdict, head: BenchSample[]): void {
  console.log(`\n=== bench:check verdict ===`);
  console.log(`  samples: ${head.length}`);
  if (verdict.preconditionFailures.length) {
    console.log(`  PRECONDITION FAILURES:`);
    for (const p of verdict.preconditionFailures) console.log(`    - ${p}`);
  }
  for (const f of verdict.failures) {
    console.log(
      `  REGRESSION ${f.key}: HEAD ${f.head.toFixed(0)} hz vs baseline ${f.baseline.toFixed(0)} hz ` +
        `(slowdown ${f.ratio.toFixed(2)}x; margin ${f.margin}, floor ${f.floor})`,
    );
  }
  console.log(`  PASS=${verdict.pass}`);
}

function main(): void {
  console.log('[bench:check] running pnpm bench…');
  const report = runVitestBench();
  const head = normaliseVitestBench(report);
  if (head.length === 0) {
    console.error('[bench:check] no bench samples extracted — vitest output shape may have changed');
    process.exit(2);
  }

  if (isUpdate()) {
    writeBaseline(head);
    if (!isPrintOnly()) return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    if (isPrintOnly()) {
      console.log(`[bench:check] no baseline yet — printing current run.`);
      console.log(JSON.stringify(head, null, 2));
      return;
    }
    console.error(
      `[bench:check] no baseline at ${BASELINE_PATH}. Run \`pnpm bench:check --update\` to capture one.`,
    );
    process.exit(2);
  }

  const verdict = evaluateBench(head, baseline.samples);
  reportVerdict(verdict, head);

  if (isPrintOnly()) {
    process.exit(0);
  }
  process.exit(verdict.pass ? 0 : 1);
}

main();
