/**
 * Isolated server + Vite pair for capture. Runs on its OWN ports (default
 * 2767 / 5373) so a dev session on 2567 / 5173 is never touched, and against a
 * per-run temp DB so the dev database is never written.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import path from 'node:path';
import type { ServerProfile } from './types.js';
import { killPort, waitForHttp } from './tools.js';

export interface ServerPorts {
  server: number;
  vite: number;
}

export const DEFAULT_PORTS: ServerPorts = { server: 2767, vite: 5373 };

/** Env per profile. Living world off unless a shot needs galaxy life. */
export function profileEnv(profile: ServerProfile): Record<string, string> {
  switch (profile) {
    case 'lean':
      return { EQX_DISABLE_LIVING_WORLD: '1' };
    case 'living':
      return {};
    case 'wave':
      return { EQX_E2E_WAVE: '1', EQX_BOT_SPOOL_MS: '5000', EQX_BOT_HOP_MS: '500' };
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

function startLogged(cmd: string, cwd: string, env: Record<string, string>, logFile: string): ChildProcess {
  const fd = openSync(logFile, 'a');
  const child = spawn(cmd, {
    cwd,
    shell: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', fd, fd],
    env: { ...process.env, ...env },
  });
  closeSync(fd);
  return child;
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
      },
      path.join(this.runDir, 'server.log'),
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
    this.vite = startLogged(
      `pnpm exec vite --port ${this.ports.vite} --strictPort`,
      this.appDir,
      { EQX_SERVER_PORT: String(this.ports.server), VITE_HMR_PORT: 'off' },
      path.join(this.runDir, 'vite.log'),
    );
    await waitForHttp(`${this.baseUrl}/`, 120_000);
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
