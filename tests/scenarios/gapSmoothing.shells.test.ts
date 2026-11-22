/**
 * Shell gap fixtures (netcode gap smoothing plan, section 5.5, jobs S5-6, S5-6a).
 *
 * A naval shell flies a straight line past a drone. The server runs at 60 Hz;
 * the drone rides the binary swarm packet (every tick), the JSON snapshot
 * (every third tick) moves the client clock anchor. Each named profile in
 * gapProfiles.ts decides when packets arrive and when client frames fire
 * (mock clock, 60 frames/s). The REAL client code draws both:
 *
 * - shell: `ShellSalvoStore.place` at the display tick `updateProjectilesMirror`
 *   computes: clock anchor (`updateAnchor`, fed by each coalesced snapshot at
 *   the frame drain) minus `shellDisplayDelayGameMs` of the drone delay
 *   BEFORE the stall hold (`getSwarmSteadyDisplayDelayMs`, S5-6a);
 * - drone: `decodeSwarmPacket` with tick stamping, then
 *   `interpolateSwarmPose`, after `stepSwarmDisplayDelay` once per frame.
 *   The delay target comes from the production feed (`displayDelayFeed.ts`,
 *   S5-7): the swarm inter-arrival EWMA on each swarm packet, the real
 *   `applySnapshotPerfStats` on each coalesced JSON snapshot.
 *
 * Each profile also runs with the old fixed delay (`'fixed'`: the helper
 * given NaN) and with the HELD drone delay (`'held'`, the parked S5-6
 * attempt, which froze shells 3-15 frames through drone stalls) so the
 * before → after numbers sit side by side.
 */
import { describe, it, expect } from 'vitest';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import { ShellSalvoStore } from '../../src/client/net/shellSalvoStore.js';
import { shellDisplayDelayGameMs } from '../../src/client/net/shellDisplayDelay.js';
import { updateAnchor, type AnchorState } from '../../src/client/net/clockAnchor.js';
import {
  getSwarmDisplayDelayMs,
  getSwarmSteadyDisplayDelayMs,
  interpolateSwarmPose,
  resetSwarmTickClock,
  setSwarmDisplaySpeed,
  stepSwarmDisplayDelay,
  type InterpolatedPose,
} from '../../src/client/net/swarmInterpolation.js';
import {
  SWARM_HEADER_BYTES,
  SWARM_KIND_DRONE,
  SWARM_RECORD_BYTES,
  SWARM_REC_ANGVEL_OFF,
  SWARM_REC_RADIUS_OFF,
  SWARM_WIRE_VERSION,
} from '../../src/shared-types/swarmWireFormat.js';
import type { ProjectileRenderState, RenderMirror } from '../../src/core/contracts/IRenderer.js';
import type { NetworkProfile } from './types.js';
import { buildDeliveries, buildFrameTimes } from './runner.js';
import { GAP_PROFILES, type GapProfileName } from './gapProfiles.js';
import { countMotionArtefacts, type MotionCounters, type MotionFrame } from './assertions.js';
import { createDisplayDelayFeed } from './displayDelayFeed.js';

const TICK_MS = 1000 / 60;
const MS_PER_SECOND = 1000;
/** Mirrors runner.ts: tick index 0 is server tick 100. */
const START_SERVER_TICK = 100;
const RUN_MS = 4000;
/** Warm-up excluded from the counters (still used as true-track history). */
const IGNORE_FIRST_MS = 1000;
/** Float tolerance when turning a time into a tick index. */
const TICK_EPSILON = 1e-9;

// Drone: a circle around the origin (as the missile fixture).
const DRONE_ID = 7;
const DRONE_RADIUS_U = 16;
const DRONE_ORBIT_U = 600;
const DRONE_SPEED_U_PER_S = 300;
const DRONE_OMEGA = DRONE_SPEED_U_PER_S / DRONE_ORBIT_U;

// Shell: fired at tick index 0, flies straight for the whole run.
const SHELL_ID = 'proj-1';
const SHELL_X0 = -1500;
const SHELL_Y0 = -400;
const SHELL_VX = 800;
const SHELL_VY = 100;
const SHELL_FLIGHT_TICKS = Math.ceil(RUN_MS / TICK_MS) + 60;

/** |shell − drone| mean lateness (ms) recorded with the steady delay; the
 *  ~15 ms on lan-clean is the clock anchor vs the drone tick clock (a known
 *  offset, out of scope). The fixed delay gave 14.67 and 105.89. S5-7 (delay
 *  target capped at 150 ms, fed by the swarm inter-arrival EWMA): jitter-4g
 *  37.56 -> 38.71 while both are drawn far sooner (drone mean lateness
 *  294.08 -> 155.44, shell ~332 -> 194.15; the fixed delay now gives 32.75):
 *  the gap is mostly the clock anchor's lag on the jittered JSON stream, and
 *  the shell delay now moves with a target that changes every snapshot. */
const RECORDED_SHELL_DRONE_GAP_MS: Partial<Record<GapProfileName, number>> = {
  'lan-clean': 14.67,
  'jitter-4g': 38.71,
};
/** Rounding slack on the recorded gaps (ms). */
const GAP_TOLERANCE_MS = 0.01;

/** fixed: the old 100 game ms; held: the drone delay WITH the stall hold
 *  (the parked S5-6 attempt); steady: the drone delay before the hold (S5-6a). */
type DelayMode = 'fixed' | 'held' | 'steady';

function tickIndexAt(tMs: number): number {
  return Math.floor(tMs / TICK_MS + TICK_EPSILON);
}

function droneTrueAt(tMs: number): { x: number; y: number } {
  const a = (DRONE_OMEGA * tMs) / MS_PER_SECOND;
  return { x: DRONE_ORBIT_U * Math.cos(a), y: DRONE_ORBIT_U * Math.sin(a) };
}

function shellTrueAt(tMs: number): { x: number; y: number } {
  const s = tMs / MS_PER_SECOND;
  return { x: SHELL_X0 + SHELL_VX * s, y: SHELL_Y0 + SHELL_VY * s };
}

/** One drone record on the binary swarm wire (layout: swarmWireFormat.ts). */
function dronePacket(i: number): Uint8Array {
  const tMs = i * TICK_MS;
  const p = droneTrueAt(tMs);
  const a = (DRONE_OMEGA * tMs) / MS_PER_SECOND;
  const buf = new ArrayBuffer(SWARM_HEADER_BYTES + SWARM_RECORD_BYTES);
  const view = new DataView(buf);
  view.setUint8(0, SWARM_WIRE_VERSION);
  view.setUint8(1, 0);
  view.setUint16(2, 1, true);
  view.setUint32(4, START_SERVER_TICK + i, true);
  const off = SWARM_HEADER_BYTES;
  view.setUint16(off + 0, DRONE_ID, true);
  view.setUint8(off + 2, SWARM_KIND_DRONE);
  view.setUint8(off + 3, 0);
  view.setFloat32(off + 4, p.x, true);
  view.setFloat32(off + 8, p.y, true);
  view.setFloat32(off + 12, -Math.sin(a) * DRONE_SPEED_U_PER_S, true);
  view.setFloat32(off + 16, Math.cos(a) * DRONE_SPEED_U_PER_S, true);
  view.setFloat32(off + 20, a, true);
  view.setFloat32(off + SWARM_REC_ANGVEL_OFF, DRONE_OMEGA, true);
  view.setFloat32(off + SWARM_REC_RADIUS_OFF, DRONE_RADIUS_U, true);
  return new Uint8Array(buf);
}

/** A message that lands inside a client frame stall runs when it ends. */
function handledAtMs(profile: NetworkProfile, arriveMs: number): number {
  const stall = profile.frameStalls.find((s) => arriveMs >= s.atMs && arriveMs < s.atMs + s.durationMs);
  return stall ? stall.atMs + stall.durationMs : arriveMs;
}

interface RunResult {
  shell: MotionCounters;
  drone: MotionCounters;
}

function runProfile(profile: NetworkProfile, mode: DelayMode): RunResult {
  resetSwarmTickClock();
  setSwarmDisplaySpeed(1);

  const deliveries = buildDeliveries(profile, RUN_MS)
    .map((d) => ({ d, atMs: handledAtMs(profile, d.arriveMs) }))
    .sort((p, q) => p.atMs - q.atMs);
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  const shells = new ShellSalvoStore();
  shells.applySalvo({
    type: 'shell_salvo', s: 1, o: 'swarm-3', w: 'naval_xl', t: START_SERVER_TICK, n: SHELL_FLIGHT_TICKS,
    sh: [[SHELL_ID, SHELL_X0, SHELL_Y0, SHELL_VX, SHELL_VY]],
  });
  const projectiles = new Map<string, ProjectileRenderState>();
  const bursts: number[] = [];
  let anchor: AnchorState | null = null;
  let pendingTickIndex = -1;
  let pendingAtMs = 0;
  const feed = createDisplayDelayFeed();
  let prevFrameMs = Number.NaN;
  let next = 0;
  const out: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  const shellFrames: MotionFrame[] = [];
  const droneFrames: MotionFrame[] = [];

  for (const now of buildFrameTimes(profile, RUN_MS)) {
    // Swarm decodes at once; JSON waits in the coalescer (newest wins).
    while (next < deliveries.length && deliveries[next]!.atMs <= now) {
      const { d, atMs } = deliveries[next++]!;
      const tickIndex = d.serverTick - START_SERVER_TICK;
      if (d.stream === 'json') {
        pendingTickIndex = tickIndex;
        pendingAtMs = atMs;
        continue;
      }
      feed.swarmArrived(atMs);
      decodeSwarmPacket(dronePacket(tickIndex), mirror, atMs, true);
    }
    if (pendingTickIndex >= 0) {
      // The snapshot re-anchors the clock at the frame drain (1×: game = wall).
      const serverTick = START_SERVER_TICK + pendingTickIndex;
      feed.jsonApplied(serverTick, now, pendingAtMs);
      anchor = anchor === null ? { anchorServerTick: serverTick, anchorPerfNow: now } : updateAnchor(anchor, serverTick, now);
      pendingTickIndex = -1;
    }
    // Once per frame, after the drain and before any read (updateSwarmMirror).
    stepSwarmDisplayDelay(Number.isNaN(prevFrameMs) ? 0 : now - prevFrameMs, now);
    prevFrameMs = now;

    if (anchor !== null) {
      // updateProjectilesMirror's display tick.
      const delayWallMs = mode === 'fixed' ? Number.NaN
        : mode === 'held' ? getSwarmDisplayDelayMs() : getSwarmSteadyDisplayDelayMs();
      const delayGameMs = shellDisplayDelayGameMs(delayWallMs, 1);
      const displayTick = anchor.anchorServerTick + (now - anchor.anchorPerfNow) / TICK_MS - delayGameMs / TICK_MS;
      shells.place(projectiles, displayTick, bursts);
      const p = projectiles.get(SHELL_ID);
      if (p) {
        const t = shellTrueAt(now);
        shellFrames.push({ atMs: now, drawnX: p.x, drawnY: p.y, trueX: t.x, trueY: t.y });
      }
    }
    const entry = mirror.swarm?.get(DRONE_ID);
    if (entry) {
      interpolateSwarmPose(entry, now, out);
      const t = droneTrueAt(now);
      droneFrames.push({ atMs: now, drawnX: out.x, drawnY: out.y, trueX: t.x, trueY: t.y });
    }
  }
  expect(tickIndexAt(RUN_MS)).toBeLessThan(SHELL_FLIGHT_TICKS);
  const opts = { ignoreFirstMs: IGNORE_FIRST_MS };
  return { shell: countMotionArtefacts(shellFrames, opts), drone: countMotionArtefacts(droneFrames, opts) };
}

const cache = new Map<string, RunResult>();
function result(name: GapProfileName, mode: DelayMode): RunResult {
  const key = `${name}/${mode}`;
  let r = cache.get(key);
  if (!r) {
    r = runProfile(GAP_PROFILES[name], mode);
    cache.set(key, r);
  }
  return r;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

interface Recorded {
  snaps: number;
  largestSnapU: number;
  freezeFrames: number;
  backwardSteps: number;
  meanLatenessMs: number;
  maxLatenessMs: number;
  /** The drone's mean lateness on the same profile, for comparison. */
  droneMeanLatenessMs: number;
  droneFreeze: number;
}

function recorded(r: RunResult): Recorded {
  const s = r.shell;
  return {
    snaps: s.snaps,
    largestSnapU: round2(s.largestSnapU),
    freezeFrames: s.freezeFrames,
    backwardSteps: s.backwardSteps,
    meanLatenessMs: round2(s.meanLatenessMs),
    maxLatenessMs: round2(s.maxLatenessMs),
    droneMeanLatenessMs: round2(r.drone.meanLatenessMs),
    droneFreeze: r.drone.freezeFrames,
  };
}

const PROFILES = Object.keys(GAP_PROFILES) as GapProfileName[];

describe('gap smoothing: shell fixtures (plan 5.5, S5-6a)', () => {
  it('the run is deterministic', () => {
    expect(recorded(runProfile(GAP_PROFILES['jitter-4g'], 'steady'))).toEqual(recorded(result('jitter-4g', 'steady')));
  });

  it.each(PROFILES)('recorded numbers: %s', (name) => {
    // Printed for the record; asserted by the tests below.
    console.log(name, JSON.stringify({ fixed: recorded(result(name, 'fixed')), held: recorded(result(name, 'held')), steady: recorded(result(name, 'steady')) }));
  });

  it.each(PROFILES)('%s: the steady delay adds no shell freezes or snaps over the fixed delay', (name) => {
    const fixed = result(name, 'fixed').shell;
    const steady = result(name, 'steady').shell;
    expect(steady.freezeFrames).toBeLessThanOrEqual(fixed.freezeFrames);
    expect(steady.snaps).toBeLessThanOrEqual(fixed.snaps);
    expect(steady.backwardSteps).toBeLessThanOrEqual(fixed.backwardSteps);
  });

  it.each(Object.keys(RECORDED_SHELL_DRONE_GAP_MS) as GapProfileName[])(
    '%s: shell − drone lateness is no worse than recorded',
    (name) => {
      const r = result(name, 'steady');
      const gap = Math.abs(r.shell.meanLatenessMs - r.drone.meanLatenessMs);
      expect(gap).toBeLessThanOrEqual(RECORDED_SHELL_DRONE_GAP_MS[name]! + GAP_TOLERANCE_MS);
    },
  );
});
