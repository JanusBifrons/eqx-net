/**
 * Galaxy soak (wrap-up plan W1c): boot the real server with the whole living
 * galaxy (every sector, directors on), park one pilot in Sol Prime, and sample
 * for N minutes:
 *  - server tick cost, from each room's once-a-second `tick_budget` event
 *    (average tick, worst tick in the second, ticks over budget);
 *  - bytes per second the pilot receives;
 *  - process + physics-worker memory (`/dev/memory`), start and end.
 *
 *   pnpm tsx scripts/soak-galaxy.ts --minutes 9 --solar 1 --out diag/soak/solar.json
 *   pnpm tsx scripts/soak-galaxy.ts --minutes 9 --solar 0 --out diag/soak/classic.json
 *
 * Runs on its own port (2767) against a throwaway DB, so a dev session is
 * never touched. Compare two runs only from the same machine and session.
 * Run it in the foreground; it stops the server it started on exit.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'colyseus.js';

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!.replace(/^--/, ''), process.argv[i + 1] ?? '');
const MINUTES = Number(args.get('minutes') ?? 10);
const SOLAR = args.get('solar') ?? '1';
const OUT = args.get('out') ?? `diag/soak/${SOLAR === '0' ? 'classic' : 'solar'}.json`;
const SECTOR = args.get('sector') ?? 'sol-prime';
const PORT = 2767;
const BASE = `http://127.0.0.1:${PORT}`;

interface TickBudget { ts: number; tag: string; data: { avgMs?: { total?: number }; maxTotalMs?: number; overBudgetCount?: number; sampleCount?: number; swarmCount?: number } }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const getJson = async <T>(p: string): Promise<T | null> => fetch(BASE + p).then((r) => r.json() as Promise<T>).catch(() => null);
function pct(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.min(s.length - 1, Math.floor(q * s.length))]!.toFixed(3);
}

function killTree(c: ChildProcess | null): void {
  if (!c?.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' });
  else c.kill('SIGKILL');
}

async function main(): Promise<void> {
  const runDir = mkdtempSync(path.join(tmpdir(), 'eqx-soak-'));
  const fd = openSync(path.join(runDir, 'server.log'), 'a');
  const server = spawn('pnpm dev:server:nowatch', {
    shell: true, stdio: ['ignore', fd, fd],
    env: {
      ...process.env, PORT: String(PORT), DB_PATH: path.join(runDir, 'eqx.db'), EQX_AUDIT_DIR: path.join(runDir, 'audit'),
      EQX_SOLAR_SECTORS: SOLAR, EQX_DEV_EVENTS_MAX: '20000',
    },
  });
  closeSync(fd);
  const stop = (): void => killTree(server);
  process.on('SIGINT', () => { stop(); process.exit(130); });
  try {
    const readyBy = Date.now() + 240_000;
    for (;;) {
      const h = await getJson<{ ready?: boolean }>('/healthz');
      if (h?.ready) break;
      if (Date.now() > readyBy) throw new Error(`server never ready (log: ${runDir})`);
      await sleep(1000);
    }
    const client = new Client(`ws://127.0.0.1:${PORT}`);
    const room = await client.joinOrCreate(`galaxy-${SECTOR}`, { playerId: randomUUID(), shipKind: 'fighter' });
    room.onMessage('*', () => {});
    room.send('client_ready', { type: 'client_ready' });
    let bytes = 0;
    const ws = (room as unknown as { connection: { transport: { ws: { addEventListener(t: string, f: (e: { data: unknown }) => void): void } } } }).connection.transport.ws;
    ws.addEventListener('message', (e) => { const d = e.data; bytes += typeof d === 'string' ? d.length : d instanceof ArrayBuffer ? d.byteLength : (d as Uint8Array).length; });

    await sleep(15_000); // settle: directors populate, first waves
    const memStart = await getJson<Record<string, unknown>>('/dev/memory');
    await fetch(BASE + '/dev/events/clear', { method: 'POST' });
    bytes = 0;
    const t0 = Date.now();
    const avg: number[] = [], worst: number[] = [];
    let over = 0, ticks = 0, swarmMax = 0;
    const endAt = t0 + MINUTES * 60_000;
    let nextLog = t0 + 60_000;
    while (Date.now() < endAt) {
      await sleep(5000);
      const ev = await getJson<{ events: TickBudget[] }>('/dev/events?limit=20000');
      await fetch(BASE + '/dev/events/clear', { method: 'POST' });
      for (const e of ev?.events ?? []) {
        if (e.tag !== 'tick_budget') continue;
        if (e.data.avgMs?.total !== undefined) avg.push(e.data.avgMs.total);
        if (e.data.maxTotalMs !== undefined) worst.push(e.data.maxTotalMs);
        over += e.data.overBudgetCount ?? 0;
        ticks += e.data.sampleCount ?? 0;
        swarmMax = Math.max(swarmMax, e.data.swarmCount ?? 0);
      }
      if (Date.now() >= nextLog) {
        nextLog += 60_000;
        console.log(`[soak] ${Math.round((Date.now() - t0) / 60_000)} min: tick avg p50 ${pct(avg, 0.5)} ms, worst p95 ${pct(worst, 0.95)} ms, ${Math.round((bytes * 1000) / (Date.now() - t0))} B/s`);
      }
    }
    const elapsed = Date.now() - t0;
    const memEnd = await getJson<Record<string, unknown>>('/dev/memory');
    const pop = await getJson<Record<string, unknown>>('/dev/population');
    const row = {
      solar: SOLAR !== '0', minutes: MINUTES, sector: SECTOR, at: new Date().toISOString(),
      roomSeconds: avg.length, ticks,
      tickAvgMs: { p50: pct(avg, 0.5), p95: pct(avg, 0.95), max: pct(avg, 1) },
      worstTickPerSecondMs: { p50: pct(worst, 0.5), p95: pct(worst, 0.95), p99: pct(worst, 0.99), max: pct(worst, 1) },
      ticksOverBudget: over, overBudgetShare: ticks ? +(over / ticks).toFixed(5) : 0,
      swarmMaxInARoom: swarmMax,
      pilotBytesPerSec: Math.round((bytes * 1000) / elapsed),
      memory: {
        rssMbStart: memStart?.['rssMb'], rssMbEnd: memEnd?.['rssMb'],
        heapUsedMbStart: memStart?.['heapUsedMb'], heapUsedMbEnd: memEnd?.['heapUsedMb'],
        workerHeapTotalMbStart: memStart?.['workerHeapTotalMb'], workerHeapTotalMbEnd: memEnd?.['workerHeapTotalMb'],
        rooms: memEnd?.['rooms'],
      },
      population: pop?.['totals'] ?? null,
    };
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(row, null, 2));
    console.log(JSON.stringify(row, null, 2));
    await room.leave(true).catch(() => {});
  } finally {
    stop();
  }
}

main().catch((err: unknown) => { console.error(err); process.exitCode = 1; });
