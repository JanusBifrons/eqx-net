/**
 * S4b (netcode gap smoothing): the eased resume offset of a drone's drawn pose.
 *
 * - The offset decays on WALL time: the same drawn track at game speed 0.7
 *   and 2 (an error-smoothing spring, docs/architecture/game-time-scale.md).
 * - A turning drone that resumes from a stream hold is eased from its held
 *   pose; a resume across a teleport is never eased.
 * - An idle offset leaves the interpolated pose untouched; the sector-change
 *   reset clears every offset.
 *
 * The hold is driven through the real decoder (`decodeSwarmPacket` with tick
 * stamping) and `stepSwarmDisplayDelay`, once per 60 Hz frame.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveSwarmDrawnPose,
  clearSwarmResumeOffsets,
  makeSwarmResumeOffset,
  SWARM_RESUME_OFFSET_HALF_LIFE_MS,
} from './swarmResumeOffset.js';
import {
  interpolateSwarmPose,
  resetSwarmTickClock,
  setSwarmDisplaySpeed,
  stepSwarmDisplayDelay,
  getSwarmHoldFrameCount,
  getSwarmResyncCount,
  type InterpolatedPose,
} from './swarmInterpolation.js';
import { decodeSwarmPacket } from './BinarySwarmDecoder.js';
import { POSE_RING_DEPTH, type RenderMirror, type SwarmRenderState, type PoseRingEntry } from '../../core/contracts/IRenderer.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES, SWARM_REC_ANGVEL_OFF, SWARM_REC_RADIUS_OFF, SWARM_WIRE_VERSION, SWARM_KIND_DRONE,
} from '../../shared-types/swarmWireFormat.js';

const FRAME_MS = 1000 / 60;
const TICK_GAME_MS = 1000 / 60;
const START_MS = 10_000;
const LINK_MS = 40;
const DRONE_ID = 7;
const DRONE_RADIUS_U = 20;
/** Drone speed (u per game s) and turn rate (rad per game s). */
const SPEED_U_S = 300;
const TURN_RAD_S = 1.5;
/** The stall: packets sent in [STALL_AT_MS, +STALL_MS) arrive at its end. */
const STALL_AT_MS = 2000;
const STALL_MS = 600;
const RUN_MS = 4000;
/** A teleport far past any plausible motion over the stall (u). */
const TELEPORT_U = 2000;
/** A per-frame drawn step this far past the true step is a snap (assertions.ts). */
const SNAP_TOLERANCE_U = 2;
const SEED_OFFSET_U = 3;
const DECAY_FRAMES = 60;
const SETTLED_U = 0.05;

interface Pose { x: number; y: number; angle: number; vx: number; vy: number; angvel: number }

/** A drone on a circle at SPEED_U_S, turning at TURN_RAD_S; `teleportAfterMs`
 *  (game ms) shifts it TELEPORT_U along x from then on. */
function truth(gameMs: number, teleportAfterMs = Infinity): Pose {
  const r = SPEED_U_S / TURN_RAD_S;
  const th = (TURN_RAD_S * gameMs) / 1000;
  const shift = gameMs >= teleportAfterMs ? TELEPORT_U : 0;
  return {
    x: r * Math.sin(th) + shift, y: r - r * Math.cos(th), angle: th,
    vx: SPEED_U_S * Math.cos(th), vy: SPEED_U_S * Math.sin(th), angvel: TURN_RAD_S,
  };
}

function packet(tick: number, p: Pose): Uint8Array {
  const buf = new ArrayBuffer(SWARM_HEADER_BYTES + SWARM_RECORD_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, SWARM_WIRE_VERSION);
  v.setUint8(1, 0);
  v.setUint16(2, 1, true);
  v.setUint32(4, tick, true);
  const o = SWARM_HEADER_BYTES;
  v.setUint16(o, DRONE_ID, true);
  v.setUint8(o + 2, SWARM_KIND_DRONE);
  v.setFloat32(o + 4, p.x, true);
  v.setFloat32(o + 8, p.y, true);
  v.setFloat32(o + 12, p.vx, true);
  v.setFloat32(o + 16, p.vy, true);
  v.setFloat32(o + 20, p.angle, true);
  v.setFloat32(o + SWARM_REC_ANGVEL_OFF, p.angvel, true);
  v.setFloat32(o + SWARM_REC_RADIUS_OFF, DRONE_RADIUS_U, true);
  return new Uint8Array(buf);
}

interface Frame { t: number; x: number; y: number; trueStep: number; drawnStep: number; live: boolean }

/** 60 Hz frames over a 600 ms network stall (backlog delivered at its end). */
function runStall(teleportAfterMs = Infinity): Frame[] {
  const mirror = {} as RenderMirror;
  const pose: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  const frames: Frame[] = [];
  let tick = 0;
  let prev: { x: number; y: number; tx: number; ty: number } | null = null;
  for (let f = 1; f * FRAME_MS <= RUN_MS; f++) {
    const rel = f * FRAME_MS;
    const now = START_MS + rel;
    for (;;) {
      const sendRel = tick * TICK_GAME_MS;
      let arriveRel = sendRel + LINK_MS;
      if (sendRel >= STALL_AT_MS && sendRel < STALL_AT_MS + STALL_MS) arriveRel = Math.max(arriveRel, STALL_AT_MS + STALL_MS + LINK_MS);
      if (arriveRel > rel) break;
      decodeSwarmPacket(packet(tick, truth(sendRel, teleportAfterMs)), mirror, now, true);
      tick++;
    }
    stepSwarmDisplayDelay(FRAME_MS, now);
    const entry = mirror.swarm?.get(DRONE_ID);
    if (!entry) continue;
    resolveSwarmDrawnPose(entry, now, FRAME_MS, pose);
    const tp = truth(rel - LINK_MS, teleportAfterMs);
    if (prev) {
      frames.push({
        t: rel,
        x: pose.x,
        y: pose.y,
        trueStep: Math.hypot(tp.x - prev.tx, tp.y - prev.ty),
        drawnStep: Math.hypot(pose.x - prev.x, pose.y - prev.y),
        live: (entry.resumeOffset?.halfLifeMs ?? 0) > 0,
      });
    }
    prev = { x: pose.x, y: pose.y, tx: tp.x, ty: tp.y };
  }
  return frames;
}

/** A parked drone (one ring sample) with a live offset of SEED_OFFSET_U in x. */
function parkedEntry(): SwarmRenderState {
  const ring: PoseRingEntry[] = [];
  for (let i = 0; i < POSE_RING_DEPTH; i++) {
    ring.push({ x: 0, y: 0, angle: 0, vx: 0, vy: 0, angvel: 0, arrivalMs: 0, serverTick: 0, sleeping: false, empty: i !== 0 });
  }
  const off = makeSwarmResumeOffset();
  off.sx.x = SEED_OFFSET_U;
  off.halfLifeMs = SWARM_RESUME_OFFSET_HALF_LIFE_MS;
  return {
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, angvel: 0, prevX: 0, prevY: 0, prevAngle: 0,
    prevArrivalMs: 0, latestArrivalMs: 0, poseRing: ring, ringHead: 1, resumeOffset: off,
    radius: DRONE_RADIUS_U, kind: SWARM_KIND_DRONE, sleeping: false, lastUpdateTick: 0,
  };
}

function decayTrack(speed: number): number[] {
  setSwarmDisplaySpeed(speed);
  const entry = parkedEntry();
  const pose: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  const xs: number[] = [];
  for (let f = 1; f <= DECAY_FRAMES; f++) xs.push(resolveSwarmDrawnPose(entry, START_MS + f * FRAME_MS, FRAME_MS, pose).x);
  return xs;
}

describe('swarm resume offset (S4b)', () => {
  beforeEach(() => { resetSwarmTickClock(); clearSwarmResumeOffsets(undefined); });
  afterEach(() => { setSwarmDisplaySpeed(1); resetSwarmTickClock(); clearSwarmResumeOffsets(undefined); });

  it('decays on wall time: the same track at game speed 0.7 and 2', () => {
    const slow = decayTrack(0.7);
    const fast = decayTrack(2);
    expect(slow).toEqual(fast);
    expect(slow[0]!).toBeLessThan(SEED_OFFSET_U);
    for (let i = 1; i < slow.length; i++) expect(slow[i]!).toBeLessThanOrEqual(slow[i - 1]! + 1e-9);
    expect(Math.abs(slow[slow.length - 1]!)).toBeLessThan(SETTLED_U);
  });

  it('settles to idle and then leaves the interpolated pose untouched', () => {
    const entry = parkedEntry();
    const pose: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    const plain: InterpolatedPose = { x: 0, y: 0, angle: 0 };
    let t = START_MS;
    for (let f = 0; f < DECAY_FRAMES * 2; f++) resolveSwarmDrawnPose(entry, (t += FRAME_MS), FRAME_MS, pose);
    expect(entry.resumeOffset!.halfLifeMs).toBe(0);
    resolveSwarmDrawnPose(entry, (t += FRAME_MS), FRAME_MS, pose);
    interpolateSwarmPose(entry, t, plain);
    expect(pose).toEqual(plain);
  });

  it('a turning drone resuming from a hold is eased: no snap', () => {
    const frames = runStall();
    expect(getSwarmHoldFrameCount()).toBeGreaterThan(0);
    expect(getSwarmResyncCount()).toBe(0);
    expect(frames.some((f) => f.live)).toBe(true);
    for (const f of frames) expect(f.drawnStep - f.trueStep, `t=${f.t.toFixed(1)}`).toBeLessThanOrEqual(SNAP_TOLERANCE_U);
  });

  it('a resume across a teleport is not eased', () => {
    // Teleported from the first stalled packet on: the resumed read point is
    // past it, so the held pose and the resumed pose straddle the jump.
    const frames = runStall(STALL_AT_MS);
    expect(getSwarmHoldFrameCount()).toBeGreaterThan(0);
    expect(frames.some((f) => f.live)).toBe(false);
    // The drawn pose jumps with the teleport (one step of about TELEPORT_U).
    expect(Math.max(...frames.map((f) => f.drawnStep))).toBeGreaterThan(TELEPORT_U / 2);
  });

  it('the sector-change reset clears every live offset', () => {
    const a = parkedEntry();
    const b = parkedEntry();
    const swarm = new Map<number, SwarmRenderState>([[1, a], [2, b]]);
    clearSwarmResumeOffsets(swarm);
    for (const e of swarm.values()) {
      expect(e.resumeOffset!.halfLifeMs).toBe(0);
      expect(e.resumeOffset!.sx.x).toBe(0);
      expect(Number.isNaN(e.resumeOffset!.heldX)).toBe(true);
    }
  });
});
