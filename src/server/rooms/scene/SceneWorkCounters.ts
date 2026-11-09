/**
 * Server WORK counters for a perf scene (plan machine-independent-perf WS3).
 *
 * Counts, not timings: how much work a tick did (bodies the physics stepped,
 * contacts it reported, AI agents it thought for, swarm records and bytes it
 * encoded, snapshot entities it sent). A slow host runs the same scene tick
 * for tick (the scene script is tick-driven), so these per-tick averages
 * don't depend on how fast the machine is. They gate every PR
 * (`tests/integration/sectorRoom/perfSceneCounts.test.ts`).
 *
 * Plain numeric fields only: every increment is on the per-tick path
 * (invariant #14). Counting runs only while `active` (scene started, not
 * ended), so a room without a scene pays one boolean check per site.
 *
 * CPU time rides along (print-only, never gated):
 *  - `cpuMsPerTick`: `process.cpuUsage()` deltas over batches of
 *    `CPU_BATCH_TICKS` ticks (one small object a second, never per tick). It
 *    is PROCESS CPU: the main thread, the physics workers and anything else in
 *    the process. The room's tick loop is a `setImmediate` spin (SectorRoom
 *    "Hi-res tick loop"), so the main thread reads ~100 % busy whatever the
 *    work; this number tracks the workers + spin, not the tick's work.
 *  - `updateCpuMsPerTick`: the main thread's CPU inside `update()`, from
 *    `process.threadCpuUsage()` around 1 tick in `UPDATE_SAMPLE_EVERY`
 *    (two small objects per sampled tick). Null where the runtime lacks it
 *    (Node < 23.9, e.g. CI's Node 22).
 *  - `workerElu`: the physics worker's event-loop utilisation over the scene.
 */
export const CPU_BATCH_TICKS = 60;
export const UPDATE_SAMPLE_EVERY = 10;

export interface SceneWorkView {
  /** Scene ticks counted. */
  ticks: number;
  /** Per tick: bodies in the physics world after the step (SAB count). */
  bodiesPerTick: number;
  /** Per tick: contact-force events the worker reported (above its force floor). */
  contactsPerTick: number;
  /** Per tick: AI agents ticked. */
  aiAgentsPerTick: number;
  /** Per tick: binary swarm records encoded, summed over recipients. */
  swarmRecordsPerTick: number;
  /** Per tick: binary swarm bytes encoded, summed over recipients. */
  swarmBytesPerTick: number;
  /** JSON snapshots sent per tick (all recipients). */
  snapshotsPerTick: number;
  /** Entities (drones + projectiles + missiles + asteroids) per JSON snapshot sent. */
  entitiesPerSnapshot: number;
  /** Print-only: process CPU ms per tick (null until one batch completed). */
  cpuMsPerTick: number | null;
  /** Print-only: main-thread CPU ms inside update(), sampled (null when the runtime can't tell). */
  updateCpuMsPerTick: number | null;
  /** Print-only: wall ms per tick over the same batches. */
  wallMsPerTick: number | null;
  /** Print-only: physics worker busy fraction over the scene (event-loop utilisation). */
  workerElu: number | null;
}

type ThreadCpu = () => { user: number; system: number };
const threadCpu: ThreadCpu | null = (process as unknown as { threadCpuUsage?: ThreadCpu }).threadCpuUsage?.bind(process) ?? null;

export class SceneWorkCounters {
  active = false;
  ticks = 0;
  bodies = 0;
  contacts = 0;
  aiAgents = 0;
  swarmRecords = 0;
  swarmBytes = 0;
  snapshots = 0;
  snapshotEntities = 0;

  // CPU batches (print-only).
  private batchTicks = 0;
  private batchCpu: NodeJS.CpuUsage | null = null;
  private sampleStart: { user: number; system: number } | null = null;
  private updateUs = 0;
  private updateSamples = 0;
  private batchWall = 0;
  private cpuUs = 0;
  private wallMs = 0;
  private cpuTicks = 0;

  /** Top of `update()`: start a CPU sample on 1 tick in UPDATE_SAMPLE_EVERY. */
  beginUpdate(): void {
    if (this.active && threadCpu !== null && this.ticks % UPDATE_SAMPLE_EVERY === 0) this.sampleStart = threadCpu();
  }

  /** Close a scene tick: called once per server tick while the scene runs. */
  endTick(bodies: number, aiAgents: number): void {
    if (this.sampleStart !== null && threadCpu !== null) {
      this.updateUs += cpuUs(threadCpu()) - cpuUs(this.sampleStart);
      this.updateSamples++;
      this.sampleStart = null;
    }
    this.ticks++;
    this.bodies += bodies;
    this.aiAgents += aiAgents;
    if (this.batchTicks === 0) {
      this.batchCpu = process.cpuUsage();
      this.batchWall = performance.now();
    }
    if (++this.batchTicks < CPU_BATCH_TICKS) return;
    const d = process.cpuUsage(this.batchCpu ?? undefined);
    this.cpuUs += d.user + d.system;
    this.wallMs += performance.now() - this.batchWall;
    this.cpuTicks += this.batchTicks;
    this.batchTicks = 0;
  }

  view(workerElu: number | null): SceneWorkView {
    const t = Math.max(1, this.ticks);
    const r = (v: number, dp = 2): number => Math.round(v * 10 ** dp) / 10 ** dp;
    const c = this.cpuTicks;
    return {
      ticks: this.ticks,
      bodiesPerTick: r(this.bodies / t),
      contactsPerTick: r(this.contacts / t),
      aiAgentsPerTick: r(this.aiAgents / t),
      swarmRecordsPerTick: r(this.swarmRecords / t),
      swarmBytesPerTick: r(this.swarmBytes / t, 0),
      snapshotsPerTick: r(this.snapshots / t, 3),
      entitiesPerSnapshot: r(this.snapshotEntities / Math.max(1, this.snapshots)),
      cpuMsPerTick: c > 0 ? r(this.cpuUs / 1000 / c, 3) : null,
      updateCpuMsPerTick: this.updateSamples > 0 ? r(this.updateUs / 1000 / this.updateSamples, 3) : null,
      wallMsPerTick: c > 0 ? r(this.wallMs / c, 3) : null,
      workerElu: workerElu === null ? null : r(workerElu, 3),
    };
  }
}

function cpuUs(u: { user: number; system: number }): number { return u.user + u.system; }
