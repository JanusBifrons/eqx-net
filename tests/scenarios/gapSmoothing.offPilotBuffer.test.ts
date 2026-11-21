/**
 * Off-pilot display-delay buffer (netcode gap smoothing S5-9).
 *
 * Off the controls (Command, Build, spectate) the display delay may grow to
 * cover the recent link outages, so a 1-2 s outage reads as delay, not as a
 * pause then a glide. Piloting keeps the S5-7 target exactly.
 *
 * One drone and one missile flying straight, driven by the REAL client code:
 * `decodeSwarmPacket` with tick stamping, the production delay feed
 * (`displayDelayFeed.ts`), `setSwarmDisplayDelayMode` + `stepSwarmDisplayDelay`
 * + `stepMissileDisplayDelay` once per frame, `interpolateSwarmPose` and
 * `resolveMissileDisplayPose`. The link is clean (20-26 ms one way) with a
 * repeating cycle of outages: packets sent in an outage are DELAYED to its end
 * (TCP), never lost. Mock clock at 60 frames/s; seeded and deterministic.
 */
import { describe, it, expect } from 'vitest';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import {
  ADAPTIVE_DELAY_CEILING_MS,
  OFF_PILOT_DELAY_CEILING_MS,
  getSwarmDisplayDelayMs,
  getSwarmDisplayDelayTargetMs,
  getSwarmGapPeakMs,
  getSwarmHoldFrameCount,
  getSwarmResyncCount,
  interpolateSwarmPose,
  isSwarmDelayCatchingUp,
  resetSwarmDisplayDelay,
  resetSwarmTickClock,
  setSwarmDisplayDelayMode,
  setSwarmDisplaySpeed,
  stepSwarmDisplayDelay,
  type InterpolatedPose,
  type SwarmDelayMode,
} from '../../src/client/net/swarmInterpolation.js';
import { DISPLAY_DELAY_CATCHUP_MAX_RATE } from '../../src/client/net/swarmDelaySizing.js';
import {
  applyMissileSnapshot, resetMissileDisplayDelay, resolveMissileDisplayPose, stepMissileDisplayDelay,
} from '../../src/client/combat/MissileMirror.js';
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
const START_SERVER_TICK = 100;
const JSON_EVERY_TICKS = 3;
const DRONE_ID = 1;
const DRONE_RADIUS_U = 12;
const DRONE_SPEED_U_PER_S = 300;
const MISSILE_ID = 9;
const MISSILE_SPEED_U_PER_S = 600;
const SESSION_MS = 120_000;
const SEED = 11;
const ONE_WAY_MIN_MS = 20;
const ONE_WAY_SPAN_MS = 6;
/** Outages repeat every OUTAGE_EVERY_MS from FIRST_OUTAGE_MS, cycling these
 *  lengths (wall ms): the 2 s worst case first, then 1-2 s. One cycle (25 s)
 *  fits in OFF_PILOT_GAP_HOLD_MS, so the gap peak remembers the worst one. */
const OUTAGE_LENGTHS_MS = [2000, 1200, 1600, 1000, 1800];
const FIRST_OUTAGE_MS = 4000;
const OUTAGE_EVERY_MS = 5000;
const OUTAGES_END_MARGIN_MS = 5000;
/** Counters start after the first outage and the delay's growth to its peak. */
const WARM_UP_MS = 30_000;
const TAIL_MS = 200;
const FREEZE_STEP_U = 0.05;
const JUMP_EXCESS_U = 2;
/** The pilot catch-up must bring the delay to its target within this (wall ms). */
const CATCHUP_WITHIN_MS = 600;
/** ... to within this of it (wall ms). */
const CATCHUP_SETTLE_MS = 5;
/** Off-pilot growth after a pilot → off-pilot switch must settle within this. */
const GROW_WITHIN_MS = 30_000;

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const droneX = (gameMs: number): number => (DRONE_SPEED_U_PER_S * gameMs) / MS_PER_SECOND;
const missileY = (gameMs: number): number => (MISSILE_SPEED_U_PER_S * gameMs) / MS_PER_SECOND;

function dronePacket(tick: number): Uint8Array {
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
  v.setFloat32(o + 4, droneX(g), true);
  v.setFloat32(o + 8, 0, true);
  v.setFloat32(o + 12, DRONE_SPEED_U_PER_S, true);
  v.setFloat32(o + 16, 0, true);
  v.setFloat32(o + 20, 0, true);
  v.setFloat32(o + SWARM_REC_ANGVEL_OFF, 0, true);
  v.setFloat32(o + SWARM_REC_RADIUS_OFF, DRONE_RADIUS_U, true);
  return new Uint8Array(buf);
}

function missileSlice(tick: number): Parameters<typeof applyMissileSnapshot>[0] {
  const g = (tick - START_SERVER_TICK) * TICK_MS;
  return [{
    id: MISSILE_ID, x: 0, y: missileY(g), vx: 0, vy: MISSILE_SPEED_U_PER_S, angle: 0, angvel: 0,
    ownerId: 'player-a', weaponId: 'heat-seeker', lifePct: 1,
  }];
}

interface Delivery { stream: 'swarm' | 'json'; tick: number; arriveMs: number }

function buildDeliveries(): Delivery[] {
  const r = rng(SEED);
  const outages: Array<{ atMs: number; durMs: number }> = [];
  for (let i = 0, at = FIRST_OUTAGE_MS; at < SESSION_MS - OUTAGES_END_MARGIN_MS; i++, at += OUTAGE_EVERY_MS) {
    outages.push({ atMs: at, durMs: OUTAGE_LENGTHS_MS[i % OUTAGE_LENGTHS_MS.length]! });
  }
  const out: Delivery[] = [];
  let lastArriveMs = 0;
  for (let k = 0; k < Math.floor(SESSION_MS / TICK_MS); k++) {
    const tick = START_SERVER_TICK + k;
    const sendMs = k * TICK_MS;
    const oneWayMs = ONE_WAY_MIN_MS + r() * ONE_WAY_SPAN_MS;
    let arriveMs = sendMs + oneWayMs;
    for (const o of outages) {
      if (sendMs < o.atMs + o.durMs && arriveMs > o.atMs) arriveMs = Math.max(arriveMs, o.atMs + o.durMs + oneWayMs);
    }
    arriveMs = Math.max(arriveMs, lastArriveMs);
    lastArriveMs = arriveMs;
    out.push({ stream: 'swarm', tick, arriveMs });
    if (tick % JSON_EVERY_TICKS === 0) out.push({ stream: 'json', tick, arriveMs });
  }
  return out;
}

/** Motion counters over a stretch of frames. */
interface Motion { frames: number; freezes: number; jumps: number; backSteps: number; maxStepRatio: number }
const newMotion = (): Motion => ({ frames: 0, freezes: 0, jumps: 0, backSteps: 0, maxStepRatio: 0 });

function countStep(m: Motion, step: number, trueStep: number): void {
  m.frames++;
  if (Math.abs(step) < FREEZE_STEP_U) m.freezes++;
  if (step < -FREEZE_STEP_U) m.backSteps++;
  if (Math.abs(step) - trueStep > JUMP_EXCESS_U) m.jumps++;
  m.maxStepRatio = Math.max(m.maxStepRatio, step / trueStep);
}

interface Result {
  drone: Motion; missile: Motion; holdFrames: number; resyncs: number;
  meanDelayMs: number; maxDelayMs: number; gapPeakMs: number;
}

/** `modeAt(t)`: the mode each frame (undefined = never set: the default). */
type ModePlan = (tMs: number) => SwarmDelayMode | undefined;
type FrameHook = (tMs: number, droneStep: number, droneTrueStep: number) => void;

function run(modeAt: ModePlan, fromMs: number = WARM_UP_MS, onFrame?: FrameHook): Result {
  const deliveries = buildDeliveries();
  resetSwarmTickClock();
  resetSwarmDisplayDelay();
  resetMissileDisplayDelay();
  setSwarmDisplaySpeed(1);
  const feed = createDisplayDelayFeed();
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  const pose: InterpolatedPose = { x: 0, y: 0, angle: 0 };
  const res: Result = {
    drone: newMotion(), missile: newMotion(), holdFrames: 0, resyncs: 0, meanDelayMs: 0, maxDelayMs: 0, gapPeakMs: 0,
  };
  let next = 0;
  let pendingJsonTick = -1;
  let pendingAtMs = 0;
  let prevT = Number.NaN;
  let prevX = Number.NaN;
  let prevMy = Number.NaN;
  let delaySum = 0;
  for (let t = FRAME_MS; t < SESSION_MS - TAIL_MS; t += FRAME_MS) {
    while (next < deliveries.length && deliveries[next]!.arriveMs <= t) {
      const d = deliveries[next++]!;
      if (d.stream === 'json') { pendingJsonTick = d.tick; pendingAtMs = d.arriveMs; continue; }
      feed.swarmArrived(t);
      decodeSwarmPacket(dronePacket(d.tick), mirror, t, true);
    }
    if (pendingJsonTick >= 0) {
      feed.jsonApplied(pendingJsonTick, t, pendingAtMs);
      applyMissileSnapshot(missileSlice(pendingJsonTick), mirror, pendingJsonTick, t);
      pendingJsonTick = -1;
    }
    const mode = modeAt(t);
    if (mode !== undefined) setSwarmDisplayDelayMode(mode);
    const dtMs = Number.isNaN(prevT) ? 0 : t - prevT;
    stepSwarmDisplayDelay(dtMs, t);
    stepMissileDisplayDelay(mirror, dtMs, t);
    prevT = t;
    const entry = mirror.swarm?.get(DRONE_ID);
    if (!entry) continue;
    interpolateSwarmPose(entry, t, pose);
    const m = resolveMissileDisplayPose(mirror, MISSILE_ID, t);
    const my = m ? m.y : Number.NaN;
    if (t > fromMs && !Number.isNaN(prevX)) {
      const droneTrueStep = (DRONE_SPEED_U_PER_S * FRAME_MS) / MS_PER_SECOND;
      countStep(res.drone, pose.x - prevX, droneTrueStep);
      if (!Number.isNaN(my) && !Number.isNaN(prevMy)) {
        countStep(res.missile, my - prevMy, (MISSILE_SPEED_U_PER_S * FRAME_MS) / MS_PER_SECOND);
      }
      const delayMs = getSwarmDisplayDelayMs();
      delaySum += delayMs;
      res.maxDelayMs = Math.max(res.maxDelayMs, delayMs);
      onFrame?.(t, pose.x - prevX, droneTrueStep);
    }
    prevX = pose.x;
    prevMy = my;
  }
  res.holdFrames = getSwarmHoldFrameCount();
  res.resyncs = getSwarmResyncCount();
  res.meanDelayMs = delaySum / Math.max(1, res.drone.frames);
  res.gapPeakMs = getSwarmGapPeakMs();
  return res;
}

const always = (mode: SwarmDelayMode | undefined): ModePlan => () => mode;

describe('gap smoothing: off-pilot display-delay buffer (S5-9)', () => {
  it('off pilot, 1-2 s outages: no freeze, jump or step back after warm-up; the delay stays under the cap', () => {
    const pilot = run(always('pilot'));
    const off = run(always('offPilot'));
    console.log('pilot   ', JSON.stringify(pilot));
    console.log('offPilot', JSON.stringify(off));
    // Pilot (the S5-7 bounds) cannot cover a 1-2 s outage: it freezes and snaps.
    expect(pilot.drone.freezes).toBeGreaterThan(0);
    expect(off.drone.freezes).toBe(0);
    expect(off.drone.jumps).toBe(0);
    expect(off.drone.backSteps).toBe(0);
    expect(off.missile.freezes).toBe(0);
    expect(off.missile.jumps).toBe(0);
    expect(off.missile.backSteps).toBe(0);
    expect(off.maxDelayMs).toBeLessThanOrEqual(OFF_PILOT_DELAY_CEILING_MS);
    expect(off.meanDelayMs).toBeGreaterThan(ADAPTIVE_DELAY_CEILING_MS);
  });

  it('piloting: setting the mode to pilot every frame changes nothing (the S5-7 numbers)', () => {
    const byDefault = run(always(undefined));
    const explicit = run(always('pilot'));
    expect(explicit).toEqual(byDefault);
    expect(byDefault.maxDelayMs).toBeLessThanOrEqual(400);
  });

  it('off pilot → pilot: the delay shrinks to the pilot target within ~0.5 s, fast-forwarding (no snap, no step back)', () => {
    // Switch in steady flow, well after an outage, with the delay grown.
    const switchAtMs = FIRST_OUTAGE_MS + 5 * OUTAGE_EVERY_MS + 2500;
    let delayAtSwitch = Number.NaN;
    let settledAtMs = Number.NaN;
    const during = newMotion();
    run((t) => (t < switchAtMs ? 'offPilot' : 'pilot'), switchAtMs - 1000, (t, step, trueStep) => {
      if (t < switchAtMs) { delayAtSwitch = getSwarmDisplayDelayMs(); return; }
      if (t > switchAtMs + 2 * CATCHUP_WITHIN_MS) return;
      countStep(during, step, trueStep);
      const gap = getSwarmDisplayDelayMs() - getSwarmDisplayDelayTargetMs();
      if (Number.isNaN(settledAtMs) && gap <= CATCHUP_SETTLE_MS) settledAtMs = t - switchAtMs;
    });
    console.log('switch to pilot', JSON.stringify({ delayAtSwitch, settledAtMs, during, catchingUp: isSwarmDelayCatchingUp() }));
    expect(delayAtSwitch).toBeGreaterThan(1000);
    expect(settledAtMs).toBeLessThanOrEqual(CATCHUP_WITHIN_MS);
    expect(during.freezes).toBe(0);
    expect(during.backSteps).toBe(0);
    // A fast-forward, bounded by the catch-up rate: never a teleport.
    expect(during.maxStepRatio).toBeLessThanOrEqual(1 + DISPLAY_DELAY_CATCHUP_MAX_RATE + 0.1);
    expect(isSwarmDelayCatchingUp()).toBe(false);
  });

  it('pilot → off pilot: the delay grows at the normal slew and converges; then no freeze or snap', () => {
    const switchAtMs = 40_000;
    let convergedAtMs = Number.NaN;
    const after = newMotion();
    const r = run((t) => (t < switchAtMs ? 'pilot' : 'offPilot'), switchAtMs, (t, step, trueStep) => {
      if (!Number.isNaN(convergedAtMs)) { countStep(after, step, trueStep); return; }
      const gap = Math.abs(getSwarmDisplayDelayMs() - getSwarmDisplayDelayTargetMs());
      if (gap <= CATCHUP_SETTLE_MS && getSwarmDisplayDelayTargetMs() > 1000) convergedAtMs = t - switchAtMs;
    });
    console.log('switch to offPilot', JSON.stringify({ convergedAtMs, growing: r.drone, after }));
    expect(convergedAtMs).toBeLessThanOrEqual(GROW_WITHIN_MS);
    // Growing: the read point only slows (never jumps forward or back).
    expect(r.drone.backSteps).toBe(0);
    expect(r.missile.backSteps).toBe(0);
    expect(after.frames).toBeGreaterThan(0);
    expect(after.freezes).toBe(0);
    expect(after.jumps).toBe(0);
    expect(after.backSteps).toBe(0);
  });
});
