/**
 * 4G display-delay cap and quiet-stream hold (netcode gap smoothing S5-7).
 *
 * Regression guard for two field bugs on the lateness-driven delay:
 *   - on a jittery 4G link the delay target slid to its 280 ms ceiling, so
 *     drones (and the missiles and shells that share the delay) were drawn
 *     ~300 ms late against ~125 ms on main;
 *   - on a clean link a sparse swarm stream (the server's delta encoder sends
 *     nothing while drones idle) looked like a stall: the drone hold fired
 *     ~530 frames and re-synced ~24 times a minute.
 *
 * One drone, driven by the REAL client code: `decodeSwarmPacket` with tick
 * stamping, the production delay feed (`displayDelayFeed.ts`: swarm
 * inter-arrival EWMA + the real `applySnapshotPerfStats` on each JSON
 * snapshot), `stepSwarmDisplayDelay` once per frame, `interpolateSwarmPose`.
 * Mock clock at 60 frames/s; the links are seeded and deterministic.
 */
import { describe, it, expect } from 'vitest';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import {
  ADAPTIVE_DELAY_CEILING_MS,
  getSwarmDisplayDelayMs,
  getSwarmHoldFrameCount,
  getSwarmResyncCount,
  interpolateSwarmPose,
  resetSwarmDisplayDelay,
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
import { createDisplayDelayFeed } from './displayDelayFeed.js';

const TICK_MS = 1000 / 60;
const FRAME_MS = 1000 / 60;
const MS_PER_SECOND = 1000;
/** Mirrors runner.ts: tick index 0 is server tick 100. */
const START_SERVER_TICK = 100;
/** The JSON snapshot rides every third server tick. */
const JSON_EVERY_TICKS = 3;
/** The swarm encoder sends a keyframe every 60 ticks even when nothing moved. */
const SWARM_KEYFRAME_TICKS = 60;
const DRONE_ID = 1;
const DRONE_RADIUS_U = 12;
const DRONE_SPEED_U_PER_S = 300;
/** idle-cycle content: the drone moves for this long, then idles as long. */
const IDLE_HALF_CYCLE_MS = 3000;
/** Counters start after this warm-up (wall ms). */
const WARM_UP_MS = 3000;
/** Frames stop this long before the session ends (the last packets in flight). */
const TAIL_MS = 200;
/** A frame step below this (u) is a freeze; above the true step by more than
 *  JUMP_EXCESS_U it is a jump. */
const FREEZE_STEP_U = 0.05;
const JUMP_EXCESS_U = 2;

// Clean link: 20-26 ms one way, nothing lost.
const CLEAN_SESSION_MS = 60_000;
const CLEAN_SEED = 1;
const CLEAN_ONE_WAY_MIN_MS = 20;
const CLEAN_ONE_WAY_SPAN_MS = 6;

// Jittery 4G link: log-normal one-way delay (median 33 ms, p99 ~227 ms) with
// AR(1) correlation, 26 stalls of 200-1500 ms, a 5 s stall and an 8 s outage.
const JITTER_SESSION_MS = 180_000;
const JITTER_SEED = 7;
const ONE_WAY_MEDIAN_MS = 33;
const LOG_SIGMA = 0.83;
const AR_KEEP = 0.93;
const SHORT_STALLS = 20;
const LONG_STALLS = 6;
const SHORT_STALL_MIN_MS = 200;
const SHORT_STALL_SPAN_MS = 400;
const LONG_STALL_MIN_MS = 600;
const LONG_STALL_SPAN_MS = 900;
const STALLS_FROM_MS = 5000;
const STALLS_END_MARGIN_MS = 20_000;
const BIG_STALL_AT = 0.45;
const BIG_STALL_MS = 5000;
const OUTAGE_AT = 0.75;
const OUTAGE_MS = 8000;

/** Jittery 4G: median drone lateness must stay well under this (ms). Before
 *  S5-7 it was 299 ms (main: 124). */
const MAX_JITTER_LATENESS_P50_MS = 200;
const P50 = 0.5;

type Content = 'dense' | 'idle-cycle';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gauss(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
}

function isMoving(content: Content, gameMs: number): boolean {
  return content === 'dense' || Math.floor(gameMs / IDLE_HALF_CYCLE_MS) % 2 === 0;
}

function truthX(content: Content, gameMs: number): number {
  if (content === 'dense') return (DRONE_SPEED_U_PER_S * gameMs) / MS_PER_SECOND;
  const cycleMs = 2 * IDLE_HALF_CYCLE_MS;
  const cycle = Math.floor(gameMs / cycleMs);
  const movedMs = cycle * IDLE_HALF_CYCLE_MS + Math.min(gameMs - cycle * cycleMs, IDLE_HALF_CYCLE_MS);
  return (DRONE_SPEED_U_PER_S * movedMs) / MS_PER_SECOND;
}

/** Does the server send a swarm packet on this tick? (the delta encoder sends
 *  nothing when no drone changed, bar the keyframe). */
function sendsSwarm(content: Content, tick: number): boolean {
  if (tick % SWARM_KEYFRAME_TICKS === 0 || content === 'dense') return true;
  const g = (tick - START_SERVER_TICK) * TICK_MS;
  return isMoving(content, g) || isMoving(content, g - TICK_MS);
}

function dronePacket(content: Content, tick: number): Uint8Array {
  const g = (tick - START_SERVER_TICK) * TICK_MS;
  const buf = new ArrayBuffer(SWARM_HEADER_BYTES + SWARM_RECORD_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, SWARM_WIRE_VERSION);
  v.setUint8(1, 0);
  v.setUint16(2, 1, true);
  v.setUint32(4, tick, true);
  const o = SWARM_HEADER_BYTES;
  v.setUint16(o, DRONE_ID, true);
  v.setUint8(o + 2, SWARM_KIND_DRONE);
  v.setFloat32(o + 4, truthX(content, g), true);
  v.setFloat32(o + 8, 0, true);
  v.setFloat32(o + 12, isMoving(content, g) ? DRONE_SPEED_U_PER_S : 0, true);
  v.setFloat32(o + 16, 0, true);
  v.setFloat32(o + 20, 0, true);
  v.setFloat32(o + SWARM_REC_ANGVEL_OFF, 0, true);
  v.setFloat32(o + SWARM_REC_RADIUS_OFF, DRONE_RADIUS_U, true);
  return new Uint8Array(buf);
}

interface Delivery { stream: 'swarm' | 'json'; tick: number; arriveMs: number }
interface Link { sessionMs: number; seed: number; jittery: boolean }

function buildLinkDeliveries(link: Link, content: Content): Delivery[] {
  const r = rng(link.seed);
  const stalls: Array<{ atMs: number; durMs: number; lost: boolean }> = [];
  if (link.jittery) {
    for (let i = 0; i < SHORT_STALLS + LONG_STALLS; i++) {
      const durMs = i < SHORT_STALLS ? SHORT_STALL_MIN_MS + r() * SHORT_STALL_SPAN_MS : LONG_STALL_MIN_MS + r() * LONG_STALL_SPAN_MS;
      stalls.push({ atMs: STALLS_FROM_MS + r() * (link.sessionMs - STALLS_END_MARGIN_MS), durMs, lost: false });
    }
    stalls.push({ atMs: link.sessionMs * BIG_STALL_AT, durMs: BIG_STALL_MS, lost: false });
    stalls.push({ atMs: link.sessionMs * OUTAGE_AT, durMs: OUTAGE_MS, lost: true });
  }
  const out: Delivery[] = [];
  let logDev = 0;
  let lastArriveMs = 0;
  const ticks = Math.floor(link.sessionMs / TICK_MS);
  for (let k = 0; k < ticks; k++) {
    const tick = START_SERVER_TICK + k;
    const sendMs = k * TICK_MS;
    let oneWayMs: number;
    if (link.jittery) {
      logDev = AR_KEEP * logDev + Math.sqrt(1 - AR_KEEP * AR_KEEP) * gauss(r);
      oneWayMs = ONE_WAY_MEDIAN_MS * Math.exp(LOG_SIGMA * logDev);
    } else {
      oneWayMs = CLEAN_ONE_WAY_MIN_MS + r() * CLEAN_ONE_WAY_SPAN_MS;
    }
    let arriveMs = sendMs + oneWayMs;
    let lost = false;
    for (const s of stalls) {
      if (sendMs >= s.atMs && sendMs < s.atMs + s.durMs) {
        if (s.lost) lost = true;
        else arriveMs = Math.max(arriveMs, s.atMs + s.durMs + oneWayMs);
      } else if (!s.lost && sendMs < s.atMs && arriveMs > s.atMs) {
        arriveMs = Math.max(arriveMs, s.atMs + s.durMs + oneWayMs);
      }
    }
    if (lost) continue;
    arriveMs = Math.max(arriveMs, lastArriveMs);
    lastArriveMs = arriveMs;
    if (sendsSwarm(content, tick)) out.push({ stream: 'swarm', tick, arriveMs });
    if (tick % JSON_EVERY_TICKS === 0) out.push({ stream: 'json', tick, arriveMs });
  }
  return out;
}

interface Result {
  holdFrames: number;
  resyncs: number;
  meanDelayMs: number;
  maxDelayMs: number;
  latenessP50Ms: number;
  freezeFrames: number;
  jumps: number;
}

function runLink(link: Link, content: Content): Result {
  const deliveries = buildLinkDeliveries(link, content);
  resetSwarmTickClock();
  resetSwarmDisplayDelay();
  setSwarmDisplaySpeed(1);
  const feed = createDisplayDelayFeed();
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  const pose: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  const lateness: number[] = [];
  let next = 0;
  let pendingJsonTick = -1;
  let pendingAtMs = 0;
  let prevT = Number.NaN;
  let prevX = Number.NaN;
  let prevTrueX = Number.NaN;
  let delaySum = 0;
  let delayFrames = 0;
  let maxDelayMs = 0;
  let freezeFrames = 0;
  let jumps = 0;
  for (let t = FRAME_MS; t < link.sessionMs - TAIL_MS; t += FRAME_MS) {
    // Swarm decodes at once; JSON waits in the coalescer (newest wins).
    while (next < deliveries.length && deliveries[next]!.arriveMs <= t) {
      const d = deliveries[next++]!;
      if (d.stream === 'json') {
        pendingJsonTick = d.tick;
        pendingAtMs = d.arriveMs;
        continue;
      }
      feed.swarmArrived(t);
      decodeSwarmPacket(dronePacket(content, d.tick), mirror, t, true);
    }
    if (pendingJsonTick >= 0) {
      feed.jsonApplied(pendingJsonTick, t, pendingAtMs);
      pendingJsonTick = -1;
    }
    stepSwarmDisplayDelay(Number.isNaN(prevT) ? 0 : t - prevT, t);
    prevT = t;
    const entry = mirror.swarm?.get(DRONE_ID);
    if (!entry) continue;
    interpolateSwarmPose(entry, t, pose);
    const trueX = truthX(content, t);
    if (t > WARM_UP_MS && !Number.isNaN(prevX)) {
      const delayMs = getSwarmDisplayDelayMs();
      delaySum += delayMs;
      delayFrames++;
      maxDelayMs = Math.max(maxDelayMs, delayMs);
      if (content === 'dense') {
        const step = pose.x - prevX;
        if (Math.abs(step) < FREEZE_STEP_U) freezeFrames++;
        if (Math.abs(step) - (trueX - prevTrueX) > JUMP_EXCESS_U) jumps++;
        lateness.push(((trueX - pose.x) * MS_PER_SECOND) / DRONE_SPEED_U_PER_S);
      }
    }
    prevX = pose.x;
    prevTrueX = trueX;
  }
  lateness.sort((a, b) => a - b);
  return {
    holdFrames: getSwarmHoldFrameCount(),
    resyncs: getSwarmResyncCount(),
    meanDelayMs: delaySum / Math.max(1, delayFrames),
    maxDelayMs,
    latenessP50Ms: lateness.length > 0 ? lateness[Math.floor(P50 * lateness.length)]! : Number.NaN,
    freezeFrames,
    jumps,
  };
}

describe('gap smoothing: 4G display-delay cap and quiet-stream hold (S5-7)', () => {
  it('clean link, sparse swarm stream (drones idle half the time): no hold, no re-sync', () => {
    const r = runLink({ sessionMs: CLEAN_SESSION_MS, seed: CLEAN_SEED, jittery: false }, 'idle-cycle');
    console.log('clean idle-cycle', JSON.stringify(r));
    expect(r.holdFrames).toBe(0);
    expect(r.resyncs).toBe(0);
  });

  it('jittery 4G: the delay stays at or under the ceiling and drones are drawn well under 200 ms late', () => {
    const r = runLink({ sessionMs: JITTER_SESSION_MS, seed: JITTER_SEED, jittery: true }, 'dense');
    console.log('4G dense', JSON.stringify(r));
    expect(r.meanDelayMs).toBeLessThanOrEqual(ADAPTIVE_DELAY_CEILING_MS);
    expect(r.latenessP50Ms).toBeLessThan(MAX_JITTER_LATENESS_P50_MS);
  });
});
