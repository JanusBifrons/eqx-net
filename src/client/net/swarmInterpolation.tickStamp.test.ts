/**
 * Fleet-melee follow jitter (owner, take 10: "The ship jitters a lot it
 * looks like (or is it the camera)"). It was the ship: a live probe of the
 * followed AI-flown fighter showed the camera moving evenly (frame-to-frame
 * jerk 0.03 u) while the DRAWN drone pose stepped 0–5.3 u per frame at a
 * steady ~2.8 u cruise (jerk 1.4 u). Cause: the pose ring stamped each binary
 * packet with its drain time, and packets drain once per RAF, so two ticks
 * landing in one frame shared a stamp and the lerp ran at 0×, then 2× speed.
 *
 * This drives the real decoder + `interpolateSwarmPose` the way the client
 * does (60 Hz server ticks, arrivals jittered by a few ms, drained per RAF,
 * one interpolation per frame) and measures the drawn pose's per-frame step.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { decodeSwarmPacket } from './BinarySwarmDecoder.js';
import { interpolateSwarmPose, resetSwarmTickClock, setSwarmDisplayDelayMs, setSwarmDisplaySpeed, DISPLAY_DELAY_MS } from './swarmInterpolation.js';
import type { RenderMirror } from '../../core/contracts/IRenderer.js';
import {
  SWARM_HEADER_BYTES, SWARM_RECORD_BYTES, SWARM_REC_ANGVEL_OFF, SWARM_REC_RADIUS_OFF, SWARM_WIRE_VERSION,
} from '../../shared-types/swarmWireFormat.js';

const TICK_MS = 1000 / 60;
const SPEED_U_PER_TICK = 2.8; // ≈ 168 u/s, the followed fighter's cruise in the probe

function packet(tick: number, x: number): Uint8Array {
  const buf = new ArrayBuffer(SWARM_HEADER_BYTES + SWARM_RECORD_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, SWARM_WIRE_VERSION);
  v.setUint8(1, 0);
  v.setUint16(2, 1, true);
  v.setUint32(4, tick, true);
  const o = SWARM_HEADER_BYTES;
  v.setUint16(o, 7, true);
  v.setUint8(o + 2, 1); // drone
  v.setFloat32(o + 4, x, true);
  v.setFloat32(o + 12, (SPEED_U_PER_TICK * 1000) / TICK_MS, true);
  v.setFloat32(o + SWARM_REC_ANGVEL_OFF, 0, true);
  v.setFloat32(o + SWARM_REC_RADIUS_OFF, 12, true);
  return new Uint8Array(buf);
}

/** Worst per-frame step error (u) of the drawn pose over 10 s of cruise. */
function worstStepError(stampByTick: boolean): number {
  const mirror: RenderMirror = { ships: new Map(), localPlayerId: null };
  const pose = { x: 0, y: 0, angle: 0 };
  let nextTick = 1000;
  let prevX = NaN;
  let worst = 0;
  const frameMs = 1000 / 60;
  for (let f = 0; f < 600; f++) {
    // RAF times wobble ±3 ms around the vsync grid, as a busy page's do.
    const now = 50_000 + f * frameMs + 3 * Math.sin(f * 1.7);
    // Drain every packet that has arrived by now: sent at its tick, ~40 ms
    // in flight with ±6 ms of jitter.
    for (;;) {
      const arrival = 50_000 + (nextTick - 1000) * TICK_MS - 60 + 40 + 6 * Math.sin(nextTick * 2.3);
      if (arrival > now) break;
      decodeSwarmPacket(packet(nextTick, (nextTick - 1000) * SPEED_U_PER_TICK), mirror, now, stampByTick);
      nextTick++;
    }
    const entry = mirror.swarm?.get(7);
    if (!entry) continue;
    interpolateSwarmPose(entry, now, pose);
    if (f > 120 && !Number.isNaN(prevX)) {
      // The frame's wall span sets the true advance (RAF times wobble too).
      const prevNow = 50_000 + (f - 1) * frameMs + 3 * Math.sin((f - 1) * 1.7);
      const expected = ((now - prevNow) / TICK_MS) * SPEED_U_PER_TICK;
      worst = Math.max(worst, Math.abs(pose.x - prevX - expected));
    }
    prevX = pose.x;
  }
  return worst;
}

describe('swarm pose ring stamped on the server-tick clock', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
    setSwarmDisplayDelayMs(DISPLAY_DELAY_MS);
  });

  it('control: stamping by drain time makes the drawn drone step unevenly', () => {
    expect(worstStepError(false)).toBeGreaterThan(1.5);
  });

  it('a cruising drone advances evenly frame to frame when stamped by tick', () => {
    expect(worstStepError(true)).toBeLessThan(0.3);
  });
});
