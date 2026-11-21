/**
 * Drone stream counters (netcode gap smoothing, S0-2).
 *
 * Drives the real binary decoder (tick-stamped, as the live client) and
 * `interpolateSwarmPose` on a mock clock: one 60 Hz server tick per frame,
 * one read per frame. Each counter is checked on a series built to trigger
 * it and on a clean series where it must stay at zero.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { decodeSwarmPacket } from '../../src/client/net/BinarySwarmDecoder.js';
import {
  interpolateSwarmPose,
  resetSwarmTickClock,
  setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed,
  getSwarmDisplayDelayMs,
  getSwarmLatenessLastMs,
  getSwarmLatenessMaxMs,
  getSwarmLatenessSumMs,
  getSwarmLatenessCount,
  getSwarmOverwriteUnreadCount,
  getSwarmOldEndClampCount,
  getSwarmGlideLimitCount,
  DISPLAY_DELAY_MS,
  ADAPTIVE_DELAY_CEILING_MS,
} from '../../src/client/net/swarmInterpolation.js';
import type { RenderMirror } from '../../src/core/contracts/IRenderer.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES, SWARM_REC_ANGVEL_OFF, SWARM_REC_RADIUS_OFF, SWARM_WIRE_VERSION,
} from '../../src/shared-types/swarmWireFormat.js';

const TICK_MS = 1000 / 60;
const START_TICK = 3000;
const ENTITY_ID = 7;
const SPEED_U_PER_TICK = 2;
const FRAMES = 300;

function packet(tick: number): Uint8Array {
  const buf = new ArrayBuffer(SWARM_HEADER_BYTES + SWARM_RECORD_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, SWARM_WIRE_VERSION);
  v.setUint8(1, 0);
  v.setUint16(2, 1, true);
  v.setUint32(4, tick, true);
  const o = SWARM_HEADER_BYTES;
  v.setUint16(o, ENTITY_ID, true);
  v.setUint8(o + 2, 1); // drone
  v.setFloat32(o + 4, (tick - START_TICK) * SPEED_U_PER_TICK, true);
  v.setFloat32(o + 12, (SPEED_U_PER_TICK * 1000) / TICK_MS, true);
  v.setFloat32(o + SWARM_REC_ANGVEL_OFF, 0, true);
  v.setFloat32(o + SWARM_REC_RADIUS_OFF, 12, true);
  return new Uint8Array(buf);
}

interface SeriesOpts {
  /** Every Nth packet arrives `lateMs` late (0 = none). */
  lateEvery?: number;
  lateMs?: number;
  /** Packets for ticks in [gapFrom, gapFrom + gapTicks) are lost. */
  gapFrom?: number;
  gapTicks?: number;
}

/** Frame f renders at exactly tick (START_TICK + f)'s on-time arrival. */
function runSeries(opts: SeriesOpts = {}): void {
  const { lateEvery = 0, lateMs = 0, gapFrom = -1, gapTicks = 0 } = opts;
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  const pose = { x: 0, y: 0, angle: 0 };
  const arrivalOf = (i: number): number =>
    (START_TICK + i) * TICK_MS + (lateEvery > 0 && i > 0 && i % lateEvery === 0 ? lateMs : 0);
  const drained = new Array<boolean>(FRAMES).fill(false);
  for (let f = 0; f < FRAMES; f++) {
    const now = (START_TICK + f) * TICK_MS;
    for (let i = 0; i <= f; i++) {
      if (drained[i]) continue;
      if (i >= gapFrom && i < gapFrom + gapTicks) { drained[i] = true; continue; }
      if (arrivalOf(i) > now) continue;
      decodeSwarmPacket(packet(START_TICK + i), mirror, now, true);
      drained[i] = true;
    }
    const entry = mirror.swarm?.get(ENTITY_ID);
    if (entry) interpolateSwarmPose(entry, now, pose);
  }
}

function counters(): number[] {
  return [
    getSwarmLatenessLastMs(), getSwarmLatenessMaxMs(), getSwarmLatenessSumMs(), getSwarmLatenessCount(),
    getSwarmOverwriteUnreadCount(), getSwarmOldEndClampCount(), getSwarmGlideLimitCount(),
  ];
}

describe('drone stream counters', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
  });

  it('clean 60 Hz series at the 100 ms delay: every counter stays at zero', () => {
    runSeries();
    expect(getSwarmLatenessCount()).toBe(FRAMES);
    expect(getSwarmLatenessLastMs()).toBe(0);
    expect(getSwarmLatenessMaxMs()).toBe(0);
    expect(getSwarmLatenessSumMs()).toBe(0);
    expect(getSwarmOverwriteUnreadCount()).toBe(0);
    expect(getSwarmOldEndClampCount()).toBe(0);
    expect(getSwarmGlideLimitCount()).toBe(0);
  });

  it('lateness: late packets raise last / max / sum; other counters stay at zero', () => {
    runSeries({ lateEvery: 10, lateMs: 40 });
    expect(getSwarmLatenessCount()).toBe(FRAMES);
    expect(getSwarmLatenessMaxMs()).toBeGreaterThan(30);
    expect(getSwarmLatenessMaxMs()).toBeLessThanOrEqual(40 + TICK_MS);
    expect(getSwarmLatenessSumMs()).toBeGreaterThan(30 * Math.floor((FRAMES - 1) / 10) - 1);
    expect(getSwarmOverwriteUnreadCount()).toBe(0);
    expect(getSwarmOldEndClampCount()).toBe(0);
    expect(getSwarmGlideLimitCount()).toBe(0);
  });

  it('overwrite-before-read and old-end clamp: a delay longer than the ring at 60 Hz', () => {
    setSwarmDisplayDelayMs(ADAPTIVE_DELAY_CEILING_MS);
    expect(getSwarmDisplayDelayMs()).toBe(ADAPTIVE_DELAY_CEILING_MS);
    runSeries();
    // Recorded 2026-11-21 (280 ms delay, 300 ticks at 60 Hz, ring depth 10):
    // 290 overwrites before read, 291 old-end reads, 0 glide-limit reads.
    expect(getSwarmOverwriteUnreadCount()).toBeGreaterThan(0);
    expect(getSwarmOldEndClampCount()).toBeGreaterThan(0);
    expect(getSwarmGlideLimitCount()).toBe(0);
  });

  it('glide limit: a 500 ms loss gap freezes reads past the extrapolation limit', () => {
    runSeries({ gapFrom: 100, gapTicks: 30 });
    expect(getSwarmGlideLimitCount()).toBeGreaterThan(0);
    expect(getSwarmOverwriteUnreadCount()).toBe(0);
    expect(getSwarmOldEndClampCount()).toBe(0);
  });

  it('reset clears all four counters', () => {
    setSwarmDisplayDelayMs(ADAPTIVE_DELAY_CEILING_MS);
    runSeries({ lateEvery: 10, lateMs: 40, gapFrom: 100, gapTicks: 60 });
    // The last packet is on time, so only last-lateness may already be 0.
    expect(counters().slice(1).every((n) => n > 0)).toBe(true);
    resetSwarmTickClock();
    expect(counters()).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
