/**
 * Phone lane CLI: play a production build on the owner's phone through a
 * Cloudflare quick tunnel. Guide: docs/ops/phone-link.md.
 *
 *   pnpm phone up [--dir <checkout>]   (re)start the game behind the tunnel; prints today's link
 *   pnpm phone down                    stop the game AND the tunnel
 *   pnpm phone status
 *
 * The tunnel outlives `up` and is reused while it lives (same address, same
 * key). `up` replaces whatever build the lane served before, whichever session
 * started it. Server + client come from showcase/servers.ts (CaptureServers,
 * preview mode); the previous lane's processes are reaped through
 * showcase/tools.ts (`reapStale`, image-checked) using the lane's own pid file.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CaptureServers } from '../../showcase/servers.js';
import { imageOf, reapStale, sleep } from '../../showcase/tools.js';
import { PHONE_COOKIE, PHONE_PORTS, TUNNEL_METRICS, newKey, parseTunnelUrl, resolvePhoneDir } from './phone-lane-core.mjs';

const CLOUDFLARED_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';

interface Tunnel { pid: number; url: string; key: string; startedAt: string }
interface State { tunnel?: Tunnel; game?: { dir: string; sha: string; startedAt: string } }

const DIR = resolvePhoneDir();
const RUN = path.join(DIR, 'run');
const STATE = path.join(DIR, 'state.json');
const CLOUDFLARED = path.join(DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
mkdirSync(RUN, { recursive: true });
// The lane's own pid file: showcase runs never reap the lane, and vice versa.
process.env['EQX_SHOWCASE_PID_FILE'] = path.join(DIR, 'game-pids.json');

const log = (msg: string): void => { process.stdout.write(`[phone] ${msg}\n`); };

function readState(): State {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) as State; } catch { return {}; }
}
function writeState(s: State): void {
  writeFileSync(STATE, JSON.stringify(s, null, 2));
}

async function tunnelAlive(t: Tunnel | undefined): Promise<boolean> {
  if (!t || imageOf(t.pid) !== path.basename(CLOUDFLARED).toLowerCase()) return false;
  const r = await fetch(`http://${TUNNEL_METRICS}/ready`).catch(() => null);
  return r?.ok === true;
}

async function ensureCloudflared(): Promise<void> {
  if (existsSync(CLOUDFLARED)) return;
  if (process.platform !== 'win32') throw new Error(`put a cloudflared binary at ${CLOUDFLARED}`);
  log(`downloading cloudflared (official release) to ${CLOUDFLARED} ...`);
  const r = await fetch(CLOUDFLARED_URL);
  if (!r.ok) throw new Error(`cloudflared download failed: HTTP ${r.status}`);
  writeFileSync(CLOUDFLARED, Buffer.from(await r.arrayBuffer()));
}

async function startTunnel(): Promise<Tunnel> {
  await ensureCloudflared();
  const logFile = path.join(RUN, 'tunnel.log');
  rmSync(logFile, { force: true });
  const fd = openSync(logFile, 'a');
  const child = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--metrics', TUNNEL_METRICS, '--url', `http://localhost:${PHONE_PORTS.vite}`], {
    detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  child.unref();
  if (!child.pid) throw new Error('cloudflared did not start');
  const end = Date.now() + 60_000;
  let url: string | undefined;
  while (!url) {
    if (Date.now() > end) throw new Error(`no tunnel address within 60 s; see ${logFile}`);
    await sleep(500);
    url = parseTunnelUrl(readFileSync(logFile, 'utf8'));
  }
  const tunnel = { pid: child.pid, url, key: newKey(), startedAt: new Date().toISOString() };
  while (!(await tunnelAlive(tunnel))) {
    if (Date.now() > end) throw new Error(`tunnel never connected; see ${logFile}`);
    await sleep(500);
  }
  return tunnel;
}

/** Pid listening on `port`, or undefined. */
function listener(port: number): number | undefined {
  const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '';
  for (const line of out.split(/\r?\n/)) {
    if (line.includes('LISTENING') && new RegExp(`[:.]${port}\\s`).test(line)) {
      const pid = Number(line.trim().split(/\s+/).pop());
      if (pid > 0) return pid;
    }
  }
  return undefined;
}

/** After reaping, the lane's ports must be free: anything still there is not ours. */
function assertPortsFree(): void {
  for (const port of [PHONE_PORTS.server, PHONE_PORTS.vite]) {
    const pid = listener(port);
    if (pid) {
      throw new Error(`port ${port} is held by ${imageOf(pid) ?? '?'} (pid ${pid}), which the phone lane did not start ` +
        '(or another `pnpm phone up` is still running). Not touching it.');
    }
  }
}

/** The public URL answers through the gate: refused without the key, served with it. */
async function verifyPublic(t: Tunnel): Promise<void> {
  const end = Date.now() + 90_000;
  for (;;) {
    const bare = await fetch(`${t.url}/healthz`).catch(() => null);
    const keyed = await fetch(`${t.url}/healthz`, { headers: { cookie: `${PHONE_COOKIE}=${t.key}` } }).catch(() => null);
    if (bare?.status === 403 && keyed?.ok) return;
    if (Date.now() > end) throw new Error(`public check failed: no key → ${bare?.status ?? 'error'}, with key → ${keyed?.status ?? 'error'}`);
    await sleep(2000);
  }
}

async function up(appDir: string): Promise<void> {
  const state = readState();
  const reaped = reapStale();
  if (reaped) log(`stopped the previous phone build (${reaped} process${reaped === 1 ? '' : 'es'})`);
  assertPortsFree();

  let tunnel: Tunnel;
  const old = state.tunnel;
  if (old && await tunnelAlive(old)) {
    tunnel = old;
    log(`tunnel already up: ${tunnel.url}`);
  } else {
    if (old && imageOf(old.pid) === path.basename(CLOUDFLARED).toLowerCase()) {
      spawnSync('taskkill', ['/PID', String(old.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    log('starting a new tunnel (new address + key) ...');
    tunnel = await startTunnel();
    log(`tunnel up: ${tunnel.url}`);
  }
  writeState({ tunnel });

  for (const f of ['server.log', 'vite.log']) rmSync(path.join(RUN, f), { force: true });
  const sha = (spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd: appDir, encoding: 'utf8' }).stdout ?? '').trim();
  log(`building ${appDir} @ ${sha} and starting the game (a few minutes) ...`);
  const servers = new CaptureServers(
    appDir,
    RUN,
    { ...PHONE_PORTS },
    { EQX_ENABLE_TEST_ROOMS: '0' },
    {
      vite: { mode: 'preview', outDir: path.join(DIR, 'dist'), env: { EQX_PHONE_KEY: tunnel.key, VITE_PHONE_LANE: '1' } },
      outlive: true,
    },
  );
  await servers.ensure('living');
  await verifyPublic(tunnel);
  writeState({ tunnel, game: { dir: appDir, sha, startedAt: new Date().toISOString() } });
  log('ready.');
  log(`LINK: ${tunnel.url}/?k=${tunnel.key}`);
}

function down(): void {
  const state = readState();
  const n = reapStale();
  const t = state.tunnel;
  let tunnel = false;
  if (t && imageOf(t.pid) === path.basename(CLOUDFLARED).toLowerCase()) {
    spawnSync('taskkill', ['/PID', String(t.pid), '/T', '/F'], { stdio: 'ignore' });
    tunnel = true;
  }
  writeState({});
  log(`stopped ${n} game process${n === 1 ? '' : 'es'}${tunnel ? ' and the tunnel' : ''}.`);
}

async function status(): Promise<void> {
  const s = readState();
  const alive = await tunnelAlive(s.tunnel);
  log(`tunnel: ${alive ? s.tunnel!.url : 'down'}`);
  const serving = Boolean(listener(PHONE_PORTS.vite) && listener(PHONE_PORTS.server));
  log(`game: ${serving && s.game ? `${s.game.dir} @ ${s.game.sha} (since ${s.game.startedAt})` : 'not running'}`);
  if (alive && serving) log(`LINK: ${s.tunnel!.url}/?k=${s.tunnel!.key}`);
}

const [cmd, ...rest] = process.argv.slice(2);
const dirFlag = rest.indexOf('--dir');
const appDir = path.resolve(dirFlag >= 0 && rest[dirFlag + 1] ? rest[dirFlag + 1]! : process.cwd());
try {
  if (cmd === 'up') await up(appDir);
  else if (cmd === 'down') down();
  else if (cmd === 'status') await status();
  else { log('usage: pnpm phone up [--dir <checkout>] | down | status'); process.exitCode = 2; }
} catch (err) {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
// Children were unref'd: they keep running after this exits.
process.exit();
