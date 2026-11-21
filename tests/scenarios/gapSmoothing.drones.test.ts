/**
 * Drone gap-smoothing fixtures (netcode gap smoothing plan, sections 3.1 and
 * 9.1, job S1-3): today's numbers on every network profile.
 *
 * Drives the REAL drone path on a mock clock at 60 frames/s:
 *   - every packet of `buildDeliveries(profile)` (runner.ts) on the swarm
 *     stream becomes a binary swarm packet decoded by `decodeSwarmPacket`
 *     with tick stamping, drained once per frame (as the live client);
 *   - every JSON snapshot drives the display-delay feed exactly as
 *     `applySnapshotPerfStats` does: binary inter-arrival EWMA x
 *     ADAPTIVE_DELAY_FACTOR + drop bias from the real drop detector;
 *   - every frame reads both drones through `interpolateSwarmPose`.
 * Ground truth: a straight drone and a turning drone, both at 300 u/s.
 * The drawn tracks are scored by `countMotionArtefacts` (assertions.ts);
 * the swarm counters come from swarmInterpolation.ts.
 *
 * Recorded tests assert today's exact numbers so any change shows up. The
 * `it.fails` tests are target behaviour that fails today.
 */
import { describe, it, expect } from 'vitest';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import {
  interpolateSwarmPose,
  resetSwarmTickClock,
  setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed,
  getSwarmDisplayDelayMs,
  getSwarmLatenessMaxMs,
  getSwarmLatenessSumMs,
  getSwarmLatenessCount,
  getSwarmOverwriteUnreadCount,
  getSwarmOldEndClampCount,
  getSwarmGlideLimitCount,
  DISPLAY_DELAY_MS,
  ADAPTIVE_DELAY_FACTOR,
} from '../../src/client/net/swarmInterpolation.js';
import { createDropDetector, observeSnapshotTick, computeInterpBiasMs } from '../../src/client/net/snapshotDropDetector.js';
import type { RenderMirror } from '../../src/core/contracts/IRenderer.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES, SWARM_REC_ANGVEL_OFF, SWARM_REC_RADIUS_OFF, SWARM_WIRE_VERSION, SWARM_KIND_DRONE,
} from '../../src/shared-types/swarmWireFormat.js';
import { buildDeliveries, buildFrameTimes } from './runner.js';
import { GAP_PROFILES, GAP_AT_MS, type GapProfileName } from './gapProfiles.js';
import { countMotionArtefacts, type MotionFrame, type MotionCounters } from './assertions.js';
import type { NetworkProfile } from './types.js';

/** Scenario length (wall ms): stalls start at GAP_AT_MS and the longest ends 600 ms later. */
const FIXTURE_DURATION_MS = 4000;
/** Frames before this are warm-up (ring filling, EWMA seeding) and not scored. */
const IGNORE_FIRST_MS = 1000;
/** runner.ts numbers server ticks from here (NET_START_SERVER_TICK). */
const START_TICK = 100;
const TICK_MS = 1000 / 60;
const STRAIGHT_ID = 1;
const TURNING_ID = 2;
const DRONE_SPEED_U_PER_S = 300;
const TURN_RADIUS_U = 500;
const TURN_RATE_RAD_PER_S = DRONE_SPEED_U_PER_S / TURN_RADIUS_U;
const DRONE_RADIUS_U = 12;
const MS_PER_S = 1000;
/** Mirrors the `swarm` handler in ColyseusClient.ts: EWMA weights and the inter-arrival sample clamp. */
const SWARM_EWMA_KEEP = 0.85;
const SWARM_EWMA_TAKE = 0.15;
const SWARM_EWMA_SAMPLE_CLAMP_MS = 500;
/** Delay held for the 3.1 pin-to-oldest test. */
const PIN_TEST_DELAY_MS = 200;
const ROUND = 100;

interface TruePose { x: number; y: number; vx: number; vy: number; angle: number; angvel: number }

function straightTruth(gameMs: number): TruePose {
  return { x: (DRONE_SPEED_U_PER_S * gameMs) / MS_PER_S, y: 0, vx: DRONE_SPEED_U_PER_S, vy: 0, angle: 0, angvel: 0 };
}

function turningTruth(gameMs: number): TruePose {
  const a = (TURN_RATE_RAD_PER_S * gameMs) / MS_PER_S;
  return {
    x: TURN_RADIUS_U * Math.sin(a),
    y: TURN_RADIUS_U * (1 - Math.cos(a)),
    vx: DRONE_SPEED_U_PER_S * Math.cos(a),
    vy: DRONE_SPEED_U_PER_S * Math.sin(a),
    angle: a,
    angvel: TURN_RATE_RAD_PER_S,
  };
}

function writeRecord(v: DataView, o: number, id: number, p: TruePose): void {
  v.setUint16(o, id, true);
  v.setUint8(o + 2, SWARM_KIND_DRONE);
  v.setFloat32(o + 4, p.x, true);
  v.setFloat32(o + 8, p.y, true);
  v.setFloat32(o + 12, p.vx, true);
  v.setFloat32(o + 16, p.vy, true);
  v.setFloat32(o + 20, p.angle, true);
  v.setFloat32(o + SWARM_REC_ANGVEL_OFF, p.angvel, true);
  v.setFloat32(o + SWARM_REC_RADIUS_OFF, DRONE_RADIUS_U, true);
}

/** One binary swarm packet carrying both drones at server tick `tick`. */
function swarmPacket(tick: number): Uint8Array {
  const buf = new ArrayBuffer(SWARM_HEADER_BYTES + 2 * SWARM_RECORD_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, SWARM_WIRE_VERSION);
  v.setUint8(1, 0);
  v.setUint16(2, 2, true);
  v.setUint32(4, tick, true);
  const gameMs = (tick - START_TICK) * TICK_MS;
  writeRecord(v, SWARM_HEADER_BYTES, STRAIGHT_ID, straightTruth(gameMs));
  writeRecord(v, SWARM_HEADER_BYTES + SWARM_RECORD_BYTES, TURNING_ID, turningTruth(gameMs));
  return new Uint8Array(buf);
}

/** The profile on the game-time axis: at time scale s the server ticks s x as
 *  often per wall ms, while the link delay and stalls stay in wall ms. */
function profileInGameTime(p: NetworkProfile, timeScale: number): NetworkProfile {
  if (timeScale === 1) return p;
  return {
    ...p,
    baseDelayMs: p.baseDelayMs * timeScale,
    ...(p.jitter ? { jitter: { gapP50Ms: p.jitter.gapP50Ms * timeScale, gapP95Ms: p.jitter.gapP95Ms * timeScale, gapP99Ms: p.jitter.gapP99Ms * timeScale } } : {}),
    gaps: p.gaps.map((g) => ({ ...g, atMs: g.atMs * timeScale, durationMs: g.durationMs * timeScale })),
  };
}

interface DroneFixtureOptions {
  /** Sector game speed (S1-9 adds 0.7x and 2x). Default 1. */
  timeScale?: number;
  /** Hold the display delay here instead of running the adaptive feed. */
  fixedDelayMs?: number;
}

interface MotionSummary {
  snaps: number;
  largestSnapU: number;
  totalSnapU: number;
  freezeFrames: number;
  backwardSteps: number;
  meanLatenessMs: number;
  maxLatenessMs: number;
}

interface DroneFixtureResult {
  straight: MotionSummary;
  turning: MotionSummary;
  overwriteUnread: number;
  oldEndClamps: number;
  glideLimitHolds: number;
  /** Tick-clock stamp lateness (wall ms), mean and max over all packets. */
  stampLatenessMeanMs: number;
  stampLatenessMaxMs: number;
  /** Largest display delay the feed set during the run (wall ms). */
  maxDelayMs: number;
}

const round = (n: number): number => Math.round(n * ROUND) / ROUND;

function summarise(c: MotionCounters): MotionSummary {
  return {
    snaps: c.snaps,
    largestSnapU: round(c.largestSnapU),
    totalSnapU: round(c.totalSnapU),
    freezeFrames: c.freezeFrames,
    backwardSteps: c.backwardSteps,
    meanLatenessMs: round(c.meanLatenessMs),
    maxLatenessMs: round(c.maxLatenessMs),
  };
}

/** Run both drones through one profile and score them. Pure: same profile, same numbers. */
function runDroneFixture(profile: NetworkProfile, opts: DroneFixtureOptions = {}): DroneFixtureResult {
  const timeScale = opts.timeScale ?? 1;
  resetSwarmTickClock();
  setSwarmDisplaySpeed(timeScale);
  setSwarmDisplayDelayMs(opts.fixedDelayMs ?? DISPLAY_DELAY_MS);

  const deliveries = buildDeliveries(profileInGameTime(profile, timeScale), FIXTURE_DURATION_MS * timeScale);
  const frameTimes = buildFrameTimes(profile, FIXTURE_DURATION_MS);
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  const drop = createDropDetector();
  const pose = { x: 0, y: 0, angle: 0 };
  const straightFrames: MotionFrame[] = [];
  const turningFrames: MotionFrame[] = [];
  let next = 0;
  let ewma = 0;
  let lastSwarmMs = -1;
  let lastJsonMs = -1;
  let maxDelayMs = getSwarmDisplayDelayMs();

  for (const t of frameTimes) {
    // Drain everything that arrived by this frame, in arrival order.
    while (next < deliveries.length && deliveries[next]!.arriveMs / timeScale <= t) {
      const d = deliveries[next++]!;
      if (d.stream === 'swarm') {
        if (lastSwarmMs >= 0) {
          const dtMs = Math.min(SWARM_EWMA_SAMPLE_CLAMP_MS, t - lastSwarmMs);
          if (dtMs > 0) ewma = ewma === 0 ? dtMs : ewma * SWARM_EWMA_KEEP + dtMs * SWARM_EWMA_TAKE;
        }
        lastSwarmMs = t;
        decodeSwarmPacket(swarmPacket(d.serverTick), mirror, t, true);
      } else {
        const arriveMs = d.arriveMs / timeScale;
        const intervalMs = lastJsonMs > 0 ? arriveMs - lastJsonMs : 0;
        lastJsonMs = arriveMs;
        if (intervalMs > 0 && opts.fixedDelayMs === undefined) {
          observeSnapshotTick(drop, d.serverTick);
          setSwarmDisplayDelayMs(ewma * ADAPTIVE_DELAY_FACTOR + computeInterpBiasMs(drop.dropCount));
          maxDelayMs = Math.max(maxDelayMs, getSwarmDisplayDelayMs());
        }
      }
    }
    const straight = mirror.swarm?.get(STRAIGHT_ID);
    const turning = mirror.swarm?.get(TURNING_ID);
    if (!straight || !turning) continue;
    const gameMs = t * timeScale;
    interpolateSwarmPose(straight, t, pose);
    const st = straightTruth(gameMs);
    straightFrames.push({ atMs: t, drawnX: pose.x, drawnY: pose.y, trueX: st.x, trueY: st.y });
    interpolateSwarmPose(turning, t, pose);
    const tt = turningTruth(gameMs);
    turningFrames.push({ atMs: t, drawnX: pose.x, drawnY: pose.y, trueX: tt.x, trueY: tt.y });
  }

  const count = getSwarmLatenessCount();
  return {
    straight: summarise(countMotionArtefacts(straightFrames, { ignoreFirstMs: IGNORE_FIRST_MS })),
    turning: summarise(countMotionArtefacts(turningFrames, { ignoreFirstMs: IGNORE_FIRST_MS })),
    overwriteUnread: getSwarmOverwriteUnreadCount(),
    oldEndClamps: getSwarmOldEndClampCount(),
    glideLimitHolds: getSwarmGlideLimitCount(),
    stampLatenessMeanMs: round(count > 0 ? getSwarmLatenessSumMs() / count : 0),
    stampLatenessMaxMs: round(getSwarmLatenessMaxMs()),
    maxDelayMs: round(maxDelayMs),
  };
}

/** Today's numbers (recorded 2026-11-21, time scale 1). A change to any is a behaviour change. */
const RECORDED: Record<GapProfileName, DroneFixtureResult> = {
  'lan-clean': {
    straight: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 116.67, maxLatenessMs: 116.67 },
    turning: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 116.67, maxLatenessMs: 116.67 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 0, stampLatenessMaxMs: 0, maxDelayMs: 100,
  },
  'gap-200': {
    straight: { snaps: 3, largestSnapU: 3.67, totalSnapU: 9.6, freezeFrames: 0, backwardSteps: 1, meanLatenessMs: 151.08, maxLatenessMs: 185.94 },
    turning: { snaps: 3, largestSnapU: 3.67, totalSnapU: 9.6, freezeFrames: 0, backwardSteps: 1, meanLatenessMs: 151.09, maxLatenessMs: 185.94 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 5.03, stampLatenessMaxMs: 198, maxDelayMs: 124.18,
  },
  'gap-400': {
    straight: { snaps: 2, largestSnapU: 47.75, totalSnapU: 62.75, freezeFrames: 12, backwardSteps: 0, meanLatenessMs: 166.16, maxLatenessMs: 350 },
    turning: { snaps: 2, largestSnapU: 47.82, totalSnapU: 62.82, freezeFrames: 12, backwardSteps: 0, meanLatenessMs: 166.17, maxLatenessMs: 350.1 },
    overwriteUnread: 60, oldEndClamps: 60, glideLimitHolds: 24,
    stampLatenessMeanMs: 18.01, stampLatenessMaxMs: 396, maxDelayMs: 223.36,
  },
  'gap-600': {
    straight: { snaps: 2, largestSnapU: 105, totalSnapU: 120, freezeFrames: 24, backwardSteps: 0, meanLatenessMs: 186.74, maxLatenessMs: 550 },
    turning: { snaps: 2, largestSnapU: 104.92, totalSnapU: 119.92, freezeFrames: 24, backwardSteps: 0, meanLatenessMs: 186.76, maxLatenessMs: 550.1 },
    overwriteUnread: 72, oldEndClamps: 66, glideLimitHolds: 48,
    stampLatenessMeanMs: 37.48, stampLatenessMaxMs: 594, maxDelayMs: 280,
  },
  'burst-600-both-streams': {
    straight: { snaps: 2, largestSnapU: 105, totalSnapU: 120, freezeFrames: 24, backwardSteps: 0, meanLatenessMs: 186.74, maxLatenessMs: 550 },
    turning: { snaps: 2, largestSnapU: 104.92, totalSnapU: 119.92, freezeFrames: 24, backwardSteps: 0, meanLatenessMs: 186.76, maxLatenessMs: 550.1 },
    overwriteUnread: 72, oldEndClamps: 66, glideLimitHolds: 48,
    stampLatenessMeanMs: 37.48, stampLatenessMaxMs: 594, maxDelayMs: 280,
  },
  'gap-json-only': {
    straight: { snaps: 2, largestSnapU: 15, totalSnapU: 20, freezeFrames: 0, backwardSteps: 1, meanLatenessMs: 158.29, maxLatenessMs: 200 },
    turning: { snaps: 2, largestSnapU: 15, totalSnapU: 20, freezeFrames: 0, backwardSteps: 1, meanLatenessMs: 158.29, maxLatenessMs: 200 },
    overwriteUnread: 60, oldEndClamps: 60, glideLimitHolds: 0,
    stampLatenessMeanMs: 0, stampLatenessMaxMs: 0, maxDelayMs: 158.33,
  },
  'gap-swarm-only': {
    straight: { snaps: 3, largestSnapU: 45, totalSnapU: 60.15, freezeFrames: 12, backwardSteps: 0, meanLatenessMs: 158.72, maxLatenessMs: 350 },
    turning: { snaps: 3, largestSnapU: 45.07, totalSnapU: 60.22, freezeFrames: 12, backwardSteps: 0, meanLatenessMs: 158.73, maxLatenessMs: 350.1 },
    overwriteUnread: 6, oldEndClamps: 6, glideLimitHolds: 24,
    stampLatenessMeanMs: 18.01, stampLatenessMaxMs: 396, maxDelayMs: 115,
  },
  'frame-stall-250': {
    straight: { snaps: 1, largestSnapU: 5.47, totalSnapU: 5.47, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 150.62, maxLatenessMs: 168.22 },
    turning: { snaps: 1, largestSnapU: 5.47, totalSnapU: 5.47, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 150.62, maxLatenessMs: 168.18 },
    overwriteUnread: 24, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 7.59, stampLatenessMaxMs: 247.5, maxDelayMs: 100,
  },
  'jitter-4g': {
    straight: { snaps: 4, largestSnapU: 10.06, totalSnapU: 29, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 157.9, maxLatenessMs: 183.54 },
    turning: { snaps: 4, largestSnapU: 10.06, totalSnapU: 29, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 157.9, maxLatenessMs: 183.54 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 6,
    stampLatenessMeanMs: 42.95, stampLatenessMaxMs: 208.71, maxDelayMs: 100,
  },
};

const PROFILE_NAMES = Object.keys(GAP_PROFILES) as GapProfileName[];

describe('drone gap-smoothing fixtures: today\'s numbers per profile', () => {
  for (const name of PROFILE_NAMES) {
    it(`${name}: recorded numbers`, () => {
      const result = runDroneFixture(GAP_PROFILES[name]);
      expect(result).toEqual(RECORDED[name]);
    });
  }

  it('is deterministic: the same profile twice gives the same numbers', () => {
    expect(runDroneFixture(GAP_PROFILES['jitter-4g'])).toEqual(runDroneFixture(GAP_PROFILES['jitter-4g']));
  });

  it('stalls start after warm-up', () => {
    expect(GAP_AT_MS).toBeGreaterThan(IGNORE_FIRST_MS);
  });
});

describe('drone gap-smoothing targets (fail today)', () => {
  // Plan 3.1: the 10-deep ring spans ~150 ms of tick-stamped history, so a
  // 200 ms delay reads before the oldest pose on every frame.
  // Today: 462 old-end clamps (and 460 overwrites before read) on lan-clean
  // at a held 200 ms delay, both drones, 4 s.
  it.fails('no pin-to-oldest reads at a 200 ms delay', () => {
    const result = runDroneFixture(GAP_PROFILES['lan-clean'], { fixedDelayMs: PIN_TEST_DELAY_MS });
    expect(result.oldEndClamps).toBe(0);
  });

  // Today: 2 snaps (straight, largest 47.75 u) + 2 (turning, largest 47.82 u) at gap-400.
  it.fails('zero snaps at gap-400', () => {
    const result = runDroneFixture(GAP_PROFILES['gap-400']);
    expect(result.straight.snaps + result.turning.snaps).toBe(0);
  });
});
