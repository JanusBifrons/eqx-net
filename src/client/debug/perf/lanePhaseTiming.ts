/**
 * Phone-lane frame phase timing (docs/ops/phone-link.md "Play evidence").
 *
 * Lane builds only (installed with the lane frame summary, `laneFrameSummary.ts`):
 * the game RAF loop, the renderer's `update()` passes and its Pixi ticker
 * (camera, fleet overlay, art, Pixi's own `app.render`) add each phase's
 * `performance.now()` delta into one preallocated `Float64Array`. The array
 * rolls once per processed frame, where the RAF stall detector measures the
 * frame gap (`recordLaneFrame`): a frame over `LANE_STALL_PHASE_MS` keeps its
 * breakdown, and `withLaneStallContext` stamps it on the stall event
 * (`raf_stutter`, `raf_gap`, `loaf`) as `phases`.
 *
 * Off the lane (and inside the renderer worker, which never installs it) every
 * mark is one null check. Per frame it allocates nothing (#14); the `phases`
 * object is built only when a stall event fires.
 *
 * No imports: the render zone (and the worker bundle) reads it.
 */

/** Phase names, in frame order. The index is the phase id. */
export const LANE_PHASES = [
  // Game RAF loop (app/gameRafLoop.ts)
  'inbound', // tickInbound: transport drain, snapshot apply
  'physics', // tickPhysics: input + prediction step
  'mirror', // updateMirror: render-mirror sync
  // PixiRenderer.update() passes (render/pixi/framePasses.ts)
  'ships', // hit targets, ship sprites, death explosions
  'connectors', // the structures' connector web (ConnectorRenderer)
  'swarm', // swarm sprites: structures, drones, rocks, wrecks
  'farIcons', // far-zoom icons
  'turretsLit', // turret shots + lit scene feed
  'sweep', // unseen-sprite sweep
  'projectiles', // projectiles, missiles, server ghost
  'beamsCamera', // beams + camera follow
  'backdrop', // sky, starfield, grid
  'hudOverlays', // damage numbers, hits, brackets, cut field, labels, halo
  'feedback', // renderer feedback write
  'effects', // EffectsService tick
  // Pixi ticker (render/pixi/rendererSetup/initTicker.ts)
  'cameraTick',
  'fleetOverlay',
  'art', // art pack tick, lit pass, art collection
  'pixiRender', // Pixi's own app.render (scene walk, batching, GL submit)
] as const;

export type LanePhaseName = (typeof LANE_PHASES)[number];

/** Phase ids by name (`LanePhase.swarm` → its index in `LANE_PHASES`). */
export const LanePhase = Object.freeze(
  Object.fromEntries(LANE_PHASES.map((n, i) => [n, i])) as { [K in LanePhaseName]: number },
);

/** A frame gap over this keeps its phase breakdown (the `raf_stutter` floor). */
export const LANE_STALL_PHASE_MS = 30;

/** Per-frame phase sums plus the last stall frame's copy. Allocation-free per frame. */
export class LanePhaseRecorder {
  /** This frame's phase sums (ms), indexed by phase id. */
  readonly cur = new Float64Array(LANE_PHASES.length);
  /** The last stall frame's sums. */
  readonly stall = new Float64Array(LANE_PHASES.length);
  /** That stall frame's gap (ms); 0 = none yet. */
  stallGapMs = 0;
  /** When it rolled (`roll`'s `nowMs`). */
  stallAtMs = 0;

  add(phase: number, ms: number): void {
    this.cur[phase]! += ms;
  }

  /** Close the frame: a gap over `LANE_STALL_PHASE_MS` keeps its sums; then zero. */
  roll(gapMs: number, nowMs: number): void {
    if (gapMs > LANE_STALL_PHASE_MS) {
      this.stall.set(this.cur);
      this.stallGapMs = gapMs;
      this.stallAtMs = nowMs;
    }
    this.cur.fill(0);
  }

  /** The last stall frame's phases over 0.05 ms, rounded to 0.1 ms (allocates: stall events only). */
  stallPhases(): Record<string, number> | null {
    if (this.stallGapMs === 0) return null;
    const out: Record<string, number> = {};
    for (let i = 0; i < LANE_PHASES.length; i++) {
      const ms = this.stall[i]!;
      if (ms >= 0.05) out[LANE_PHASES[i]!] = Math.round(ms * 10) / 10;
    }
    return out;
  }
}

let rec: LanePhaseRecorder | null = null;

/** Lane builds: start recording (idempotent). Returns the recorder. */
export function installLanePhaseTiming(): LanePhaseRecorder {
  return (rec ??= new LanePhaseRecorder());
}

/** Test seam: drop the recorder. */
export function resetLanePhaseTimingForTest(): void {
  rec = null;
}

export function lanePhaseRecorder(): LanePhaseRecorder | null {
  return rec;
}

/** A phase's start stamp: `performance.now()` on the lane, 0 (no clock read) off it. */
export function lanePhaseStart(): number {
  // Real time: perf probe (debug/ is on the real-time allowlist)
  return rec === null ? 0 : performance.now();
}

/**
 * Add `now - since` to `phase` and return `now`, so marks chain:
 * `t = lanePhaseMark(LanePhase.ships, t)`. Off the lane: one null check.
 */
export function lanePhaseMark(phase: number, since: number): number {
  if (rec === null) return 0;
  // Real time: perf probe (debug/ is on the real-time allowlist)
  const now = performance.now();
  if (since > 0) rec.cur[phase]! += now - since; // 0: the chain began before install
  return now;
}

/**
 * The game RAF loop's three phases from its existing stamps (`gameRafLoop.ts`):
 * inbound = tickInbound, physics = tickPhysics, mirror = updateMirror plus the
 * one-shot camera glides. `inboundStart` is 0 off the lane.
 */
export function markLaneLoopPhases(inboundStart: number, physicsStart: number, mirrorStart: number, renderStart: number): void {
  if (rec === null || inboundStart === 0) return; // 0: installed mid-frame
  const c = rec.cur;
  c[LanePhase.inbound]! += physicsStart - inboundStart;
  c[LanePhase.physics]! += mirrorStart - physicsStart;
  c[LanePhase.mirror]! += renderStart - mirrorStart;
}

/** Close the frame (called with the processed frame's gap, `recordLaneFrame`). */
export function rollLanePhases(gapMs: number): void {
  // Real time: perf probe (debug/ is on the real-time allowlist)
  if (rec !== null) rec.roll(gapMs, performance.now());
}

/**
 * Stamp a stall event's data with the last stall frame's breakdown
 * (`phases`, ms by phase) and how long ago it rolled (`phasesAgeMs`: ~0 for
 * `raf_stutter` / `raf_gap`, later for a `loaf`, which reports after the frame).
 */
export function applyLanePhases<T extends object>(data: T): T {
  if (rec === null) return data;
  const phases = rec.stallPhases();
  if (phases === null) return data;
  const d = data as Record<string, unknown>;
  d['phases'] = phases;
  // Real time: perf probe (debug/ is on the real-time allowlist)
  d['phasesAgeMs'] = Math.round(performance.now() - rec.stallAtMs);
  return data;
}
