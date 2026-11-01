/** Process + ffmpeg helpers for the showcase pipeline (Node-only tooling). */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Resolve ffmpeg/ffprobe: $EQX_FFMPEG, PATH, then the winget install dir. */
export function resolveFfmpeg(tool: 'ffmpeg' | 'ffprobe' = 'ffmpeg'): string {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  const env = process.env['EQX_FFMPEG'];
  if (env) {
    const p = tool === 'ffmpeg' ? env : path.join(path.dirname(env), exe);
    if (existsSync(p)) return p;
  }
  const probe = spawnSync(tool, ['-version'], { stdio: 'ignore' });
  if (probe.status === 0) return tool;
  const local = process.env['LOCALAPPDATA'];
  if (local) {
    const pkgs = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    if (existsSync(pkgs)) {
      for (const pkg of readdirSync(pkgs).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
        for (const build of readdirSync(path.join(pkgs, pkg))) {
          const p = path.join(pkgs, pkg, build, 'bin', exe);
          if (existsSync(p)) return p;
        }
      }
    }
  }
  throw new Error(
    `${tool} not found. Install it (Windows: \`winget install Gyan.FFmpeg\`; macOS: \`brew install ffmpeg\`) ` +
      'or set EQX_FFMPEG to the ffmpeg binary.',
  );
}

/** Run a command to completion; reject with its stderr tail on failure. */
export function run(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out + err);
      else reject(new Error(`${path.basename(cmd)} exited ${code}\n${err.slice(-2000)}`));
    });
  });
}

export async function ffmpeg(args: string[]): Promise<string> {
  return run(resolveFfmpeg('ffmpeg'), ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
}

/** ffmpeg run that returns stderr even at info level (for blackdetect etc). */
export async function ffmpegInfo(args: string[]): Promise<string> {
  return run(resolveFfmpeg('ffmpeg'), ['-hide_banner', '-y', ...args]);
}

export async function probeDurationMs(file: string): Promise<number> {
  const out = await run(resolveFfmpeg('ffprobe'), [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ]);
  return Math.round(parseFloat(out.trim()) * 1000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${url}`);
    await sleep(500);
  }
}

/** Kill whatever listens on `port` (only ever called on the pipeline's own ports). */
export function killPort(port: number): void {
  if (process.platform === 'win32') {
    const out = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout ?? '';
    const pids = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      if (line.includes('LISTENING') && new RegExp(`[:.]${port}\\s`).test(line)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') pids.add(pid);
      }
    }
    for (const pid of pids) spawnSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore' });
  } else {
    spawnSync('sh', ['-c', `lsof -ti tcp:${port} | xargs -r kill -9`], { stdio: 'ignore' });
  }
}

export function gitSha(cwd: string): string {
  const r = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd, encoding: 'utf8' });
  return (r.stdout ?? '').trim() || 'unknown';
}
