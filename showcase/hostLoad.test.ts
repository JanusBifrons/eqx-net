import { describe, it, expect } from 'vitest';
import { classify, gamePorts, judgeLoad, ownPids, parseLsof, parseNetstat, parsePs, parseWinProcs, type LoadSample, type ProcInfo } from './hostLoad';

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:2567           0.0.0.0:0              LISTENING       32648
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       6292
  TCP    127.0.0.1:2667         0.0.0.0:0              LISTENING       900
  TCP    [::]:2567              [::]:0                 LISTENING       32648
  TCP    127.0.0.1:50000        127.0.0.1:2567         ESTABLISHED     111
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       4
  TCP    0.0.0.0:2767           0.0.0.0:0              LISTENING       501
`;

const procs: ProcInfo[] = [
  { pid: 1, ppid: 0, name: 'explorer.exe', cmd: '' },
  { pid: 10, ppid: 1, name: 'node.exe', cmd: 'node pnpm perf:scenes' },          // runner's parent (pnpm)
  { pid: 100, ppid: 10, name: 'node.exe', cmd: 'node tsx perf/run-perf.ts' },    // the runner
  { pid: 500, ppid: 100, name: 'cmd.exe', cmd: 'cmd /c pnpm dev:server:nowatch' },
  { pid: 501, ppid: 500, name: 'node.exe', cmd: 'node src/server/index.ts' },     // our server
  { pid: 600, ppid: 100, name: 'chrome-headless-shell.exe', cmd: '' },           // our browser
  { pid: 32648, ppid: 1, name: 'node.exe', cmd: 'C:\\x\\eqx-net\\node_modules\\tsx dev:server' }, // another session
  { pid: 6292, ppid: 1, name: 'node.exe', cmd: 'C:\\x\\eqx-net\\node_modules\\vite\\bin\\vite.js' },
  { pid: 900, ppid: 1, name: 'node.exe', cmd: 'node dummy.js' },
  { pid: 4, ppid: 0, name: 'system', cmd: '' },
  { pid: 7000, ppid: 1, name: 'chrome.exe', cmd: '' },
  { pid: 7001, ppid: 7000, name: 'chrome.exe', cmd: '' },
  { pid: 8000, ppid: 1, name: 'node.exe', cmd: 'claude' },
  { pid: 8100, ppid: 1, name: 'node.exe', cmd: 'C:\\y\\eqx-net\\node_modules\\vite\\bin\\vite.js --port 5673' },
];

describe('host-load sensing', () => {
  it('parses netstat LISTENING rows once per port/pid', () => {
    const l = parseNetstat(NETSTAT);
    expect(l).toEqual([
      { port: 2567, pid: 32648 }, { port: 5173, pid: 6292 }, { port: 2667, pid: 900 }, { port: 135, pid: 4 }, { port: 2767, pid: 501 },
    ]);
  });

  it('parses lsof and ps', () => {
    expect(parseLsof('COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\nnode 4242 me 20u IPv6 0x1 0t0 TCP *:2567 (LISTEN)\n')).toEqual([{ port: 2567, pid: 4242 }]);
    expect(parsePs('  10     1 /usr/bin/node node server.js\n')).toEqual([{ pid: 10, ppid: 1, name: 'node', cmd: 'node server.js' }]);
  });

  it('parses the PowerShell process JSON (array or single object)', () => {
    expect(parseWinProcs('[{"ProcessId":5,"ParentProcessId":1,"Name":"Node.exe","CommandLine":"x"}]')).toEqual([{ pid: 5, ppid: 1, name: 'node.exe', cmd: 'x' }]);
    expect(parseWinProcs('{"ProcessId":5,"ParentProcessId":1,"Name":null,"CommandLine":null}')).toEqual([{ pid: 5, ppid: 1, name: '', cmd: '' }]);
    expect(parseWinProcs('')).toEqual([]);
  });

  it('own processes are the runner, its descendants and its ancestor chain only', () => {
    const own = ownPids(procs, [100]);
    expect([...own].sort((a, b) => a - b)).toEqual([1, 10, 100, 500, 501, 600]);
  });

  it('flags another game server / Vite (known port, or EQX node on any port), never ours', () => {
    const own = ownPids(procs, [100]);
    // explorer (pid 1) is an ancestor here; a real tree has the runner's
    // ancestors too, and they own no game ports.
    const listeners = [...parseNetstat(NETSTAT), { port: 5673, pid: 8100 }];
    const { foreignListeners, foreignProcs } = classify(listeners, procs, own, gamePorts());
    expect(foreignListeners.map((l) => `${l.port}/${l.pid}`)).toEqual(['2567/32648', '5173/6292', '2667/900', '5673/8100']);
    // node: 32648, 6292, 900, 8000, 8100; chrome: 7000, 7001 (ours, 600, excluded)
    expect(foreignProcs).toEqual({ node: 5, chrome: 2 });
    // An acknowledged port is not counted.
    const ack = classify(listeners, procs, own, gamePorts(), new Set([2567, 5173]));
    expect(ack.foreignListeners.map((l) => l.port)).toEqual([2667, 5673]);
  });

  it('game ports cover the base set, the +1 head arm and offsets', () => {
    const p = gamePorts([1000]);
    for (const port of [2567, 5173, 2667, 5273, 2767, 2768, 5373, 5374, 3067, 5673, 3767, 6374]) expect(p.has(port)).toBe(true);
    expect(p.has(135)).toBe(false);
  });

  it('judges a sample: low RAM, busy CPU (before only), foreign listener', () => {
    const ok: LoadSample = { at: '', cpuPct: 5, cpuWindowMs: 1000, threads: 8, freeMemMb: 4000, totalMemMb: 8000, foreignListeners: [], foreignProcs: { node: 0, chrome: 0 } };
    expect(judgeLoad(ok, { gateCpu: true })).toEqual([]);
    expect(judgeLoad({ ...ok, freeMemMb: 900 }, { gateCpu: true })[0]).toMatch(/free RAM 900 MB/);
    expect(judgeLoad({ ...ok, cpuPct: 40 }, { gateCpu: true })[0]).toMatch(/outside CPU load 40%/);
    expect(judgeLoad({ ...ok, cpuPct: 40 }, { gateCpu: false })).toEqual([]);
    expect(judgeLoad({ ...ok, foreignListeners: [{ port: 2667, pid: 9, name: 'node.exe', cmd: '' }] }, { gateCpu: false })[0]).toMatch(/:2667 pid 9/);
  });
});
