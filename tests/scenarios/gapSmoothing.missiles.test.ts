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
 * - missile: `applyMissileSnapshot` (applied after the snapshot coalescer
 *   keeps only the newest pending snapshot per frame; stamped from its
 *   server tick on the drone tick clock, S5-2)
 *   then `resolveMissileDisplayPose` (the missile stream's own display delay
 *   that `stepMissileDisplayDelay` puts on the mirror each frame: the drone
 *   delay's target, S5-4, held on the JSON stream's stalls, S5-5; 250 ms
 *   glide cap then freeze);
 * - drone: `decodeSwarmPacket` with tick stamping, then
 *   `interpolateSwarmPose`. Once per frame, after the drain and before any
 *   read, `stepSwarmDisplayDelay(frameDtMs, now)` glides the delay toward
 *   its target and runs the stall hold, as production
 *   (`updateSwarmMirror`) and `gapSmoothing.drones.test.ts` do. The target
 *   comes from the production feed (`displayDelayFeed.ts`, S5-7): the swarm
 *   inter-arrival EWMA on each swarm packet, the real
 *   `applySnapshotPerfStats` on each applied JSON snapshot.
 *
 * `countMotionArtefacts` scores the drawn tracks against the truth.
 */
import { describe, it, expect } from 'vitest';
import { applyMissileSnapshot, resetMissileDisplayDelay, resolveMissileDisplayPose, stepMissileDisplayDelay } from '../../src/client/combat/MissileMirror.js';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import {
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
import type { RenderMirror } from '../../src/core/contracts/IRenderer.js';
import type { SnapshotMessage } from '../../src/shared-types/messages/snapshotMessages.js';
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
  resetMissileDisplayDelay();
  setSwarmDisplaySpeed(1);

  const track = buildMissileTrack(tickIndexAt(RUN_MS) + 1);
  const deliveries = buildDeliveries(profile, RUN_MS)
    .map((d) => ({ d, atMs: handledAtMs(profile, d.arriveMs) }))
    .sort((p, q) => p.atMs - q.atMs);
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  let pendingTickIndex = -1;
  let pendingAtMs = 0;
  const feed = createDisplayDelayFeed();
  let prevFrameMs = Number.NaN;
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
        pendingTickIndex = tickIndex;
        pendingAtMs = atMs;
        continue;
      }
      feed.swarmArrived(atMs);
      decodeSwarmPacket(dronePacket(tickIndex), mirror, atMs, true);
    }
    if (pendingTickIndex >= 0) {
      const tickIndex = pendingTickIndex;
      pendingTickIndex = -1;
      feed.jsonApplied(START_SERVER_TICK + tickIndex, now, pendingAtMs);
      applyMissileSnapshot(missileSlice(track, tickIndex), mirror, START_SERVER_TICK + tickIndex, now);
    }
    // Once per frame, after the drain and before any read, as production.
    const frameDtMs = Number.isNaN(prevFrameMs) ? 0 : now - prevFrameMs;
    stepSwarmDisplayDelay(frameDtMs, now);
    stepMissileDisplayDelay(mirror, frameDtMs, now);
    prevFrameMs = now;

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

/** Recorded numbers: missile samples on the drone tick timeline (S5-2), read
 *  at the missile stream's own display delay (drone target, S5-4; JSON stream
 *  stall hold, S5-5), both delays stepped each frame as production. Before
 *  S5-5 (missiles read the drone delay, no missile hold): gap-400 1 snap of
 *  14.2 u, lateness 210.57; gap-600 / burst 1 snap of 15.7 u, lateness
 *  248.44; gap-json-only 1 snap of 41.95 u, lateness 141.81. Freezes, max
 *  lateness and the other profiles are unchanged by S5-5. Sizes in world units, lateness in ms of simulated
 *  time; values rounded to 0.01. Before S5-2 (arrival stamps): lan-clean
 *  lateness 116.67; gap-400 / gap-json-only snap 37.5; gap-600 / burst snap
 *  127.5; frame-stall-250 lateness 150; jitter-4g 21 snaps (375 u), 12 freeze
 *  frames, 9 backward steps. Before S5-4 (fixed 100 ms missile delay):
 *  gap-200 lateness 140.1; gap-400 snap 41.95 (lateness 141.81); gap-600 /
 *  burst snap 131.95 (lateness 155.17); jitter-4g 7 snaps, largest 6.94,
 *  total 34.64, 0 backward steps, lateness 148.19 (max 165.41). jitter-4g's
 *  one backward step (0.69 u, at 1016 ms) is the curve interpolation running
 *  a's arc for the stamp span (66.5 ms) when the two ticks are 50 ms apart,
 *  then the extrapolation from b starting behind it; the larger delay moved
 *  the read point onto that pair. S5-7 (delay target = swarm inter-arrival
 *  EWMA x 1.5 + drop bias, ceiling 150 ms instead of the lateness estimate up
 *  to 280 ms; missiles read that target): gap-200 lateness 192.01 -> 141.13
 *  (max 307.77 -> 147.52); gap-400 221.66 -> 160.56 (max 319.03 -> 233.33);
 *  gap-600 / burst 258.66 -> 256.68; gap-json-only 157.32 -> 160.56 and
 *  frame-stall-250 140.1 -> 142.01 (the target now follows the real cadence
 *  instead of sitting at the 100 ms floor); jitter-4g lateness 292.26 ->
 *  154.46 (max 342.02 -> 185.93), 7 snaps as before, largest 6.85 -> 6.95,
 *  total 32.23 -> 35.05, backward steps 1 -> 0 (the smaller delay leaves the
 *  50 ms tick pair above). Snaps and freezes are otherwise unchanged. One
 *  tick-clock drift per frame (the drone clock no longer drifts once per
 *  packet of a burst; `swarmTickToStampMs` sees the same spent drift, so the
 *  missile reads the drone timeline exactly): lan-clean lateness 102.15 ->
 *  102 (= the drone), other profiles 0.04-0.1 ms sooner (max 147.52 -> 147.42);
 *  gap-200 drone 141.41 -> 141.1; jitter-4g snaps 7 -> 5, largest 6.95 ->
 *  5.21, total 35.05 -> 23.53, lateness 154.46 -> 152.83 (max 185.93 ->
 *  184.44), drone 155.44 -> 153.88. */
const TODAY: Readonly<Record<MissileProfile, Recorded>> = {
  'lan-clean': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 102, maxLatenessMs: 102, droneMeanLatenessMs: 102 },
  'gap-200': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 141.03, maxLatenessMs: 147.42, droneMeanLatenessMs: 141.1 },
  'gap-400': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 5, backwardSteps: 0, meanLatenessMs: 160.48, maxLatenessMs: 233.33, droneMeanLatenessMs: 155.54 },
  'gap-600': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 17, backwardSteps: 0, meanLatenessMs: 256.64, maxLatenessMs: 433.33, droneMeanLatenessMs: 238.53 },
  'burst-600-both-streams': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 17, backwardSteps: 0, meanLatenessMs: 256.64, maxLatenessMs: 433.33, droneMeanLatenessMs: 238.53 },
  'gap-json-only': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 5, backwardSteps: 0, meanLatenessMs: 160.48, maxLatenessMs: 233.33, droneMeanLatenessMs: 147.65 },
  'frame-stall-250': { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 141.92, maxLatenessMs: 147.42, droneMeanLatenessMs: 141.92 },
  'jitter-4g': { snaps: 5, largestSnapU: 5.21, totalSnapU: 23.53, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 152.83, maxLatenessMs: 184.44, droneMeanLatenessMs: 153.88 },
};

const PROFILES = Object.keys(TODAY) as MissileProfile[];

/** Profiles with a stall of both streams longer than the 250 ms glide cap.
 *  Each stream holds on its OWN newest stamp (S5-5, D10 = A), and the
 *  missile's newest sample is up to two ticks (~33 ms) older than the drone's
 *  (the JSON stream carries every third tick), so the missile record holds
 *  that much earlier and resumes that much later; both then slew back at the
 *  same bounded rate, so the offset lasts the whole catch-up. Missile − drone
 *  mean lateness, before S5-5 → S5-5 → now (S5-7, capped delay): gap-400
 *  +0.98 → +12.07 → +5.02; gap-600 and burst-600-both-streams +3.10 →
 *  +13.33 → +18.16 (before S5-5 the missile was NOT
 *  held: it froze at its cap and then snapped 15.7 u onto the drone's read
 *  point). Equal lateness here needs the missile read point to follow the
 *  drone's hold, which a JSON-only stall would then not hold. */
const STALL_HOLD_PROFILES: ReadonlySet<MissileProfile> = new Set<MissileProfile>(['gap-400', 'gap-600', 'burst-600-both-streams']);

/** A JSON-only stall holds missiles and not drones (S5-5): the missile is
 *  drawn later than the drone by design here (+12.92 ms mean; S5-5 +17.32,
 *  the drone delay then sat at the floor; before S5-5 +1.81 ms, with a
 *  41.95 u snap on resume). */
const JSON_ONLY_STALL: MissileProfile = 'gap-json-only';

function latenessGapMs(name: MissileProfile): number {
  const r = result(name);
  return Math.abs(r.missile.meanLatenessMs - r.drone.meanLatenessMs);
}

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

  // Missiles read the shared drone display delay (S5-4). Before it, missile −
  // drone mean lateness (ms): lan-clean +0.15, gap-200 −52.21, gap-400
  // −67.78, gap-600 −90.16, burst-600-both-streams −90.16, gap-json-only
  // +1.81, frame-stall-250 +0.10, jitter-4g −145.89. After S5-4: +0.15, −0.30,
  // +0.98, +3.10, +3.10, +1.81, +0.10, −1.82. After S5-5 the stall profiles
  // move (see STALL_HOLD_PROFILES, JSON_ONLY_STALL); the rest are unchanged.
  // After S5-7 (capped delay): +0.15, −0.27, (+5.02, +18.16, +18.16, +12.92),
  // +0.10, −0.98.
  it('missile and target drone drawn at the same lateness', () => {
    for (const name of PROFILES) {
      if (STALL_HOLD_PROFILES.has(name) || name === JSON_ONLY_STALL) continue;
      expect(latenessGapMs(name)).toBeLessThanOrEqual(SAME_LATENESS_TOLERANCE_MS);
    }
  });

  it('a JSON-only stall holds the missile and not the drone (S5-5)', () => {
    const r = result(JSON_ONLY_STALL);
    expect(r.missile.snaps).toBe(0);
    expect(r.missile.meanLatenessMs).toBeGreaterThan(r.drone.meanLatenessMs + SAME_LATENESS_TOLERANCE_MS);
    expect(r.drone.freezeFrames).toBe(0);
  });

  // Not met by S5-5 (see STALL_HOLD_PROFILES): zero snaps, but the missile
  // stream's own hold starts up to two ticks before the drone's.
  it.fails('missile and target drone drawn at the same lateness through a stall of both streams (S5-5)', () => {
    for (const name of STALL_HOLD_PROFILES) {
      expect(latenessGapMs(name)).toBeLessThanOrEqual(SAME_LATENESS_TOLERANCE_MS);
    }
  });
});
