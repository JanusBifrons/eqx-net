/**
 * Netcode-health gate driver (plan: e2e-rebuild, Phase 1) — `pnpm e2e:netgate`.
 * Run via tsx (imports the .ts proxy in-process).
 *
 * STEP 3 = single-arm seam proof. Orchestrates, in order:
 *   1. reclaim stale ports (Claude owns the dev servers — kill first);
 *   2. boot the Colyseus server (dev:server:nowatch, 2567), await /healthz;
 *   3. start the HTTP+WS latency proxy in-process (2568 → 2567, PRIMARY);
 *   4. start ONE same-mode Vite DEV arm (HEAD working tree, port 5273)
 *      with VITE_WS_URL=ws://127.0.0.1:2568 so ALL Colyseus traffic
 *      (matchmake REST + WS) traverses the proxy;
 *   5. mint a JWT (POST /auth/dev/test-token) + reset feel-test-25;
 *   6. run the Playwright spec with CI_SKIP_WEBSERVER=1 (Playwright must
 *      NOT start its own webServer) + the arm/token env contract;
 *   7. ALWAYS tear everything down (proxy.close, vite kill, /dev/shutdown,
 *      port sweep) so a rerun is clean — no zombies.
 *
 * Step 4 will add the origin/main worktree arm + interleave + budget.
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { EqxLatencyProxy } from './eqxLatencyProxy';
import { PROFILE_PRIMARY } from './latencyProfile';

const SERVER_PORT = 2567;
const PROXY_PORT = 2568;
const HEAD_PORT = 5273;
const PORTS = [SERVER_PORT, PROXY_PORT, HEAD_PORT];
const isWin = process.platform === 'win32';

function log(msg) {
  console.log(`[netgate] ${msg}`);
}

/** Reclaim a TCP port (repo policy: Claude owns the dev servers). */
function killPort(port) {
  if (isWin) {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '';
    const pids = new Set();
    for (const line of out.split('\n')) {
      if (line.includes('LISTENING') && line.includes(`:${port} `)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') pids.add(pid);
      }
    }
    for (const pid of pids) {
      spawnSync('taskkill', ['/PID', pid, '/F', '/T'], { stdio: 'ignore' });
      log(`killed stale pid ${pid} on :${port}`);
    }
  } else {
    spawnSync('bash', ['-c', `lsof -ti tcp:${port} | xargs -r kill -9`], { stdio: 'ignore' });
  }
}

async function waitFor(label, fn, { timeoutMs = 45_000, everyMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      if (await fn()) return;
    } catch (e) {
      lastErr = e;
    }
    await sleep(everyMs);
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
}

async function httpOk(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(4000) });
  return res.ok ? res : null;
}

async function main() {
  let serverProc;
  let viteProc;
  let proxy;
  let exitCode = 1;

  const cleanup = async () => {
    log('teardown…');
    try {
      await proxy?.close();
    } catch {
      /* ignore */
    }
    try {
      viteProc?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    // Graceful Colyseus drain (Windows Ctrl+C is swallowed — POST is the
    // documented safe path), then a hard port sweep as a backstop.
    try {
      await httpOk(`http://127.0.0.1:${SERVER_PORT}/dev/shutdown`, { method: 'POST' });
    } catch {
      /* ignore */
    }
    await sleep(1500);
    try {
      serverProc?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
    for (const p of PORTS) killPort(p);
    log('teardown complete');
  };

  process.on('SIGINT', () => cleanup().then(() => process.exit(130)));

  try {
    log('reclaiming stale ports…');
    for (const p of PORTS) killPort(p);

    log('booting Colyseus server (dev:server:nowatch :2567)…');
    serverProc = spawn('pnpm', ['dev:server:nowatch'], {
      stdio: 'ignore',
      shell: isWin,
      env: process.env,
    });
    await waitFor('/healthz', async () => {
      const r = await httpOk(`http://127.0.0.1:${SERVER_PORT}/healthz`);
      return !!r;
    });
    log('server ready');

    log(`starting latency proxy :${PROXY_PORT} → :${SERVER_PORT} (PRIMARY ≈120ms ±60)…`);
    proxy = new EqxLatencyProxy({
      listenPort: PROXY_PORT,
      upstreamPort: SERVER_PORT,
      profile: PROFILE_PRIMARY,
    });
    await proxy.listen();

    log(`starting HEAD Vite dev arm :${HEAD_PORT} (VITE_WS_URL → proxy)…`);
    viteProc = spawn(
      'pnpm',
      ['exec', 'vite', '--port', String(HEAD_PORT), '--strictPort'],
      {
        stdio: 'ignore',
        shell: isWin,
        // http:// (NOT ws://) — the app + colyseus.js derive their HTTP
        // matchmake/auth/healthz endpoint from this URL and fetch() rejects
        // the ws scheme; colyseus.js upgrades http→ws for the room socket
        // itself. The proxy serves BOTH transports on this port.
        env: { ...process.env, VITE_WS_URL: `http://127.0.0.1:${PROXY_PORT}` },
      },
    );
    await waitFor(`Vite arm :${HEAD_PORT}`, async () => {
      const r = await httpOk(`http://127.0.0.1:${HEAD_PORT}/`);
      return !!r;
    });
    log('HEAD arm ready');

    log('minting JWT + resetting feel-test-25…');
    const tokRes = await httpOk(`http://127.0.0.1:${SERVER_PORT}/auth/dev/test-token`, {
      method: 'POST',
    });
    if (!tokRes) throw new Error('failed to mint test token');
    const { token } = await tokRes.json();
    await httpOk(`http://127.0.0.1:${SERVER_PORT}/dev/reset-sector?key=feel-test-25`, {
      method: 'POST',
    });

    log('running Playwright netcode-health spec (single-arm)…');
    // MUST be async spawn, NOT spawnSync: the latency proxy runs IN-PROCESS
    // on this Node event loop. spawnSync blocks the event loop for the
    // entire Playwright run, freezing the proxy so every browser request to
    // :2568 hangs/aborts (evidence: proxy onHttp never logged, browser got
    // net::ERR_ABORTED). Async spawn keeps the loop live so the proxy
    // serves the browser concurrently with the Playwright subprocess.
    exitCode = await new Promise<number>((resolve) => {
      const pw = spawn(
        'pnpm',
        [
          'exec',
          'playwright',
          'test',
          'tests/e2e/netcode-health.spec.ts',
          '--project=chromium',
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
            // Single-arm seam debugging: fail fast on a hang (the real
            // two-arm gate restores the long default by not setting this).
            NETGATE_TEST_TIMEOUT_MS: '55000',
            NETGATE_ARMS: JSON.stringify([{ name: 'HEAD', url: `http://localhost:${HEAD_PORT}` }]),
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
  console.error(`[netgate] FATAL: ${e.stack ?? e}`);
  process.exit(1);
});
