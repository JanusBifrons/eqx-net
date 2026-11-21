/**
 * S5-1b (netcode gap smoothing): the drone tick clock rides out a frame stall.
 *
 * When the main thread freezes, every drone packet that arrived meanwhile is
 * handled at once when it wakes, before the next frame step. Those packets
 * are late because of the page, not the network: they must not pull the tick
 * clock later, must not be clamped into each other at the drain time, and
 * must not move the delay target. The same burst after a NETWORK stall
 * (frames kept running) keeps the existing drift-up.
 *
 * Driven through the calls the decoder makes per packet
 * (`swarmArrivalStampMs` + `noteSwarmStreamStamp`) and once per 60 Hz frame
 * (`stepSwarmDisplayDelay`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  swarmArrivalStampMs,
  noteSwarmStreamStamp,
  stepSwarmDisplayDelay,
  setSwarmDisplaySpeed,
  resetSwarmTickClock,
  getSwarmDisplayDelayTargetMs,
  TICK_CLOCK_FRAME_STALL_MS,
} from './swarmInterpolation.js';

const FRAME_MS = 1000 / 60;
/** One server tick in wall ms at 1x. */
const TICK_MS = 1000 / 60;
const START_MS = 10_000;
/** One-way link delay (wall ms). */
const LINK_MS = 40;
/** Packets delivered on time before the stall (warm-up). */
const WARM_UP_TICKS = 120;
/** Main-thread freeze (wall ms) — the frame-stall-250 fixture. */
const STALL_MS = 250;
const EPS = 1e-9;

interface BurstResult {
  /** Tick-clock offset (stamp − tick × tick ms) before the burst. */
  offsetBeforeMs: number;
  /** Offset each burst packet was stamped on. */
  burstOffsetsMs: number[];
  /** The burst's stamps, in tick order. */
  burstStamps: number[];
  /** The drain time of the burst (wall ms). */
  drainMs: number;
  targetBeforeMs: number;
  targetAfterMs: number;
}

/** Deliver one packet as the decoder does; returns its stamp. */
function deliver(tick: number, nowMs: number): number {
  const stamp = swarmArrivalStampMs(tick, nowMs);
  noteSwarmStreamStamp(tick, stamp);
  return stamp;
}

/**
 * Warm up on time (one packet and one frame step per tick), then nothing
 * arrives for STALL_MS and the backlog drains at once. `frameStall`: no frame
 * steps run in that window (the main thread froze); otherwise frames keep
 * stepping (a network stall).
 */
function runBurst(frameStall: boolean): BurstResult {
  let now = START_MS;
  let lastStamp = 0;
  let tick = 0;
  for (; tick < WARM_UP_TICKS; tick++) {
    now = START_MS + tick * TICK_MS + LINK_MS;
    lastStamp = deliver(tick, now);
    stepSwarmDisplayDelay(FRAME_MS, now);
  }
  const offsetBeforeMs = lastStamp - (tick - 1) * TICK_MS;
  const targetBeforeMs = getSwarmDisplayDelayTargetMs();
  const drainMs = now + STALL_MS;
  if (!frameStall) {
    for (let t = now + FRAME_MS; t < drainMs; t += FRAME_MS) stepSwarmDisplayDelay(FRAME_MS, t);
  }
  const burstOffsetsMs: number[] = [];
  const burstStamps: number[] = [];
  // Every tick sent during the stall but the one due exactly at the drain.
  const lastBurstTick = tick + Math.round(STALL_MS / TICK_MS) - 2;
  for (; tick <= lastBurstTick; tick++) {
    const stamp = deliver(tick, drainMs);
    burstStamps.push(stamp);
    burstOffsetsMs.push(stamp - tick * TICK_MS);
  }
  return {
    offsetBeforeMs, burstOffsetsMs, burstStamps, drainMs, targetBeforeMs,
    targetAfterMs: getSwarmDisplayDelayTargetMs(),
  };
}

beforeEach(() => {
  resetSwarmTickClock();
  setSwarmDisplaySpeed(1);
});

afterEach(() => {
  resetSwarmTickClock();
  setSwarmDisplaySpeed(1);
});

describe('swarm tick clock through a frame stall (S5-1b)', () => {
  it('the stall is longer than the backlog threshold', () => {
    expect(STALL_MS).toBeGreaterThan(TICK_CLOCK_FRAME_STALL_MS);
  });

  it('a burst after a long frame gap does not move the offset later', () => {
    const r = runBurst(true);
    expect(r.burstOffsetsMs.length).toBeGreaterThan(1);
    for (const off of r.burstOffsetsMs) expect(off).toBeCloseTo(r.offsetBeforeMs, 9);
  });

  it('the burst stamps stay spaced by one tick and none is clamped at the drain time', () => {
    const r = runBurst(true);
    for (let i = 1; i < r.burstStamps.length; i++) {
      expect(r.burstStamps[i]! - r.burstStamps[i - 1]!).toBeCloseTo(TICK_MS, 9);
    }
    for (const s of r.burstStamps) expect(s).toBeLessThan(r.drainMs - EPS);
  });

  it('the burst does not move the delay target', () => {
    const r = runBurst(true);
    expect(r.targetAfterMs).toBe(r.targetBeforeMs);
  });

  it('the next on-time packet after the stall lands on the same offset (no step back)', () => {
    const r = runBurst(true);
    const nextTick = Math.round((r.burstStamps[r.burstStamps.length - 1]! - r.offsetBeforeMs) / TICK_MS) + 1;
    // The frame after the drain steps; the next tick then arrives on time.
    stepSwarmDisplayDelay(FRAME_MS, r.drainMs);
    const onTimeMs = START_MS + nextTick * TICK_MS + LINK_MS;
    expect(onTimeMs).toBeCloseTo(r.drainMs, 9);
    const stamp = deliver(nextTick, onTimeMs);
    expect(stamp - nextTick * TICK_MS).toBeCloseTo(r.offsetBeforeMs, 9);
  });

  it('control: the same burst after a network stall (frames kept running) still drifts the offset later', () => {
    const r = runBurst(false);
    expect(r.burstOffsetsMs[r.burstOffsetsMs.length - 1]!).toBeGreaterThan(r.offsetBeforeMs + 1);
  });
});
