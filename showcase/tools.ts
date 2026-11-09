/** Process + ffmpeg helpers for the showcase pipeline (Node-only tooling). */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
    // LISTEN only: without it lsof also lists every process with a CLIENT
    // connection to the port, the caller included (perf:counts polls
    // /dev/perf on it), and kill -9 took the runner down with exit 137 (CI,
    // 2026-11-08).
    spawnSync('sh', ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN | xargs -r kill -9`], { stdio: 'ignore' });
  }
}

export function gitSha(cwd: string): string {
  const r = spawnSync('git', ['rev-parse', '--short=8', 'HEAD'], { cwd, encoding: 'utf8' });
  return (r.stdout ?? '').trim() || 'unknown';
}

/**
 * Child processes a run started, so the NEXT run can reap what a killed run
 * left behind (memory, 2026-11-07: Claude Code killed two takes for low
 * memory and each left ~1 GB of headless capture browsers running; free
 * memory fell to 42 MB). A killed process runs no cleanup, so the reaping
 * happens at start. A recorded PID is killed only while it still runs the
 * same program (PIDs are reused).
 */
const pidFile = (): string => process.env['EQX_SHOWCASE_PID_FILE'] ?? path.join(process.cwd(), 'showcase-out', '.showcase-pids.json');

/** Write the pid file, creating its directory first (a fresh checkout has no
 *  `showcase-out/`: `pnpm showcase` crashed with ENOENT, 2026-11-08). */
function writePidFile(body: string): void {
  mkdirSync(path.dirname(pidFile()), { recursive: true });
  writeFileSync(pidFile(), body);
}

/** `owner` is the run that started the process: a run that is still alive
 *  (a parallel run in the same checkout) is never reaped (2026-11-08: the
 *  reap unit test, reading the real pid file through a misspelt env var,
 *  killed a live perf run's servers). */
interface TrackedPid { pid: number; image: string; owner?: number; ownerImage?: string }

function imageOf(pid: number): string | null {
  if (process.platform === 'win32') {
    const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' }).stdout ?? '';
    const m = /^"([^"]+)"/.exec(out.trim());
    return m ? m[1]!.toLowerCase() : null;
  }
  const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
  return (r.stdout ?? '').trim().toLowerCase() || null;
}

function readTracked(): TrackedPid[] {
  try { return JSON.parse(readFileSync(pidFile(), 'utf8')) as TrackedPid[]; } catch { return []; }
}

/** Remember a child process this run started (browser, server). */
export function trackPid(pid: number | undefined): void {
  if (!pid) return;
  const image = imageOf(pid);
  if (!image) return;
  const all = readTracked().filter((t) => t.pid !== pid);
  all.push({ pid, image, owner: process.pid, ownerImage: imageOf(process.pid) ?? undefined });
  writePidFile(JSON.stringify(all));
}

/** Kill processes a previous (killed) run left behind. Returns how many. */
export function reapStale(): number {
  let n = 0;
  const keep: TrackedPid[] = [];
  for (const t of readTracked()) {
    if (imageOf(t.pid) !== t.image) continue; // gone, or the PID was reused
    // Its run is still going (and isn't us): not stale.
    if (t.owner && t.owner !== process.pid && t.ownerImage && imageOf(t.owner) === t.ownerImage) { keep.push(t); continue; }
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(t.pid), '/T', '/F'], { stdio: 'ignore' });
    else spawnSync('kill', ['-9', String(t.pid)], { stdio: 'ignore' });
    n++;
  }
  writePidFile(JSON.stringify(keep));
  return n;
}

/** A run ended normally: nothing of ours to reap (a live parallel run's entries stay). */
export function clearTracked(): void {
  try {
    writePidFile(JSON.stringify(readTracked().filter((t) => t.owner && t.owner !== process.pid)));
  } catch { /* unwritable output dir: nothing to clear */ }
}

/** The browser process PID of a launched Playwright Chromium (via CDP:
 *  Playwright's `Browser` doesn't expose its process). Undefined if unknown. */
export async function browserPid(browser: { newBrowserCDPSession(): Promise<{ send(m: string): Promise<unknown>; detach(): Promise<void> }> }): Promise<number | undefined> {
  try {
    const cdp = await browser.newBrowserCDPSession();
    const info = (await cdp.send('SystemInfo.getProcessInfo')) as { processInfo?: Array<{ type: string; id: number }> };
    await cdp.detach();
    return info.processInfo?.find((p) => p.type === 'browser')?.id;
  } catch { return undefined; }
}
