/**
 * Drone gap-smoothing fixtures (netcode gap smoothing plan, sections 3.1 and
 * 9.1, job S1-3): today's numbers on every network profile.
 *
 * Drives the REAL drone path on a mock clock at 60 frames/s:
 *   - every packet of `buildDeliveries(profile)` (runner.ts) on the swarm
 *     stream becomes a binary swarm packet decoded by `decodeSwarmPacket`
 *     with tick stamping, drained once per frame (as the live client);
 *   - the display-delay target comes from the drone packet lateness
 *     estimate inside `swarmArrivalStampMs` (S3-3), as in production; the
 *     JSON stream no longer feeds it;
 *   - every frame reads both drones through `interpolateSwarmPose`.
 * Ground truth: a straight drone and a turning drone, both at 300 u/s.
 * The drawn tracks are scored by `countMotionArtefacts` (assertions.ts);
 * the swarm counters come from swarmInterpolation.ts.
 *
 * Recorded tests assert today's exact numbers so any change shows up. The
 * `it.fails` tests are target behaviour that fails today.
 *
 * S4-5 adds the stream-stall hold (`stepSwarmDisplayDelay(frameMs, nowMs)`)
 * and two fixtures past its 400 ms bound: gap-1000 (a 1 s stall on both
 * streams) and idle-resume (no swarm packets for 4 s, then current ticks).
 */
import { describe, it, expect } from 'vitest';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import {
  interpolateSwarmPose,
  resetSwarmTickClock,
  setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed,
  stepSwarmDisplayDelay,
  getSwarmDisplayDelayMs,
  getSwarmLatenessMaxMs,
  getSwarmLatenessSumMs,
  getSwarmLatenessCount,
  getSwarmOverwriteUnreadCount,
  getSwarmOldEndClampCount,
  getSwarmGlideLimitCount,
  getSwarmLatenessEstimateMs,
  getSwarmDisplayDelayTargetMs,
  getSwarmResyncCount,
  getSwarmHoldFrameCount,
  DISPLAY_DELAY_MS,
  MAX_TOTAL_DISPLAY_DELAY_MS,
  DISPLAY_DELAY_SLEW_MAX_RATE,
} from '../../src/client/net/swarmInterpolation.js';
import type { RenderMirror } from '../../src/core/contracts/IRenderer.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES, SWARM_REC_ANGVEL_OFF, SWARM_REC_RADIUS_OFF, SWARM_WIRE_VERSION, SWARM_KIND_DRONE,
} from '../../src/shared-types/swarmWireFormat.js';
import { buildDeliveries, buildFrameTimes } from './runner.js';
import { GAP_PROFILES, GAP_AT_MS, type GapProfileName } from './gapProfiles.js';
import { countMotionArtefacts, type MotionFrame, type MotionCounters } from './assertions.js';
import type { Delivery, NetworkProfile } from './types.js';
import { captureToDeliveries, loadCaptureFixture } from './ondeviceReplay.js';

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
/** One 60 Hz frame (wall ms). */
const FRAME_WALL_MS = 1000 / 60;
/** Stall the drones ride out without freezing: the 250 ms glide limit plus the
 *  100 ms delay floor (S4-5 freeze-frame target). */
const FREEZE_ALLOWANCE_MS = 350;
/** Delay held for the 3.1 pin-to-oldest test. */
const PIN_TEST_DELAY_MS = 200;
const ROUND = 100;
/** Float slack on the per-frame slew bound check (wall ms). */
const SLEW_EPSILON_MS = 1e-9;
const CAPTURE_FIXTURE = 'capture-2026-11-21';

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
  /** Pin the display delay here instead of running the lateness feed. */
  fixedDelayMs?: number;
  /** Scenario length (wall ms). Default FIXTURE_DURATION_MS. */
  durationMs?: number;
  /** Called once per frame after both reads, with the frame time (wall ms). */
  onFrame?: (t: number) => void;
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
  /** Largest display delay used by a frame's reads during the run (wall ms):
   *  the slewed value after that frame's step (S3-2). */
  maxDelayMs: number;
  /** Smallest display delay a frame's reads used (wall ms). */
  minDelayMs: number;
  /** Frames whose delay change exceeded DISPLAY_DELAY_SLEW_MAX_RATE x the
   *  frame's own wall time (must stay 0). A frame the stall hold set (S4-5)
   *  may grow the delay up to the frame's wall time (the read point stands
   *  still, never goes back); a counted re-sync is exempt. */
  delayStepsOverBound: number;
  /** Largest smoothed lateness estimate seen after a frame's drain (wall ms). */
  maxLatenessEstimateMs: number;
  /** Counted re-syncs (S4-4/S4-5). */
  resyncs: number;
  /** Frames on which a stream stall held the read point (S4-5). */
  holdFrames: number;
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
  const durationMs = opts.durationMs ?? FIXTURE_DURATION_MS;
  const deliveries = buildDeliveries(profileInGameTime(profile, timeScale), durationMs * timeScale);
  return runDroneDeliveries(deliveries, buildFrameTimes(profile, durationMs), opts);
}

/** Run both drones through a ready delivery list (arrivals in game ms) and
 *  client frame times (wall ms). */
function runDroneDeliveries(
  deliveries: ReadonlyArray<Delivery>,
  frameTimes: ReadonlyArray<number>,
  opts: DroneFixtureOptions = {},
): DroneFixtureResult {
  const timeScale = opts.timeScale ?? 1;
  resetSwarmTickClock();
  setSwarmDisplaySpeed(timeScale);
  if (opts.fixedDelayMs !== undefined) setSwarmDisplayDelayMs(opts.fixedDelayMs);

  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  const pose = { x: 0, y: 0, angle: 0 };
  const straightFrames: MotionFrame[] = [];
  const turningFrames: MotionFrame[] = [];
  let next = 0;
  let maxDelayMs = getSwarmDisplayDelayMs();
  let minDelayMs = Infinity;
  let maxEstimateMs = 0;
  let delayStepsOverBound = 0;
  let prevFrameMs = Number.NaN;

  for (const t of frameTimes) {
    // Drain everything that arrived by this frame, in arrival order.
    while (next < deliveries.length && deliveries[next]!.arriveMs / timeScale <= t) {
      const d = deliveries[next++]!;
      if (d.stream === 'swarm') decodeSwarmPacket(swarmPacket(d.serverTick), mirror, t, true);
    }
    // Once per frame, after the drain and before any read, as production
    // (`updateSwarmMirror`): the delay glides toward the feed's target.
    maxEstimateMs = Math.max(maxEstimateMs, getSwarmLatenessEstimateMs());
    const frameDtMs = Number.isNaN(prevFrameMs) ? 0 : t - prevFrameMs;
    const delayBeforeMs = getSwarmDisplayDelayMs();
    const resyncsBefore = getSwarmResyncCount();
    const holdsBefore = getSwarmHoldFrameCount();
    stepSwarmDisplayDelay(frameDtMs, t);
    prevFrameMs = t;
    const delayChangeMs = getSwarmDisplayDelayMs() - delayBeforeMs;
    if (getSwarmResyncCount() !== resyncsBefore) {
      // A counted re-sync: the delay is placed at its target in one step.
    } else if (getSwarmHoldFrameCount() !== holdsBefore) {
      if (delayChangeMs > frameDtMs + SLEW_EPSILON_MS) delayStepsOverBound++;
    } else if (Math.abs(delayChangeMs) > DISPLAY_DELAY_SLEW_MAX_RATE * frameDtMs + SLEW_EPSILON_MS) {
      delayStepsOverBound++;
    }
    maxDelayMs = Math.max(maxDelayMs, getSwarmDisplayDelayMs());
    minDelayMs = Math.min(minDelayMs, getSwarmDisplayDelayMs());
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
    opts.onFrame?.(t);
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
    minDelayMs: round(minDelayMs),
    delayStepsOverBound,
    maxLatenessEstimateMs: round(maxEstimateMs),
    resyncs: getSwarmResyncCount(),
    holdFrames: getSwarmHoldFrameCount(),
  };
}

/** Capture deliveries: each JSON snapshot as captured, plus one swarm packet
 *  per server tick riding the same link lag as the JSON snapshot that
 *  follows it (both streams share the connection, as `jitter-4g`). */
function captureSegmentDeliveries(json: ReadonlyArray<Delivery>): Delivery[] {
  const out: Delivery[] = [];
  let swarmSeq = 0;
  let prevTick = json[0]!.serverTick - 1;
  let lastSwarmArrive = -Infinity;
  for (const j of json) {
    const lagMs = j.arriveMs - j.sendMs;
    for (let tick = prevTick + 1; tick <= j.serverTick; tick++) {
      const sendMs = (tick - START_TICK) * TICK_MS;
      lastSwarmArrive = Math.max(lastSwarmArrive, sendMs + lagMs);
      out.push({ stream: 'swarm', seq: swarmSeq++, serverTick: tick, sendMs, arriveMs: lastSwarmArrive });
    }
    prevTick = j.serverTick;
    out.push(j);
  }
  out.sort((a, b) => a.arriveMs - b.arriveMs || a.sendMs - b.sendMs || (a.stream === 'json' ? -1 : 1) - (b.stream === 'json' ? -1 : 1));
  return out;
}

/** 60 Hz frame times covering a delivery list (no frame stalls). */
function frameTimesFor(deliveries: ReadonlyArray<Delivery>): number[] {
  const endMs = deliveries[deliveries.length - 1]!.arriveMs;
  const out: number[] = [];
  for (let n = 1; n * TICK_MS <= endMs; n++) out.push(n * TICK_MS);
  return out;
}

/** The capture fixture, one drone run per join segment. */
function runCaptureFixture(): DroneFixtureResult[] {
  return captureToDeliveries(loadCaptureFixture(CAPTURE_FIXTURE)).map((json) => {
    const deliveries = captureSegmentDeliveries(json);
    return runDroneDeliveries(deliveries, frameTimesFor(deliveries));
  });
}

/** Today's numbers (recorded 2026-11-21, time scale 1; re-recorded for the
 *  21-deep pose ring, S3a-1, for the slewed display delay, S3-2, and for the
 *  delay target sized from packet lateness, S3-3: lan-clean and gap-json-only
 *  hold the 100 ms floor on every frame; after a stall or under jitter the
 *  target rises toward the 280 ms ceiling and slews back, so mean lateness
 *  rises and glide-limit holds fall; and for the 250 ms glide limit, S4-1:
 *  gap-400 and gap-600 freeze later and snap less far, with the same snap
 *  count); and for the 28-deep ring, S4-3: frame-stall-250's burst now fits
 *  the ring, so it no longer overwrites unread slots (2 -> 0) and every
 *  motion number is unchanged); and for the stream-stall hold, S4-5: through a
 *  whole-stream stall the delay grows so the read point parks at the newest
 *  stamp + glide limit, then slews back. gap-400, gap-swarm-only, gap-600 and
 *  burst-600-both-streams: straight-drone snaps 2 -> 0, turning 2 -> 1 (the
 *  straight-line glide misses the curve: the S4b gate), glide-limit holds -> 0,
 *  freeze frames unchanged, max delay 256 -> 275 / 237 -> 350; capture segment
 *  1: glide-limit holds 8 -> 0, largest snap 13.15 -> 12; lan-clean, gap-200,
 *  gap-json-only, frame-stall-250 and jitter-4g unchanged). A change to any is a
 *  behaviour change. */
const RECORDED: Record<GapProfileName, DroneFixtureResult> = {
  'lan-clean': {
    straight: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 116.67, maxLatenessMs: 116.67 },
    turning: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 116.67, maxLatenessMs: 116.67 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 0, stampLatenessMaxMs: 0, maxDelayMs: 100, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 0, resyncs: 0, holdFrames: 0,
  },
  'gap-200': {
    straight: { snaps: 1, largestSnapU: 3.12, totalSnapU: 3.12, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 202.34, maxLatenessMs: 317.67 },
    turning: { snaps: 1, largestSnapU: 3.12, totalSnapU: 3.12, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 202.34, maxLatenessMs: 317.67 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 5.03, stampLatenessMaxMs: 198, maxDelayMs: 267.67, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 116.79, resyncs: 0, holdFrames: 0,
  },
  'gap-400': {
    straight: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 3, backwardSteps: 0, meanLatenessMs: 215.33, maxLatenessMs: 325.46 },
    turning: { snaps: 1, largestSnapU: 2.56, totalSnapU: 2.56, freezeFrames: 3, backwardSteps: 0, meanLatenessMs: 215.4, maxLatenessMs: 325.46 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 21.01, stampLatenessMaxMs: 400, maxDelayMs: 275.46, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 275.39, resyncs: 0, holdFrames: 3,
  },
  'gap-600': {
    straight: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 15, backwardSteps: 0, meanLatenessMs: 251.9, maxLatenessMs: 400 },
    turning: { snaps: 1, largestSnapU: 3.27, totalSnapU: 3.27, freezeFrames: 15, backwardSteps: 0, meanLatenessMs: 252.09, maxLatenessMs: 401.78 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 46.64, stampLatenessMaxMs: 600, maxDelayMs: 350, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 424.71, resyncs: 0, holdFrames: 15,
  },
  'burst-600-both-streams': {
    straight: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 15, backwardSteps: 0, meanLatenessMs: 251.9, maxLatenessMs: 400 },
    turning: { snaps: 1, largestSnapU: 3.27, totalSnapU: 3.27, freezeFrames: 15, backwardSteps: 0, meanLatenessMs: 252.09, maxLatenessMs: 401.78 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 46.64, stampLatenessMaxMs: 600, maxDelayMs: 350, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 424.71, resyncs: 0, holdFrames: 15,
  },
  'gap-json-only': {
    straight: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 150, maxLatenessMs: 150 },
    turning: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 150, maxLatenessMs: 150 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 0, stampLatenessMaxMs: 0, maxDelayMs: 100, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 0, resyncs: 0, holdFrames: 0,
  },
  'gap-swarm-only': {
    straight: { snaps: 0, largestSnapU: 0, totalSnapU: 0, freezeFrames: 3, backwardSteps: 0, meanLatenessMs: 215.33, maxLatenessMs: 325.46 },
    turning: { snaps: 1, largestSnapU: 2.56, totalSnapU: 2.56, freezeFrames: 3, backwardSteps: 0, meanLatenessMs: 215.4, maxLatenessMs: 325.46 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 21.01, stampLatenessMaxMs: 400, maxDelayMs: 275.46, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 275.39, resyncs: 0, holdFrames: 3,
  },
  'frame-stall-250': {
    straight: { snaps: 1, largestSnapU: 4.71, totalSnapU: 4.71, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 221.83, maxLatenessMs: 324.64 },
    turning: { snaps: 1, largestSnapU: 4.71, totalSnapU: 4.71, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 221.83, maxLatenessMs: 324.64 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 7.59, stampLatenessMaxMs: 247.5, maxDelayMs: 274.64, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 152.47, resyncs: 0, holdFrames: 0,
  },
  'jitter-4g': {
    straight: { snaps: 4, largestSnapU: 9.61, totalSnapU: 27.87, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 302.26, maxLatenessMs: 359.28 },
    turning: { snaps: 4, largestSnapU: 9.61, totalSnapU: 27.87, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 302.26, maxLatenessMs: 359.28 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 42.95, stampLatenessMaxMs: 208.71, maxDelayMs: 279.94, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 164.14, resyncs: 0, holdFrames: 0,
  },
};

/** The capture fixture, one result per join segment (S3-3). */
const CAPTURE_RECORDED: DroneFixtureResult[] = [
  {
    straight: { snaps: 5, largestSnapU: 12, totalSnapU: 36.17, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 223.29, maxLatenessMs: 380.22 },
    turning: { snaps: 5, largestSnapU: 12, totalSnapU: 36.17, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 223.29, maxLatenessMs: 380.22 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 22.01, stampLatenessMaxMs: 393.07, maxDelayMs: 280, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 311.21, resyncs: 0, holdFrames: 2,
  },
  {
    straight: { snaps: 2, largestSnapU: 4.5, totalSnapU: 7.69, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 247.55, maxLatenessMs: 275.25 },
    turning: { snaps: 2, largestSnapU: 4.5, totalSnapU: 7.69, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 247.55, maxLatenessMs: 275.25 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 32.57, stampLatenessMaxMs: 197.51, maxDelayMs: 225, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 144.71, resyncs: 0, holdFrames: 0,
  },
  {
    straight: { snaps: 27, largestSnapU: 17.9, totalSnapU: 137.2, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 215.62, maxLatenessMs: 411.32 },
    turning: { snaps: 27, largestSnapU: 17.89, totalSnapU: 137.19, freezeFrames: 0, backwardSteps: 0, meanLatenessMs: 215.62, maxLatenessMs: 411.32 },
    overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 0,
    stampLatenessMeanMs: 13.85, stampLatenessMaxMs: 247.5, maxDelayMs: 279.88, minDelayMs: 100,
    delayStepsOverBound: 0, maxLatenessEstimateMs: 221.6, resyncs: 0, holdFrames: 0,
  },
];

/** A 1 s stall on both streams (S4-5): past the 400 ms hold bound. */
const GAP_1000_PROFILE: NetworkProfile = {
  name: 'gap-1000',
  seed: 9,
  baseDelayMs: GAP_PROFILES['gap-400'].baseDelayMs,
  gaps: [{ atMs: GAP_AT_MS, durationMs: 1000, streams: 'both' }],
  frameStalls: [],
};

/** Idle-sector resume (S4-5): the server sends no swarm packets for
 *  IDLE_GAP_MS (an idle sector by design, docs/architecture/snapshot-cadence.md),
 *  then resumes with current ticks. Nothing sent in the window is delivered. */
const IDLE_GAP_MS = 4000;
const IDLE_DURATION_MS = 8000;
const IDLE_BASE_PROFILE: NetworkProfile = {
  name: 'idle-resume',
  seed: 10,
  baseDelayMs: GAP_PROFILES['gap-400'].baseDelayMs,
  gaps: [],
  frameStalls: [],
};

function runIdleResumeFixture(opts: DroneFixtureOptions = {}): DroneFixtureResult {
  const deliveries = buildDeliveries(IDLE_BASE_PROFILE, IDLE_DURATION_MS).filter(
    (d) => d.stream !== 'swarm' || d.sendMs < GAP_AT_MS || d.sendMs >= GAP_AT_MS + IDLE_GAP_MS,
  );
  return runDroneDeliveries(deliveries, buildFrameTimes(IDLE_BASE_PROFILE, IDLE_DURATION_MS), opts);
}

/** The S4-5 fixtures' numbers (gap-1000 re-syncs once at the 400 ms bound;
 *  idle-resume re-syncs once and jumps to the drones' current place, since the
 *  server sent nothing for 4 s). */
const GAP_1000_RECORDED: DroneFixtureResult = {
  straight: { snaps: 2, largestSnapU: 129.08, totalSnapU: 198.24, freezeFrames: 39, backwardSteps: 0, meanLatenessMs: 245.99, maxLatenessMs: 800 },
  turning: { snaps: 2, largestSnapU: 130.1, totalSnapU: 199.19, freezeFrames: 39, backwardSteps: 0, meanLatenessMs: 246.41, maxLatenessMs: 801.78 },
  overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 42,
  stampLatenessMeanMs: 91.76, stampLatenessMaxMs: 990, maxDelayMs: 400, minDelayMs: 100,
  delayStepsOverBound: 0, maxLatenessEstimateMs: 601.57, resyncs: 1, holdFrames: 18,
};
const IDLE_RESUME_RECORDED: DroneFixtureResult = {
  straight: { snaps: 1, largestSnapU: 1095, totalSnapU: 1095, freezeFrames: 219, backwardSteps: 0, meanLatenessMs: 873.52, maxLatenessMs: 2016.67 },
  turning: { snaps: 1, largestSnapU: 881.53, totalSnapU: 881.53, freezeFrames: 219, backwardSteps: 0, meanLatenessMs: 873.4, maxLatenessMs: 2016.67 },
  overwriteUnread: 0, oldEndClamps: 0, glideLimitHolds: 402,
  stampLatenessMeanMs: 0, stampLatenessMaxMs: 0, maxDelayMs: 400, minDelayMs: 100,
  delayStepsOverBound: 0, maxLatenessEstimateMs: 0, resyncs: 1, holdFrames: 18,
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

  it('the delay never moves faster than the slew bound', () => {
    for (const name of PROFILE_NAMES) expect(RECORDED[name].delayStepsOverBound, name).toBe(0);
    for (const seg of CAPTURE_RECORDED) expect(seg.delayStepsOverBound).toBe(0);
  });

  it('lan-clean: the lateness feed holds the 100 ms floor every frame; poses as a pinned 100 ms delay', () => {
    const fed = runDroneFixture(GAP_PROFILES['lan-clean']);
    expect(fed.minDelayMs).toBe(DISPLAY_DELAY_MS);
    expect(fed.maxDelayMs).toBe(DISPLAY_DELAY_MS);
    expect(fed).toEqual(runDroneFixture(GAP_PROFILES['lan-clean'], { fixedDelayMs: DISPLAY_DELAY_MS }));
  });

  it('stalls start after warm-up', () => {
    expect(GAP_AT_MS).toBeGreaterThan(IGNORE_FIRST_MS);
  });
});

describe('capture-2026-11-21 drone replay', () => {
  it('recorded numbers per join segment', () => {
    expect(runCaptureFixture()).toEqual(CAPTURE_RECORDED);
  });
});

describe('drone gap-smoothing targets', () => {
  // Plan 3.1: the old 10-deep ring spanned ~150 ms of tick-stamped history, so
  // a 200 ms delay read before the oldest pose on every frame (462 old-end
  // clamps, 460 overwrites before read on lan-clean at a held 200 ms delay).
  // The 21-deep ring (S3a-1) spans the whole adaptive range: 0 and 0.
  it('no pin-to-oldest reads at a 200 ms delay', () => {
    const result = runDroneFixture(GAP_PROFILES['lan-clean'], { fixedDelayMs: PIN_TEST_DELAY_MS });
    expect(result.oldEndClamps).toBe(0);
  });

  // S4-1: the glide limit (250 game ms) outlasts a 200 ms gap, so neither
  // drone freezes and no read holds at the glide limit, with the adaptive
  // delay and with the delay pinned at the 100 ms floor (no buffer to hide
  // the gap).
  it('gap-200: zero freeze frames', () => {
    for (const opts of [{}, { fixedDelayMs: DISPLAY_DELAY_MS }]) {
      const result = runDroneFixture(GAP_PROFILES['gap-200'], opts);
      expect(result.straight.freezeFrames + result.turning.freezeFrames).toBe(0);
      expect(result.glideLimitHolds).toBe(0);
    }
  });

  // S4-5: the stall hold parks the read point at the newest stamp + glide
  // limit and resumes from there, so the straight drone never snaps.
  it('zero snaps at gap-400, gap-600 and burst-600-both-streams (straight drone)', () => {
    for (const name of ['gap-400', 'gap-600', 'burst-600-both-streams'] as const) {
      expect(runDroneFixture(GAP_PROFILES[name]).straight.snaps, name).toBe(0);
    }
  });

  // The S4b gate: the 250 ms straight-line glide differs from the true curve,
  // so on resume the turning drone still steps 2.56 u (gap-400) / 3.27 u
  // (gap-600) once. The eased offset (S4b) is gated on these counts.
  it.fails('zero snaps at gap-400 (turning drone)', () => {
    expect(runDroneFixture(GAP_PROFILES['gap-400']).turning.snaps).toBe(0);
  });

  // Freezing is only allowed once the glide limit and the 100 ms floor are
  // used up: at most (gap - 350 ms) worth of frames.
  it('freeze frames stay within (gap - 350 ms) of frames', () => {
    const cases = [
      { result: RECORDED['gap-400'], gapMs: 400 },
      { result: RECORDED['gap-600'], gapMs: 600 },
      { result: RECORDED['burst-600-both-streams'], gapMs: 600 },
      { result: GAP_1000_RECORDED, gapMs: 1000 },
    ];
    for (const { result, gapMs } of cases) {
      const allowed = Math.round((gapMs - FREEZE_ALLOWANCE_MS) / FRAME_WALL_MS);
      expect(result.straight.freezeFrames, `${gapMs}`).toBeLessThanOrEqual(allowed);
      expect(result.turning.freezeFrames, `${gapMs}`).toBeLessThanOrEqual(allowed);
    }
  });

  it('lan-clean: no hold and no re-sync', () => {
    expect(RECORDED['lan-clean'].holdFrames).toBe(0);
    expect(RECORDED['lan-clean'].resyncs).toBe(0);
  });

  it('gap-1000: exactly one re-sync, and the delay never passes the 400 ms bound', () => {
    const result = runDroneFixture(GAP_1000_PROFILE);
    expect(result).toEqual(GAP_1000_RECORDED);
    expect(result.resyncs).toBe(1);
    expect(result.maxDelayMs).toBeLessThanOrEqual(MAX_TOTAL_DISPLAY_DELAY_MS);
  });

  it('idle-resume: one re-sync and no long catch-up (the delay is at its target once packets return)', () => {
    let offTargetFrames = 0;
    const result = runIdleResumeFixture({
      onFrame: (t) => {
        if (t >= GAP_AT_MS + IDLE_GAP_MS && getSwarmDisplayDelayMs() !== getSwarmDisplayDelayTargetMs()) offTargetFrames++;
      },
    });
    expect(result).toEqual(IDLE_RESUME_RECORDED);
    expect(result.resyncs).toBe(1);
    expect(offTargetFrames).toBe(0);
  });
});
