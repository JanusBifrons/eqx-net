/**
 * Netcode-health gate driver (plan: e2e-rebuild, Phase 1) — `pnpm e2e:netgate`.
 * Run via tsx (imports the .ts proxy in-process).
 *
 *   pnpm e2e:netgate [baselineRef] [headRef]
 *
 *   - baselineRef (default `origin/main`): always a git worktree.
 *   - headRef (default ''): a worktree at that ref; ABSENT ⇒ HEAD arm is
 *     the live working tree (the normal "did MY tree regress vs main").
 *   - NETGATE_REGRESS=1 ⇒ the HEAD-arm proxy uses the deliberately-worse
 *     PROFILE_REGRESSION_INJECT (acceptance self-test: the gate must FAIL).
 *   - NETGATE_REPS (default 3): interleaved A/B reps; the budget compares
 *     per-metric medians (one-rep host transients become outliers).
 *
 * Same-mode dev-build arms (REV 3 — prod `vite build` is broken on `main`;
 * the gate is RELATIVE so identical dev mode cancels). Each arm gets its
 * OWN in-process HTTP+WS latency proxy (independent, identically-seeded
 * realisation; supports the per-arm network-regression self-test). Step 3
 * proved the seam end-to-end; Step 4 adds the baseline arm + interleave +
 * the netHealthBudget assertion (in the spec).
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { EqxLatencyProxy } from './eqxLatencyProxy';
import { PROFILE_PRIMARY, PROFILE_REGRESSION_INJECT } from './latencyProfile';

const SERVER_PORT = 2567;
const PROXY_BASE_PORT = 2568; // baseline arm → proxy
const PROXY_HEAD_PORT = 2569; // HEAD arm → proxy
const VITE_BASE_PORT = 5274;
const VITE_HEAD_PORT = 5273;
const PORTS = [SERVER_PORT, PROXY_BASE_PORT, PROXY_HEAD_PORT, VITE_BASE_PORT, VITE_HEAD_PORT];
const isWin = process.platform === 'win32';

const baselineRef = process.argv[2] ?? 'origin/main';
const headRef = process.argv[3] ?? '';
const regress = process.env['NETGATE_REGRESS'] === '1';
const reps = process.env['NETGATE_REPS'] ?? '4';

const WT_ROOT = path.resolve('.claude/worktrees');
const BASE_WT = path.join(WT_ROOT, 'netgate-baseline');
const HEAD_WT = path.join(WT_ROOT, 'netgate-head');

function log(msg: string): void {
  console.log(`[netgate] ${msg}`);
}

function sh(cmd: string, args: string[], cwd?: string): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: isWin });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Reclaim a TCP port (repo policy: Claude owns the dev servers). */
function killPort(port: number): void {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '';
    const pids = new Set<string>();
    for (const line of out.split('\n')) {
      if (line.includes('LISTENING') && line.includes(`:${port} `)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') pids.add(pid);
      }
    }
    for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/F', '/T'], { stdio: 'ignore' });
  } else {
    spawnSync('bash', ['-c', `lsof -ti tcp:${port} | xargs -r kill -9`], { stdio: 'ignore' });
  }
}

/** Make a git worktree at `dir` point at `ref`, INCREMENTALLY — the dir
 *  (and its node_modules) persists across runs so the slow `pnpm install`
 *  is paid once, not on every acceptance/no-flake rerun. Robust to a
 *  stale/polluted dir (memory: worktree agents pollute .claude/worktrees).
 *  Returns the absolute worktree path. */
function ensureWorktree(ref: string, dir: string): string {
  const reusable = existsSync(path.join(dir, '.git')) && existsSync(path.join(dir, 'node_modules'));
  if (reusable) {
    log(`worktree ${dir} reuse → refresh to ${ref}`);
    sh('git', ['fetch', 'origin', '--quiet']);
    const co = sh('git', ['-C', dir, 'checkout', '--detach', '--force', ref]);
    const rs = sh('git', ['-C', dir, 'reset', '--hard', '--quiet', ref]);
    if (co.code === 0 && rs.code === 0) return dir;
    log(`reuse refresh failed (${co.out}${rs.out}) — rebuilding worktree`);
  }
  log(`worktree ${ref} → ${dir} (fresh)`);
  sh('git', ['worktree', 'remove', '--force', dir]);
  spawnSync(isWin ? 'cmd' : 'rm', isWin ? ['/c', 'rmdir', '/s', '/q', dir] : ['-rf', dir], {
    stdio: 'ignore',
  });
  sh('git', ['worktree', 'prune']);
  const add = sh('git', ['worktree', 'add', '--detach', dir, ref]);
  if (add.code !== 0) throw new Error(`git worktree add ${ref} failed: ${add.out}`);
  if (!existsSync(path.join(dir, 'node_modules'))) {
    log(`installing deps in ${path.basename(dir)} (frozen; warm pnpm store ⇒ mostly hardlinks)…`);
    const inst = sh('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], dir);
    if (inst.code !== 0) throw new Error(`pnpm install in ${dir} failed: ${inst.out.slice(-800)}`);
  }
  return dir;
}

/**
 * Unify the gate's MEASUREMENT HARNESS across arms (NOT netcode). Two
 * files are pure gate apparatus, not code-under-test, and MUST be
 * identical on every arm or the comparison measures the harness:
 *
 *  - `src/client/debug/ClientLogger.ts` — the Phase-0a `?diag=0`
 *    override lives only on `feat/e2e-rebuild`; `origin/main` AND
 *    `fix/wrap-up-known-issues` predate it, so an old-ref arm would run
 *    the heavy per-frame diagnostic path (the very instrumentation the
 *    incident was about) while the fixed arm doesn't.
 *  - `vite.config.ts` — carries the VITE_HMR_PORT=off knob; old refs
 *    hardcode hmr 24678 ⇒ the two dev servers collide and one arm's HMR
 *    breaks asymmetrically.
 *
 * Each arm keeps its ref's NETCODE; only the measurement apparatus is
 * unified. (vite.config.ts has no netcode logic; ClientLogger diag is
 * measurement.)
 */
const HARNESS_FILES = [
  path.join('src', 'client', 'debug', 'ClientLogger.ts'),
  'vite.config.ts',
];
function applyGateHarness(dir: string, repoRoot: string): void {
  if (path.resolve(dir) === path.resolve(repoRoot)) return; // live tree already has it
  for (const rel of HARNESS_FILES) copyFileSync(path.join(repoRoot, rel), path.join(dir, rel));
  log(`applied gate harness (ClientLogger.ts + vite.config.ts) → ${path.basename(dir)}`);
}

async function waitFor(
  label: string,
  fn: () => Promise<boolean>,
  { timeoutMs = 120_000, everyMs = 1500 } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e as Error;
    }
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
}

async function httpOk(url: string, opts?: RequestInit): Promise<Response | null> {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(4000) });
  return res.ok ? res : null;
}

function startVite(cwd: string, port: number, wsProxyPort: number): ReturnType<typeof spawn> {
  return spawn('pnpm', ['exec', 'vite', '--port', String(port), '--strictPort'], {
    cwd,
    stdio: 'ignore',
    shell: isWin,
    env: {
      ...process.env,
      VITE_WS_URL: `http://127.0.0.1:${wsProxyPort}`,
      // The gate never edits files mid-run — disable HMR entirely on
      // BOTH arms (symmetric, zero-noise; kills the 24678 collision).
      VITE_HMR_PORT: 'off',
    },
  });
}

async function main(): Promise<void> {
  let serverProc: ReturnType<typeof spawn> | undefined;
  let viteBase: ReturnType<typeof spawn> | undefined;
  let viteHead: ReturnType<typeof spawn> | undefined;
  let proxyBase: EqxLatencyProxy | undefined;
  let proxyHead: EqxLatencyProxy | undefined;
  let exitCode = 1;

  const cleanup = async (): Promise<void> => {
    log('teardown…');
    await proxyBase?.close().catch(() => undefined);
    await proxyHead?.close().catch(() => undefined);
    for (const p of [viteBase, viteHead]) {
      try {
        p?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }
    await httpOk(`http://127.0.0.1:${SERVER_PORT}/dev/shutdown`, { method: 'POST' }).catch(
      () => undefined,
    );
    await sleep(1500);
    try {
      serverProc?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    for (const p of PORTS) killPort(p);
    log('teardown complete');
  };

  process.on('SIGINT', () => {
    void cleanup().then(() => process.exit(130));
  });

  try {
    log(`baseline=${baselineRef}  head=${headRef || '(working tree)'}  reps=${reps}  regress=${regress}`);
    for (const p of PORTS) killPort(p);

    const baseDir = ensureWorktree(baselineRef, BASE_WT);
    const headDir = headRef
      ? headRef === baselineRef
        ? baseDir
        : ensureWorktree(headRef, HEAD_WT)
      : process.cwd();
    log(`HEAD arm dir: ${headDir === process.cwd() ? '(live working tree)' : headDir}`);

    // Unify the diag-off measurement harness across arms (after the
    // worktree reset, before Vite serves them).
    const repoRoot = process.cwd();
    applyGateHarness(baseDir, repoRoot);
    if (headDir !== baseDir) applyGateHarness(headDir, repoRoot);

    log('booting Colyseus server (dev:server:nowatch :2567)…');
    serverProc = spawn('pnpm', ['dev:server:nowatch'], {
      stdio: 'ignore',
      shell: isWin,
      env: process.env,
    });
    await waitFor('/healthz', async () => !!(await httpOk(`http://127.0.0.1:${SERVER_PORT}/healthz`)));
    log('server ready');

    proxyBase = new EqxLatencyProxy({
      listenPort: PROXY_BASE_PORT,
      upstreamPort: SERVER_PORT,
      profile: PROFILE_PRIMARY,
    });
    proxyHead = new EqxLatencyProxy({
      listenPort: PROXY_HEAD_PORT,
      upstreamPort: SERVER_PORT,
      profile: regress ? PROFILE_REGRESSION_INJECT : PROFILE_PRIMARY,
    });
    await proxyBase.listen();
    await proxyHead.listen();
    log(
      `proxies up: baseline :${PROXY_BASE_PORT} (PRIMARY), HEAD :${PROXY_HEAD_PORT} ` +
        `(${regress ? 'REGRESSION_INJECT — acceptance self-test' : 'PRIMARY'})`,
    );

    log('starting Vite arms (baseline :5274, HEAD :5273)…');
    viteBase = startVite(baseDir, VITE_BASE_PORT, PROXY_BASE_PORT);
    viteHead = startVite(headDir, VITE_HEAD_PORT, PROXY_HEAD_PORT);
    await waitFor(
      'Vite arms',
      async () =>
        !!(await httpOk(`http://127.0.0.1:${VITE_BASE_PORT}/`)) &&
        !!(await httpOk(`http://127.0.0.1:${VITE_HEAD_PORT}/`)),
    );
    log('both arms ready');

    const tokRes = await httpOk(`http://127.0.0.1:${SERVER_PORT}/auth/dev/test-token`, {
      method: 'POST',
    });
    if (!tokRes) throw new Error('failed to mint test token');
    const { token } = (await tokRes.json()) as { token: string };

    log(`running Playwright netcode-health gate (interleaved A/B × ${reps})…`);
    exitCode = await new Promise<number>((resolve) => {
      const pw = spawn(
        'pnpm',
        [
          'exec',
          'playwright',
          'test',
          'tests/e2e/netcode-health.spec.ts',
          '--project=gate',
          '--reporter=line',
        ],
        {
          stdio: 'inherit',
          shell: isWin,
          env: {
            ...process.env,
            CI_SKIP_WEBSERVER: '1',
            NETGATE_TOKEN: token,
            NETGATE_RUN_MS: '8000',
            NETGATE_REPS: reps,
            NETGATE_RESET_URL: `http://127.0.0.1:${SERVER_PORT}/dev/reset-sector?key=feel-test-25`,
            NETGATE_ARMS: JSON.stringify([
              { name: 'baseline', url: `http://localhost:${VITE_BASE_PORT}` },
              { name: 'HEAD', url: `http://localhost:${VITE_HEAD_PORT}` },
            ]),
          },
        },
      );
      pw.on('close', (code) => resolve(code ?? 1));
      pw.on('error', () => resolve(1));
    });
    log(`Playwright exited ${exitCode}`);
  } finally {
    await cleanup();
  }

  process.exit(exitCode);
}

main().catch(async (e) => {
  console.error(`[netgate] FATAL: ${(e as Error).stack ?? String(e)}`);
  process.exit(1);
});
