/**
 * Missile gap fixtures (netcode gap smoothing plan, section 5.4 and 9.1,
 * job S1-4). Records TODAY's numbers; fixes nothing.
 *
 * A homing missile chases a target drone. The server runs at 60 Hz; the
 * missile rides the JSON snapshot (every third tick), the drone rides the
 * binary swarm packet (every tick). Each named profile in gapProfiles.ts
 * decides when packets arrive and when client frames fire (mock clock,
 * 60 frames/s). The REAL client code draws both:
 *
 * - missile: `applyMissileSnapshot` (stamped at apply time, after the
 *   snapshot coalescer keeps only the newest pending snapshot per frame)
 *   then `resolveMissileDisplayPose` (fixed 100 game-ms delay, 250 ms glide
 *   cap then freeze);
 * - drone: `decodeSwarmPacket` with tick stamping, then
 *   `interpolateSwarmPose`, with the adaptive delay fed the way
 *   `ColyseusClient` + `snapshotPerfStats.ts` feed it (binary inter-arrival
 *   EWMA × ADAPTIVE_DELAY_FACTOR + JSON drop bias).
 *
 * `countMotionArtefacts` scores the drawn tracks against the truth.
 */
import { describe, it, expect } from 'vitest';
import { applyMissileSnapshot, resolveMissileDisplayPose } from '../../src/client/combat/MissileMirror.js';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import {
  ADAPTIVE_DELAY_FACTOR,
  DISPLAY_DELAY_MS,
  interpolateSwarmPose,
  resetSwarmTickClock,
  setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed,
  type InterpolatedPose,
} from '../../src/client/net/swarmInterpolation.js';
import {
  computeInterpBiasMs,
  createDropDetector,
  observeSnapshotTick,
} from '../../src/client/net/snapshotDropDetector.js';
import {
  SWARM_HEADER_BYTES,
  SWARM_KIND_DRONE,
  SWARM_RECORD_BYTES,
  SWARM_REC_ANGVEL_OFF,
  SWARM_REC_RADIUS_OFF,
  SWARM_WIRE_VERSION,
} from '../../src/shared-types/swarmWireFormat.js';
import type { RenderMirror } from '../../src/core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../src/shared-types/messages/snapshotMessages.js';
import type { NetworkProfile } from './types.js';
import { buildDeliveries, buildFrameTimes } from './runner.js';
import { GAP_PROFILES, type GapProfileName } from './gapProfiles.js';
import { countMotionArtefacts, type MotionCounters, type MotionFrame } from './assertions.js';

const TICK_MS = 1000 / 60;
const MS_PER_SECOND = 1000;
/** Mirrors runner.ts: tick index 0 is server tick 100. */
const START_SERVER_TICK = 100;
const RUN_MS = 4000;
/** Warm-up excluded from the counters (still used as true-track history). */
const IGNORE_FIRST_MS = 1000;
/** Float tolerance when turning a time into a tick index. */
const TICK_EPSILON = 1e-9;

// Target drone: a circle around the origin.
const DRONE_ID = 7;
const DRONE_RADIUS_U = 16;
const DRONE_ORBIT_U = 600;
const DRONE_SPEED_U_PER_S = 300;
const DRONE_OMEGA = DRONE_SPEED_U_PER_S / DRONE_ORBIT_U;

// Homing missile: constant speed, turn rate capped, steering at the drone.
const MISSILE_ID = 1;
const MISSILE_START_X = -2600;
const MISSILE_START_Y = -1800;
const MISSILE_SPEED_U_PER_S = 450;
const MISSILE_MAX_TURN_RAD_PER_S = 1.5;
const MISSILE_LIFE_MS = 8000;
/** Closest the missile may get to the drone in RUN_MS (it must not hit). */
const MIN_MISS_DISTANCE_U = 100;
/** Binary inter-arrival sample cap, mirrors ColyseusClient's swarm handler. */
const SWARM_EWMA_SAMPLE_CAP_MS = 500;
const SWARM_EWMA_KEEP = 0.85;

/** "Same lateness" for the target test: mean lateness within this (ms). */
const SAME_LATENESS_TOLERANCE_MS = 2;

interface MissilePose { x: number; y: number; angle: number; angvel: number; prevAngvel: number }

function shortestArc(target: number, source: number): number {
  let d = target - source;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function droneTrueAt(tMs: number): { x: number; y: number } {
  const a = (DRONE_OMEGA * tMs) / MS_PER_SECOND;
  return { x: DRONE_ORBIT_U * Math.cos(a), y: DRONE_ORBIT_U * Math.sin(a) };
}

/** Constant-turn arc, heading dir(θ) = (−sinθ, cosθ) as MissileSimulation. */
function arc(x: number, y: number, angle: number, angvel: number, dtSec: number): { x: number; y: number; angle: number } {
  const next = angle + angvel * dtSec;
  if (angvel === 0) {
    return { x: x - Math.sin(angle) * MISSILE_SPEED_U_PER_S * dtSec, y: y + Math.cos(angle) * MISSILE_SPEED_U_PER_S * dtSec, angle: next };
  }
  const r = MISSILE_SPEED_U_PER_S / angvel;
  return { x: x + r * (Math.cos(next) - Math.cos(angle)), y: y + r * (Math.sin(next) - Math.sin(angle)), angle: next };
}

/** Server missile state per tick. `angvel` steers tick i → i+1; `prevAngvel`
 *  is what the wire carries at tick i ((newAngle − oldAngle) / DT). */
function buildMissileTrack(ticks: number): MissilePose[] {
  const out: MissilePose[] = [];
  let x = MISSILE_START_X;
  let y = MISSILE_START_Y;
  let angle = 0;
  let prevAngvel = 0;
  const dtSec = TICK_MS / MS_PER_SECOND;
  const maxTurn = MISSILE_MAX_TURN_RAD_PER_S * dtSec;
  for (let i = 0; i <= ticks; i++) {
    const target = droneTrueAt(i * TICK_MS);
    const desired = Math.atan2(-(target.x - x), target.y - y);
    const turn = Math.max(-maxTurn, Math.min(maxTurn, shortestArc(desired, angle)));
    const angvel = turn / dtSec;
    out.push({ x, y, angle, angvel, prevAngvel });
    const n = arc(x, y, angle, angvel, dtSec);
    x = n.x; y = n.y; angle = n.angle;
    prevAngvel = angvel;
  }
  return out;
}

function tickIndexAt(tMs: number): number {
  return Math.floor(tMs / TICK_MS + TICK_EPSILON);
}

function missileTrueAt(track: ReadonlyArray<MissilePose>, tMs: number): { x: number; y: number } {
  const i = Math.min(tickIndexAt(tMs), track.length - 1);
  const s = track[i]!;
  return arc(s.x, s.y, s.angle, s.angvel, (tMs - i * TICK_MS) / MS_PER_SECOND);
}

function missileSlice(track: ReadonlyArray<MissilePose>, i: number): NonNullable<SnapshotMessage['missiles']> {
  const s = track[i]!;
  return [{
    id: MISSILE_ID,
    x: s.x, y: s.y,
    vx: -Math.sin(s.angle) * MISSILE_SPEED_U_PER_S,
    vy: Math.cos(s.angle) * MISSILE_SPEED_U_PER_S,
    angle: s.angle,
    angvel: s.prevAngvel,
    ownerId: 'player-a',
    weaponId: 'heat-seeker',
    lifePct: 1 - (i * TICK_MS) / MISSILE_LIFE_MS,
  }];
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
  missile: MotionCounters;
  drone: MotionCounters;
  minDistanceU: number;
}

function runProfile(profile: NetworkProfile): RunResult {
  resetSwarmTickClock();
  setSwarmDisplaySpeed(1);
  setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);

  const track = buildMissileTrack(tickIndexAt(RUN_MS) + 1);
  const deliveries = buildDeliveries(profile, RUN_MS)
    .map((d) => ({ d, atMs: handledAtMs(profile, d.arriveMs) }))
    .sort((p, q) => p.atMs - q.atMs);
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  const dropDetector = createDropDetector();
  let swarmEwma = 0;
  let swarmLastMs = -1;
  let pendingJson: { tickIndex: number; recvMs: number } | null = null;
  let lastAppliedRecvMs = 0;
  let next = 0;
  const out: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  const missileFrames: MotionFrame[] = [];
  const droneFrames: MotionFrame[] = [];
  let minDistanceU = Infinity;

  for (const now of buildFrameTimes(profile, RUN_MS)) {
    // Messages handled before this frame: swarm decodes at once; JSON waits
    // in the coalescer (newest wins) for the frame's drain.
    while (next < deliveries.length && deliveries[next]!.atMs <= now) {
      const { d, atMs } = deliveries[next++]!;
      const tickIndex = d.serverTick - START_SERVER_TICK;
      if (d.stream === 'json') {
        pendingJson = { tickIndex, recvMs: atMs };
        continue;
      }
      if (swarmLastMs >= 0) {
        const dtMs = Math.min(SWARM_EWMA_SAMPLE_CAP_MS, atMs - swarmLastMs);
        if (dtMs > 0) swarmEwma = swarmEwma === 0 ? dtMs : swarmEwma * SWARM_EWMA_KEEP + dtMs * (1 - SWARM_EWMA_KEEP);
      }
      swarmLastMs = atMs;
      decodeSwarmPacket(dronePacket(tickIndex), mirror, atMs, true);
    }
    if (pendingJson) {
      const { tickIndex, recvMs } = pendingJson;
      pendingJson = null;
      applyMissileSnapshot(missileSlice(track, tickIndex), mirror, START_SERVER_TICK + tickIndex, now);
      if (lastAppliedRecvMs > 0 && recvMs - lastAppliedRecvMs > 0) {
        observeSnapshotTick(dropDetector, START_SERVER_TICK + tickIndex);
        setSwarmDisplayDelayMs(swarmEwma * ADAPTIVE_DELAY_FACTOR + computeInterpBiasMs(dropDetector.dropCount));
      }
      lastAppliedRecvMs = recvMs;
    }

    const mTrue = missileTrueAt(track, now);
    const dTrue = droneTrueAt(now);
    minDistanceU = Math.min(minDistanceU, Math.hypot(mTrue.x - dTrue.x, mTrue.y - dTrue.y));
    const m = resolveMissileDisplayPose(mirror, MISSILE_ID, now);
    if (m) missileFrames.push({ atMs: now, drawnX: m.x, drawnY: m.y, trueX: mTrue.x, trueY: mTrue.y });
    const entry = mirror.swarm?.get(DRONE_ID);
    if (entry) {
      interpolateSwarmPose(entry, now, out);
      droneFrames.push({ atMs: now, drawnX: out.x, drawnY: out.y, trueX: dTrue.x, trueY: dTrue.y });
    }
  }
  const opts = { ignoreFirstMs: IGNORE_FIRST_MS };
  return { missile: countMotionArtefacts(missileFrames, opts), drone: countMotionArtefacts(droneFrames, opts), minDistanceU };
}

const cache = new Map<GapProfileName, RunResult>();
function result(name: GapProfileName): RunResult {
  let r = cache.get(name);
  if (!r) {
    r = runProfile(GAP_PROFILES[name]);
    cache.set(name, r);
  }
  return r;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;

interface Recorded {
  snaps: number;
  largestSnapU: number;
  totalSnapU: number;
  freezeFrames: number;
  backwardSteps: number;
  meanLatenessMs: number;
  maxLatenessMs: number;
  /** The target drone's mean lateness on the same profile, for comparison. */
  droneMeanLatenessMs: number;
}

function recorded(r: RunResult): Recorded {
  const m = r.missile;
  return {
    snaps: m.snaps,
    largestSnapU: round2(m.largestSnapU),
    totalSnapU: round2(m.totalSnapU),
    freezeFrames: m.freezeFrames,
    backwardSteps: m.backwardSteps,
    meanLatenessMs: round2(m.meanLatenessMs),
    maxLatenessMs: round2(m.maxLatenessMs),
    droneMeanLatenessMs: round2(r.drone.meanLatenessMs),
  };
}

type MissileProfile = Exclude<GapProfileName, 'gap-swarm-only'>;

/** Today's numbers (before any S5 change). Sizes in world units, lateness in
 *  ms of simulated time; values rounded to 0.01. */
const TODAY: Readonly<Record<MissileProfile, Recorded>> = {
  'lan-clean': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 116.67, maxLatenessMs: 116.67, droneMeanLatenessMs: 102 },
  'gap-200': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 150, maxLatenessMs: 150, droneMeanLatenessMs: 141.5 },
  'gap-400': { snaps: 1, largestSnapU: 37.5, totalSnapU: 37.5, freezeFrames: 5, backwardSteps: 0, meanLatenessMs: 151.38, maxLatenessMs: 233.33, droneMeanLatenessMs: 157.84 },
  'gap-600': { snaps: 1, largestSnapU: 127.5, totalSnapU: 127.5, freezeFrames: 17, backwardSteps: 0, meanLatenessMs: 164.09, maxLatenessMs: 433.33, droneMeanLatenessMs: 178.96 },
  'burst-600-both-streams': { snaps: 1, largestSnapU: 127.5, totalSnapU: 127.5, freezeFrames: 17, backwardSteps: 0, meanLatenessMs: 164.09, maxLatenessMs: 433.33, droneMeanLatenessMs: 178.96 },
  'gap-json-only': { snaps: 1, largestSnapU: 37.5, totalSnapU: 37.5, freezeFrames: 5, backwardSteps: 0, meanLatenessMs: 151.38, maxLatenessMs: 233.33, droneMeanLatenessMs: 149.67 },
  'frame-stall-250': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 150, maxLatenessMs: 150, droneMeanLatenessMs: 144.43 },
  'jitter-4g': { snaps: 21, largestSnapU: 67.5, totalSnapU: 375, freezeFrames: 12, backwardSteps: 9, meanLatenessMs: 187.75, maxLatenessMs: 300, droneMeanLatenessMs: 155.15 },
};

const PROFILES = Object.keys(TODAY) as MissileProfile[];

describe('gap smoothing: missile fixtures (today, plan 5.4)', () => {
  it('the scripted missile chases the drone without reaching it', () => {
    for (const name of PROFILES) expect(result(name).minDistanceU).toBeGreaterThan(MIN_MISS_DISTANCE_U);
  });

  it('the run is deterministic', () => {
    expect(recorded(runProfile(GAP_PROFILES['jitter-4g']))).toEqual(recorded(result('jitter-4g')));
  });

  it.each(PROFILES)('recorded numbers: %s', (name) => {
    expect(recorded(result(name))).toEqual(TODAY[name]);
  });

  // Today the missile is drawn at a fixed 100 ms delay from apply-time stamps
  // while the drone delay adapts on tick stamps. Worst |missile − drone| mean
  // lateness today: 32.60 ms (jitter-4g: missile 187.75, drone 155.15).
  // Per profile (missile − drone, ms): lan-clean +14.67, gap-200 +8.50,
  // gap-400 −6.46, gap-600 −14.87, burst-600-both-streams −14.87,
  // gap-json-only +1.71, frame-stall-250 +5.57, jitter-4g +32.60.
  it.fails('missile and target drone drawn at the same lateness', () => {
    for (const name of PROFILES) {
      const r = result(name);
      expect(Math.abs(r.missile.meanLatenessMs - r.drone.meanLatenessMs)).toBeLessThanOrEqual(SAME_LATENESS_TOLERANCE_MS);
    }
  });
});
