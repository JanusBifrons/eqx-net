/**
 * Isolated server + Vite pair for capture. Runs on its OWN ports (default
 * 2767 / 5373) so a dev session on 2567 / 5173 is never touched, and against a
 * per-run temp DB so the dev database is never written.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { openSync, closeSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import type { ServerProfile } from './types.js';
import { killPort, trackPid, waitForHttp } from './tools.js';

export interface ServerPorts {
  server: number;
  vite: number;
}

/**
 * `EQX_SHOWCASE_PORT_OFFSET` shifts every capture port (server 2767+off, Vite
 * 5373+off; the perf runner's head arm is +1 on top), so parallel sessions or
 * recorders on one machine don't collide or kill each other's servers.
 */
export function portOffset(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['EQX_SHOWCASE_PORT_OFFSET'];
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 20_000) throw new Error(`EQX_SHOWCASE_PORT_OFFSET must be a whole number 0-20000, got "${raw}"`);
  return n;
}

export function defaultPorts(env: NodeJS.ProcessEnv = process.env): ServerPorts {
  const off = portOffset(env);
  return { server: 2767 + off, vite: 5373 + off };
}

export const DEFAULT_PORTS: ServerPorts = defaultPorts();

/** Env per profile. Living world off unless a shot needs galaxy life; the
 *  test-room-only profiles boot no galaxy sectors (EQX_GALAXY_SECTORS=none:
 *  memory, 2026-11-07 — each sector is a room plus a physics world). */
export function profileEnv(profile: ServerProfile): Record<string, string> {
  switch (profile) {
    case 'lean':
      return { EQX_DISABLE_LIVING_WORLD: '1', EQX_GALAXY_SECTORS: 'none' };
    case 'living':
      return {};
    case 'wave':
      return { EQX_E2E_WAVE: '1', EQX_BOT_SPOOL_MS: '5000', EQX_BOT_HOP_MS: '500' };
    case 'capitals':
      return { EQX_DISABLE_LIVING_WORLD: '1', EQX_SECTOR_SCALE: '4', EQX_GALAXY_SECTORS: 'none' };
    case 'naval':
      return { EQX_DISABLE_LIVING_WORLD: '1', EQX_SECTOR_SCALE: '4', EQX_GALAXY_SECTORS: 'none', EQX_NAVAL_RANGE: 'real' };
    case 'solar':
      return { EQX_DISABLE_LIVING_WORLD: '1', EQX_SOLAR_SECTORS: '1', EQX_GALAXY_SECTORS: 'sol-prime,vega-reach' };
  }
}

function killTree(child: ChildProcess | null): void {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/** `outlive`: the process keeps running after this CLI exits (the phone lane:
 *  `pnpm phone up` returns while the game stays up). */
function startLogged(cmd: string, cwd: string, env: Record<string, string>, logFile: string, outlive = false): ChildProcess {
  const fd = openSync(logFile, 'a');
  const child = spawn(cmd, {
    cwd,
    shell: true,
    detached: outlive || process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...env },
  });
  closeSync(fd);
  trackPid(child.pid);
  if (outlive) child.unref();
  return child;
}

/**
 * How the client is served. `dev` (default): `vite` dev server, as every
 * capture uses. `preview`: a production `vite build` into `outDir`, then
 * `vite preview` (the phone lane: installable PWA + service worker, which only
 * exist in a build). `env` reaches both the build and the preview server.
 */
export type ViteMode = { mode: 'dev' } | { mode: 'preview'; outDir: string; env: Record<string, string> };

export interface CaptureServersOptions {
  vite?: ViteMode;
  /** Children outlive this process (see `startLogged`). */
  outlive?: boolean;
}

export class CaptureServers {
  private server: ChildProcess | null = null;
  private vite: ChildProcess | null = null;
  private profile: ServerProfile | null = null;

  constructor(
    /** Repo checkout whose code is being filmed (snapshot worktree or cwd). */
    private readonly appDir: string,
    private readonly runDir: string,
    private readonly ports: ServerPorts = DEFAULT_PORTS,
    /** Extra server env (the perf runner's fault injection). */
    private readonly extraEnv: Record<string, string> = {},
    private readonly opts: CaptureServersOptions = {},
  ) {}

  get baseUrl(): string {
    return `http://localhost:${this.ports.vite}`;
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.ports.server}`;
  }

  get currentProfile(): ServerProfile | null {
    return this.profile;
  }

  /** Ensure the server runs with `profile` (restarts it on a profile change). */
  async ensure(profile: ServerProfile): Promise<void> {
    if (!this.vite) await this.startVite();
    if (this.server && this.profile === profile) return;
    await this.startServer(profile);
  }

  /** Restart the server with the same profile + DB (persistence shot). */
  async restartServer(): Promise<void> {
    if (!this.profile) throw new Error('no server running');
    await this.startServer(this.profile);
  }

  private async startServer(profile: ServerProfile): Promise<void> {
    killTree(this.server);
    this.server = null;
    killPort(this.ports.server);
    this.server = startLogged(
      'pnpm dev:server:nowatch',
      this.appDir,
      {
        PORT: String(this.ports.server),
        DB_PATH: path.join(this.runDir, 'eqx.db'),
        EQX_AUDIT_DIR: path.join(this.runDir, 'audit'),
        EQX_ENABLE_TEST_ROOMS: '1',
        ...profileEnv(profile),
        ...this.extraEnv,
      },
      path.join(this.runDir, 'server.log'),
      this.opts.outlive,
    );
    this.profile = profile;
    await waitForHttp(`${this.serverUrl}/healthz`, 120_000);
    // Up is not ready: the galaxy rooms hydrate after the port opens, and the
    // landing page shows a "Server is starting up" banner until they have.
    const end = Date.now() + 180_000;
    for (;;) {
      const r = await fetch(`${this.serverUrl}/healthz`).then((x) => x.json() as Promise<{ ready?: boolean }>).catch(() => null);
      if (r?.ready) break;
      if (Date.now() > end) throw new Error('server never reported ready');
      await new Promise((res) => setTimeout(res, 1000));
    }
  }

  private async startVite(): Promise<void> {
    killPort(this.ports.vite);
    const vite = this.opts.vite ?? { mode: 'dev' };
    const env = { EQX_SERVER_PORT: String(this.ports.server), VITE_HMR_PORT: 'off', ...(vite.mode === 'preview' ? vite.env : {}) };
    const logFile = path.join(this.runDir, 'vite.log');
    let cmd = `pnpm exec vite --port ${this.ports.vite} --strictPort`;
    if (vite.mode === 'preview') {
      const outDir = JSON.stringify(vite.outDir);
      const build = spawnSync(`pnpm exec vite build --outDir ${outDir} --emptyOutDir`, {
        cwd: this.appDir, shell: true, windowsHide: true, encoding: 'utf8', env: { ...process.env, ...env },
      });
      appendFileSync(logFile, `${build.stdout ?? ''}${build.stderr ?? ''}`);
      if (build.status !== 0) throw new Error(`vite build failed (exit ${build.status}); see ${logFile}`);
      cmd = `pnpm exec vite preview --outDir ${outDir} --port ${this.ports.vite} --strictPort`;
    }
    this.vite = startLogged(cmd, this.appDir, env, logFile, this.opts.outlive);
    // The phone gate refuses `/` without its key; the favicon is exempt.
    await waitForHttp(`${this.baseUrl}/${vite.mode === 'preview' ? 'favicon.ico' : ''}`, 120_000);
  }

  stop(): void {
    killTree(this.server);
    killTree(this.vite);
    this.server = null;
    this.vite = null;
    killPort(this.ports.server);
    killPort(this.ports.vite);
  }
}
