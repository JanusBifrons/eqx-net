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

const WORKLOAD_KEY_DEFAULT = 'broadcaster-20hz-30s';
const WORKLOAD_KEY_STRESS = 'broadcaster-20hz-30s+stress';
const WORKLOAD_KEY = process.argv.includes('--stress')
  ? WORKLOAD_KEY_STRESS
  : WORKLOAD_KEY_DEFAULT;
const TARGET_SECONDS = 30;
const TICK_INTERVAL_MS = 50; // 20 Hz
const PLAYER_COUNT = 8;

interface BaselineFile {
  /** v=1 was single-sample (single workload); v=2 keys samples by
   *  workload so default + stress baselines coexist in one file. */
  readonly v: 2;
  readonly capturedAt: string;
  readonly samples: Record<string, GcBenchSample>;
}

function isFlag(name: string): boolean {
  return process.argv.includes(name);
}

interface GcEvent { durationMs: number; kind: string }

/** V8 GC `kind` bitfield → label, mirroring `GcMonitor.kindLabel`. */
function kindLabel(kind: number | undefined): string {
  if (kind === undefined) return 'unknown';
  if (kind === 1) return 'scavenge';
  if (kind === 2) return 'mark-sweep-compact';
  if (kind === 4) return 'incremental';
  if (kind === 8) return 'weakcb';
  return `mixed:${kind}`;
}

function installGcSampler(): {
  events: GcEvent[];
  disconnect: () => Promise<void>;
} {
  const events: GcEvent[] = [];
  interface NodeGcEntry { duration: number; kind?: number; detail?: { kind?: number } }
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as unknown as NodeGcEntry[]) {
      const kind = entry.kind ?? entry.detail?.kind;
      // **Critical fix (post-Phase-7-A self-test).** Modern V8 reports
      // major-class GCs as kind=4 (incremental marking), NOT kind=2
      // (stop-the-world MSC). The previous filter `kind !== 2` dropped
      // 100 % of real production major GCs — the gate was decorative.
      // Correct rule: anything that is NOT pure scavenge (kind=1) AND
      // exceeds the 5 ms threshold is a frame-budget-relevant pause.
      // Includes 2 (full MSC), 4 (incremental), 8 (weakcb), and any
      // bitwise mix.
      if (kind === 1) continue;
      if (entry.duration < 5) continue; // mirrors GcMonitor's threshold
      events.push({ durationMs: entry.duration, kind: kindLabel(kind) });
    }
  });
  obs.observe({ entryTypes: ['gc'], buffered: true });

  // **Critical fix (post-Phase-7-A self-test).** `PerformanceObserver`
  // notifies asynchronously via the microtask queue. Calling
  // `obs.disconnect()` synchronously at the tail of a workload drops
  // any pending entries that were queued by the last batch of GCs.
  // The async disconnect awaits a setTimeout(100) so the queue drains
  // before we tear the observer down.
  const disconnect = async (): Promise<void> => {
    await new Promise<void>((r) => setTimeout(r, 100));
    obs.disconnect();
  };
  return { events, disconnect };
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

/**
 * `--stress` mode — drives a deliberately allocation-heavy workload
 * for the same window. Produces non-zero MSC events on any modern V8;
 * proves the gate has a real signal-detection capability AND gives the
 * user a calibration data-point ("this is what a known-bad regression
 * looks like in the gate output"). The default broadcaster workload
 * post-Phase-2 reports zero because the pool work eliminated its
 * allocations — both readings are truthful but only one detects
 * regressions in the broadcaster path itself.
 *
 * Allocates ~2 MB/tick, retained through a sliding window so V8
 * tenures and old-gen pressure builds. Equivalent to the
 * `gcObserverSelfTest.heapDelta.test.ts` pattern but stretched to the
 * 30 s window.
 */
function stressTick(survivors: Float64Array[], tickIndex: number): void {
  // Push 1000 × 256-element typed arrays per tick + DON'T slide — the
  // accumulating-then-purging shape proved out in
  // `gcObserverSelfTest.heapDelta.test.ts` (12 incremental MSCs in
  // ~500 ms when allocations accumulate to ~100 MB and survivors are
  // retained). A sliding window keeps the working set small enough
  // for V8 to handle inside scavenge alone; accumulation forces
  // repeated old-gen sweeps.
  for (let i = 0; i < 1000; i++) {
    survivors.push(new Float64Array(256).fill(tickIndex + i));
  }
  // Hard cap: 250 000 entries × ~2 KB = ~500 MB. Hit at tick ~250
  // (12.5 s into a 30 s run). Past the cap we purge the oldest 50 %,
  // which generates a burst of MSCs as the survivors get collected.
  if (survivors.length > 250_000) survivors.splice(0, 125_000);
}

async function runWorkload(): Promise<GcBenchSample> {
  const stress = process.argv.includes('--stress');
  const sampler = installGcSampler();
  const broadcaster = makeBroadcaster();
  const stressSurvivors: Float64Array[] = [];

  // Warmup pass — fills the AllShipEntry slot pool + lets the JIT settle.
  for (let i = 0; i < 1000; i++) broadcaster.broadcast(false);

  // Timed window.
  const startMs = Date.now();
  const endMs = startMs + TARGET_SECONDS * 1000;
  let stressTickIndex = 0;
  return new Promise<GcBenchSample>((resolve) => {
    const handle = setInterval(() => {
      broadcaster.broadcast(false);
      if (stress) stressTick(stressSurvivors, stressTickIndex++);
      if (Date.now() >= endMs) {
        clearInterval(handle);
        const durationSec = (Date.now() - startMs) / 1000;
        void sampler.disconnect().then(() => {
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
        });
      }
    }, TICK_INTERVAL_MS);
  });
}

function loadBaselineFile(): BaselineFile | null {
  if (!existsSync(BASELINE_PATH)) return null;
  const raw = readFileSync(BASELINE_PATH, 'utf8');
  const parsed = JSON.parse(raw) as BaselineFile;
  if (parsed.v !== 2) {
    process.stderr.write(`baseline.json has unknown version: ${(parsed as { v: number }).v}\n`);
    return null;
  }
  return parsed;
}

function loadBaselineFor(workload: string): GcBenchSample | null {
  const file = loadBaselineFile();
  return file ? file.samples[workload] ?? null : null;
}

function writeBaselineFor(sample: GcBenchSample): void {
  // Read-modify-write so updating one workload doesn't drop the others.
  const existing = loadBaselineFile();
  const samples = existing ? { ...existing.samples } : {};
  samples[sample.workload] = sample;
  const file: BaselineFile = {
    v: 2,
    capturedAt: new Date().toISOString(),
    samples,
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
    writeBaselineFor(head);
    process.stdout.write(`baseline written to ${BASELINE_PATH} for workload "${head.workload}"\n`);
    return;
  }

  const baseline = loadBaselineFor(head.workload);
  if (!baseline) {
    process.stdout.write(
      `no baseline for workload "${head.workload}" at ${BASELINE_PATH} — ` +
      `run with --update to create one.\n`,
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
