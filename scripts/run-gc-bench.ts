/**
 * `pnpm bench:gc` runner — paradigm plan (quirky-rabbit) Phase 7-A.
 *
 * Boots a focused, in-process workload that exercises the production
 * `SnapshotBroadcaster` (the heaviest pooled allocator in the live loop
 * — Phase 2 migration) at the real 20 Hz broadcast cadence for a fixed
 * window. Samples server-side GC pauses via `PerformanceObserver` and
 * feeds the aggregate into the pure verdict module
 * `benchmarks/gcBenchBudget.ts`.
 *
 * Why an in-process workload instead of a real `SectorRoom`: booting
 * the full Colyseus + WebSocket + persistence-worker stack adds a lot
 * of moving parts that are themselves significant allocators. We want
 * a SIGNAL on the broadcaster path (the hot loop the pool migrations
 * actually touched), not a noisy aggregate. The integration harness
 * lives separately in `tests/integration/` for behavioural coverage;
 * this gate measures pressure on the SPECIFIC code path the pool work
 * targeted.
 *
 * Usage:
 *   pnpm bench:gc                  # run + check vs baseline
 *   pnpm bench:gc --update         # overwrite baseline.json with run
 *   pnpm bench:gc --print          # run + print, exit 0 regardless
 *
 * The runner intentionally does NOT call `installGcMonitor()` (the
 * server's production GC observer) — it installs its own observer so
 * tests don't fight for the single-process gc-entry stream.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import {
  evaluateGcBench,
  formatGcBenchVerdict,
  type GcBenchSample,
} from '../benchmarks/gcBenchBudget.js';
import { SnapshotBroadcaster, type SnapshotBroadcasterDeps } from '../src/server/rooms/SnapshotBroadcaster.js';
import type { Client, ClientArray } from 'colyseus';
import type { Logger } from 'pino';
import type { MapSchema } from '@colyseus/schema';
import type { ShipPhysicsState } from '../src/core/physics/World.js';
import type { ShipState } from '../src/server/rooms/schema/SectorState.js';
import type { ProjectileRecord } from '../src/server/rooms/ProjectilePipeline.js';

const REPO_ROOT = process.cwd();
const BASELINE_PATH = join(REPO_ROOT, 'benchmarks', 'gc-baseline.json');

const WORKLOAD_KEY = 'broadcaster-20hz-30s';
const TARGET_SECONDS = 30;
const TICK_INTERVAL_MS = 50; // 20 Hz
const PLAYER_COUNT = 8;

interface BaselineFile {
  readonly v: 1;
  readonly capturedAt: string;
  readonly sample: GcBenchSample;
}

function isFlag(name: string): boolean {
  return process.argv.includes(name);
}

interface GcEvent { durationMs: number; kind: string }

function installGcSampler(): { events: GcEvent[]; disconnect: () => void } {
  const events: GcEvent[] = [];
  interface NodeGcEntry { duration: number; kind?: number; detail?: { kind?: number } }
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as unknown as NodeGcEntry[]) {
      // Only MSC (kind=2) is the production failure mode the gate
      // cares about. Scavenge (1) is sub-ms and noise.
      const kind = entry.kind ?? entry.detail?.kind;
      if (kind !== 2) continue;
      if (entry.duration < 5) continue; // mirrors GcMonitor's threshold
      events.push({ durationMs: entry.duration, kind: 'mark-sweep-compact' });
    }
  });
  obs.observe({ entryTypes: ['gc'], buffered: true });
  return { events, disconnect: () => obs.disconnect() };
}

function makeBroadcaster(): SnapshotBroadcaster {
  // Same stub shape as `SnapshotBroadcaster.heapDelta.test.ts`. Zero
  // clients → exercises the global pre-recipient pooled block under
  // realistic player count; that's the path Phase 2 migrated.
  const sabU32 = new Uint32Array(1024);
  const playerToSlot = new Map<string, number>();
  const shipPoseCache = new Map<string, ShipPhysicsState>();
  const ships = new Map<string, ShipState>();
  for (let i = 0; i < PLAYER_COUNT; i++) {
    const pid = `p${i}`;
    playerToSlot.set(pid, i);
    shipPoseCache.set(pid, { x: i * 10, y: i * 10, vx: 0, vy: 0, angle: 0, angvel: 0 });
    ships.set(pid, {
      alive: true, isActive: true,
      shipInstanceId: `inst-${pid}`, playerId: pid,
    } as unknown as ShipState);
  }
  const stubLogger = {
    debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
    fatal: () => {}, trace: () => {}, silent: () => {},
    child: () => stubLogger,
  } as unknown as Logger;

  const deps: SnapshotBroadcasterDeps = {
    serverTick: () => 100,
    sabU32,
    clients: [] as unknown as ClientArray<Client>,
    sessionToPlayer: new Map(),
    playerToSlot,
    getActiveShip: (pid: string) => ships.get(pid),
    shipPoseCache,
    lingeringSlots: new Map<string, number>(),
    lingeringPoseCache: new Map<string, ShipPhysicsState>(),
    shipsMap: ships as unknown as MapSchema<ShipState>,
    wreckPoseCache: new Map<string, ShipPhysicsState>(),
    liveProjectiles: new Map<string, ProjectileRecord>(),
    boostingPlayers: new Set<string>(),
    thrustingPlayers: new Set<string>(),
    swarmRegistry: { getByEntityId: () => null },
    playerMountAngles: new Map<string, Float32Array>(),
    droneMountAngles: new Map<string, Float32Array>(),
    logger: stubLogger,
    serverLogEvent: () => {},
  };
  return new SnapshotBroadcaster(deps);
}

async function runWorkload(): Promise<GcBenchSample> {
  const sampler = installGcSampler();
  const broadcaster = makeBroadcaster();

  // Warmup pass — fills the AllShipEntry slot pool + lets the JIT settle.
  for (let i = 0; i < 1000; i++) broadcaster.broadcast(false);

  // Timed window.
  const startMs = Date.now();
  const endMs = startMs + TARGET_SECONDS * 1000;
  return new Promise<GcBenchSample>((resolve) => {
    const handle = setInterval(() => {
      broadcaster.broadcast(false);
      if (Date.now() >= endMs) {
        clearInterval(handle);
        const durationSec = (Date.now() - startMs) / 1000;
        sampler.disconnect();
        let total = 0;
        let max = 0;
        for (const e of sampler.events) {
          total += e.durationMs;
          if (e.durationMs > max) max = e.durationMs;
        }
        resolve({
          workload: WORKLOAD_KEY,
          durationSec,
          majorGcCount: sampler.events.length,
          gcPauseTotalMs: total,
          gcPauseMaxMs: max,
        });
      }
    }, TICK_INTERVAL_MS);
  });
}

function loadBaseline(): GcBenchSample | null {
  if (!existsSync(BASELINE_PATH)) return null;
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as BaselineFile;
  if (parsed.v !== 1) {
    process.stderr.write(`baseline.json has unknown version: ${parsed.v}\n`);
    return null;
  }
  return parsed.sample;
}

function writeBaseline(sample: GcBenchSample): void {
  const file: BaselineFile = {
    v: 1,
    capturedAt: new Date().toISOString(),
    sample,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(file, null, 2) + '\n');
}

async function main(): Promise<void> {
  process.stdout.write(
    `running gc-bench workload "${WORKLOAD_KEY}" for ~${TARGET_SECONDS}s (${PLAYER_COUNT} players, 20 Hz)...\n`,
  );
  const head = await runWorkload();
  process.stdout.write(
    `head: ${JSON.stringify({
      ...head,
      gcPauseTotalMs: parseFloat(head.gcPauseTotalMs.toFixed(2)),
      gcPauseMaxMs: parseFloat(head.gcPauseMaxMs.toFixed(2)),
    })}\n`,
  );

  if (isFlag('--update')) {
    writeBaseline(head);
    process.stdout.write(`baseline written to ${BASELINE_PATH}\n`);
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    process.stdout.write(
      `no baseline at ${BASELINE_PATH} — run with --update to create one.\n`,
    );
    process.exit(isFlag('--print') ? 0 : 1);
  }

  const verdict = evaluateGcBench(head, baseline);
  process.stdout.write(formatGcBenchVerdict(verdict) + '\n');

  if (isFlag('--print')) {
    process.exit(0);
  }
  process.exit(verdict.pass ? 0 : 1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`gc-bench failed: ${msg}\n`);
  process.exit(2);
});
