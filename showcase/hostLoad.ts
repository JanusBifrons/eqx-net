/**
 * Host-load sensing for perf runs and showcase takes (plan
 * machine-independent-perf WS2).
 *
 * Why: on 2026-11-08 a parallel Claude session ran its own game server during
 * perf runs and nobody noticed; the laptop's same-code noise reached ×2. A
 * measurement taken while something else loads the machine is not a
 * measurement. Before and after each rep (or take) we sample:
 *  - system CPU % over a short window, from `os.cpus()` tick deltas (the same
 *    counters Task Manager reads; works on every OS, no PowerShell start-up
 *    cost inside the window);
 *  - free RAM (`os.freemem()`, "available" memory on Windows);
 *  - listening sockets on the game's known ports (dev 2567/5173, netgate
 *    2667/5273, showcase/perf 2767/5373, the +1 head arm, and the common
 *    offsets) or held by any node process running EQX code, owned by a PID
 *    outside this run's process tree: another session's server or Vite;
 *  - node / chrome processes outside this run (recorded, not gated: the
 *    user's own browser and the Claude CLI are always there).
 *
 * The parsers and the judgement are pure and unit-tested (hostLoad.test.ts).
 */
import { spawnSync } from 'node:child_process';
import os from 'node:os';

export interface ProcInfo { pid: number; ppid: number; name: string; cmd: string }
export interface Listener { port: number; pid: number }
export interface ForeignListener extends Listener { name: string; cmd: string }

export interface LoadSample {
  at: string;
  /** System-wide CPU busy %, 0–100 of all cores, over `cpuWindowMs`. */
  cpuPct: number;
  cpuWindowMs: number;
  threads: number;
  freeMemMb: number;
  totalMemMb: number;
  /** Game-port / EQX listeners owned by processes outside this run. */
  foreignListeners: ForeignListener[];
  /** node / chrome processes outside this run (record only). */
  foreignProcs: { node: number; chrome: number };
}

export interface LoadLimits {
  /** Below this much free RAM a rep is invalid (default 1024 MB). */
  minFreeMemMb: number;
  /** Above this system CPU % (of all cores) a rep is invalid (default 25). */
  maxCpuPct: number;
}
export const DEFAULT_LIMITS: LoadLimits = { minFreeMemMb: 1024, maxCpuPct: 25 };

/** Every game base port; offsets 0/+1 (perf head arm) and the usual parallel-session offsets. */
const BASE_PORTS = [2567, 5173, 2667, 5273, 2767, 5373];
export function gamePorts(extraOffsets: readonly number[] = []): Set<number> {
  const out = new Set<number>();
  for (const off of [0, 100, 200, 300, 400, 500, ...extraOffsets]) {
    for (const p of BASE_PORTS) { out.add(p + off); out.add(p + off + 1); }
  }
  return out;
}

/** `netstat -ano` (Windows) → LISTENING TCP sockets. */
export function parseNetstat(out: string): Listener[] {
  const seen = new Set<string>();
  const res: Listener[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const m = /:(\d+)$/.exec(cols[1] ?? '');
    const pid = Number(cols[cols.length - 1]);
    if (!m || !Number.isFinite(pid) || pid === 0) continue;
    const port = Number(m[1]);
    const key = `${port}/${pid}`;
    if (!seen.has(key)) { seen.add(key); res.push({ port, pid }); }
  }
  return res;
}

/** `lsof -nP -iTCP -sTCP:LISTEN` table → listening sockets. */
export function parseLsof(out: string): Listener[] {
  const res: Listener[] = [];
  for (const line of out.split(/\r?\n/).slice(1)) {
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[1]);
    const m = /:(\d+)(?:\s|$)/.exec(`${cols[8] ?? ''} `);
    if (m && Number.isFinite(pid)) res.push({ port: Number(m[1]), pid });
  }
  return res;
}

/** PowerShell `Win32_Process | ConvertTo-Json` → process table. */
export function parseWinProcs(json: string): ProcInfo[] {
  if (!json.trim()) return [];
  const raw = JSON.parse(json) as Array<{ ProcessId: number; ParentProcessId: number; Name: string | null; CommandLine: string | null }> | { ProcessId: number; ParentProcessId: number; Name: string | null; CommandLine: string | null };
  return (Array.isArray(raw) ? raw : [raw]).map((p) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: (p.Name ?? '').toLowerCase(), cmd: p.CommandLine ?? '' }));
}

/** `ps -eo pid=,ppid=,comm=,args=` → process table. */
export function parsePs(out: string): ProcInfo[] {
  const res: ProcInfo[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (m) res.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!.split('/').pop()!.toLowerCase(), cmd: m[4] ?? '' });
  }
  return res;
}

/**
 * This run's processes: everything descended from `roots` (the runner itself,
 * plus any PIDs it tracks), and the runner's ancestors (pnpm, the shell).
 */
export function ownPids(procs: readonly ProcInfo[], roots: readonly number[]): Set<number> {
  const kids = new Map<number, number[]>();
  const parent = new Map<number, number>();
  for (const p of procs) {
    parent.set(p.pid, p.ppid);
    if (p.ppid !== p.pid) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  }
  const own = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const pid = stack.pop()!;
    if (own.has(pid)) continue;
    own.add(pid);
    for (const k of kids.get(pid) ?? []) stack.push(k);
  }
  // Ancestors of the runner (only the chain, not their other children).
  let up = parent.get(roots[0] ?? -1);
  for (let guard = 0; up !== undefined && up > 0 && !own.has(up) && guard < 64; guard++) {
    own.add(up);
    up = parent.get(up);
  }
  return own;
}

const isNode = (name: string): boolean => name === 'node' || name === 'node.exe';
const isChrome = (name: string): boolean => /^(chrome|chromium|chrome-headless-shell|headless_shell)(\.exe)?$/.test(name);
/** A node process running this game's code (any checkout or worktree). */
const isEqxNode = (p: ProcInfo): boolean => isNode(p.name) && /eqx/i.test(p.cmd) && /vite|dev:server|src[\\/]server/i.test(p.cmd);

/** Pure: which listeners are foreign game servers / Vites, and how many outside node/chrome processes. */
export function classify(listeners: readonly Listener[], procs: readonly ProcInfo[], own: ReadonlySet<number>, ports: ReadonlySet<number>, ignorePorts: ReadonlySet<number> = new Set()): { foreignListeners: ForeignListener[]; foreignProcs: { node: number; chrome: number } } {
  const byPid = new Map(procs.map((p) => [p.pid, p] as const));
  const foreignListeners: ForeignListener[] = [];
  for (const l of listeners) {
    if (own.has(l.pid) || ignorePorts.has(l.port)) continue;
    const p = byPid.get(l.pid);
    if (ports.has(l.port) || (p && isEqxNode(p))) foreignListeners.push({ ...l, name: p?.name ?? '?', cmd: (p?.cmd ?? '').slice(0, 200) });
  }
  let node = 0, chrome = 0;
  for (const p of procs) {
    if (own.has(p.pid)) continue;
    if (isNode(p.name)) node++;
    else if (isChrome(p.name)) chrome++;
  }
  return { foreignListeners, foreignProcs: { node, chrome } };
}

/** Pure: why this sample makes a measurement untrustworthy (empty = fine). */
export function judgeLoad(s: LoadSample, opts: { gateCpu: boolean; limits?: LoadLimits }): string[] {
  const lim = opts.limits ?? DEFAULT_LIMITS;
  const why: string[] = [];
  if (s.freeMemMb < lim.minFreeMemMb) why.push(`free RAM ${s.freeMemMb} MB < ${lim.minFreeMemMb} MB`);
  if (opts.gateCpu && s.cpuPct > lim.maxCpuPct) why.push(`outside CPU load ${s.cpuPct.toFixed(0)}% > ${lim.maxCpuPct}% of ${s.threads} threads`);
  if (s.foreignListeners.length) {
    why.push(`foreign game server/Vite listening: ${s.foreignListeners.map((l) => `:${l.port} pid ${l.pid} (${l.name})`).join(', ')}`);
  }
  return why;
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export async function sampleCpuPct(windowMs = 1000): Promise<number> {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, windowMs));
  const b = cpuTimes();
  const dt = b.total - a.total;
  return dt > 0 ? Math.max(0, Math.min(100, (1 - (b.idle - a.idle) / dt) * 100)) : 0;
}

export function listListeners(): Listener[] {
  // `netstat -ano` lists IPv4 and IPv6 sockets; parseNetstat keeps one row per port/pid.
  if (process.platform === 'win32') return parseNetstat(spawnSync('netstat', ['-ano'], { encoding: 'utf8', maxBuffer: 16 * 2 ** 20 }).stdout ?? '');
  const seen = new Set<string>();
  return parseLsof(spawnSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '')
    .filter((l) => { const k = `${l.port}/${l.pid}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

export function processTable(): ProcInfo[] {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'],
      { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 }).stdout ?? '';
      return parseWinProcs(out);
    }
    return parsePs(spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 }).stdout ?? '');
  } catch { return []; }
}

export interface SampleOptions {
  /** PIDs this run started that may not descend from the runner (detached children). */
  extraOwnPids?: readonly number[];
  /** Ports the operator has acknowledged as busy (logged in the sample). */
  ignorePorts?: readonly number[];
  /** Extra port offsets to treat as game ports (e.g. this run's own offset). */
  portOffsets?: readonly number[];
  cpuWindowMs?: number;
}

/** Sample the host now. CPU first (so the process scan's own spike is outside the window). */
export async function sampleHostLoad(opts: SampleOptions = {}): Promise<LoadSample> {
  const cpuWindowMs = opts.cpuWindowMs ?? 1000;
  const cpuPct = await sampleCpuPct(cpuWindowMs);
  const procs = processTable();
  const own = ownPids(procs, [process.pid, ...(opts.extraOwnPids ?? [])]);
  const { foreignListeners, foreignProcs } = classify(listListeners(), procs, own, gamePorts(opts.portOffsets), new Set(opts.ignorePorts ?? []));
  return {
    at: new Date().toISOString(), cpuPct: Math.round(cpuPct * 10) / 10, cpuWindowMs, threads: os.cpus().length,
    freeMemMb: Math.round(os.freemem() / 2 ** 20), totalMemMb: Math.round(os.totalmem() / 2 ** 20),
    foreignListeners, foreignProcs,
  };
}
