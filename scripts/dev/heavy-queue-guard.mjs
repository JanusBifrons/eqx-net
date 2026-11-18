/**
 * Heavy-job queue guard: heavy entry points (showcase, perf:scenes, netgate,
 * the full unit suite, a full integration or e2e run) refuse to start unless
 * they run under `pnpm heavy run`, which sets EQX_HEAVY_QUEUE on its child.
 * Rule: docs/ops/agent-workflow.md "Heavy-job queue". Pure logic is exported
 * for tests/unit/heavy-queue-guard.test.ts.
 *
 * Never blocks: CI (GitHub Actions sets CI), EQX_HEAVY_QUEUE_SKIP=1 (debug
 * escape), or a light run (a file filter, -t, --grep, --list).
 * No shebang on purpose (CRLF checkouts break vitest imports).
 */

/** Why a heavy entry point may run (or not). */
export function guardDecision({ env = process.env, full = true } = {}) {
  if (env.EQX_HEAVY_QUEUE) return { block: false, reason: 'queued' };
  if (env.CI) return { block: false, reason: 'ci' };
  if (env.EQX_HEAVY_QUEUE_SKIP === '1') return { block: false, reason: 'skip' };
  if (!full) return { block: false, reason: 'light' };
  return { block: true, reason: 'unqueued' };
}

// Flags whose value is the NEXT token (so that token is not a file filter).
const VITEST_VALUE_FLAGS = new Set([
  '--config', '-c', '--root', '-r', '--dir', '--reporter', '--pool', '--shard', '--project',
  '--maxWorkers', '--minWorkers', '--outputFile', '--environment', '--mode', '--retry', '--testTimeout',
]);
const VITEST_FILTER_FLAGS = new Set(['-t', '--testNamePattern', '--changed', '--related']);

const PLAYWRIGHT_VALUE_FLAGS = new Set([
  '--project', '--config', '-c', '--workers', '-j', '--reporter', '--retries', '--repeat-each',
  '--shard', '--timeout', '--max-failures', '--output', '--trace', '--global-timeout',
]);
const PLAYWRIGHT_LIGHT_FLAGS = new Set([
  '-g', '--grep', '--grep-invert', '--list', '--ui', '--last-failed', '--only-changed', '--debug',
]);

/**
 * True when nothing narrows the run. An unknown token counts as a filter, so
 * a mis-read always leans to "light" (never blocks a single-file run).
 */
function noFilter(args, valueFlags, lightFlags) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    const name = a.split('=')[0];
    if (lightFlags.has(name)) return false;
    if (a.startsWith('-')) {
      if (!a.includes('=') && valueFlags.has(name)) i++;
      continue;
    }
    return false; // positional = file filter
  }
  return true;
}

/** Vitest args (after `vitest`, or the extra args of `pnpm test`): full suite? */
export function isFullVitestRun(args) {
  let rest = args;
  if (rest[0] === 'related') return false;
  if (rest[0] === 'run' || rest[0] === 'watch' || rest[0] === 'dev') rest = rest.slice(1);
  return noFilter(rest, VITEST_VALUE_FLAGS, VITEST_FILTER_FLAGS);
}

/** Playwright CLI args (process.argv.slice(2)): a full `playwright test` run? */
export function isFullPlaywrightRun(args) {
  if (args[0] !== 'test') return false; // workers, show-report, install, ...
  return noFilter(args.slice(1), PLAYWRIGHT_VALUE_FLAGS, PLAYWRIGHT_LIGHT_FLAGS);
}

/** Join argv for a copy-paste shell line. */
export function shellLine(args) {
  return args.map((a) => (/^[\w@%+=:,./\\*-]+$/.test(a) ? a : `"${String(a).replace(/"/g, '\\"')}"`)).join(' ');
}

/** The refusal text, with the exact queued command to use instead. */
export function refusalMessage(kind, command) {
  return [
    `[heavy-queue] refused: this is a heavy job and it was not started through the shared queue.`,
    `  Run it as:  pnpm heavy run --kind ${kind} --who <label> -- ${command}`,
    `  (use run_in_background; see docs/ops/agent-workflow.md "Heavy-job queue")`,
    `  Debug escape (never for real runs): EQX_HEAVY_QUEUE_SKIP=1`,
  ].join('\n');
}

/** Exit(1) with the refusal unless guardDecision lets this run through. */
export function requireHeavyQueue({ kind, command, full = true, env = process.env }) {
  const d = guardDecision({ env, full });
  if (!d.block) return d;
  process.stderr.write(`${refusalMessage(kind, command)}\n`);
  process.exit(1);
}
