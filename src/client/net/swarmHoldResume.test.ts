/**
 * S4-5 (netcode gap smoothing, wave 5): hold without losing the place.
 *
 * When the whole drone stream stalls, `stepSwarmDisplayDelay(frameMs, nowMs)`
 * grows the delay so the read point (now − delay) stays at "stream newest
 * stamp + glide limit"; when packets return playback resumes from there and
 * the existing slew (S3-2) brings the delay back to its target. A stall that
 * would push the delay past MAX_TOTAL_DISPLAY_DELAY_MS / speed re-syncs it to
 * the target in one step, counted once per stall (S4-4).
 *
 * Driven through the same calls the decoder makes per packet
 * (`swarmArrivalStampMs` + `noteSwarmStreamStamp`) and once per 60 Hz frame.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  swarmArrivalStampMs,
  noteSwarmStreamStamp,
  stepSwarmDisplayDelay,
  setSwarmDisplaySpeed,
  resetSwarmTickClock,
  getSwarmDisplayDelayMs,
  getSwarmDisplayDelayTargetMs,
  getSwarmStreamNewestStampMs,
  getSwarmResyncCount,
  getSwarmHoldFrameCount,
  EXTRAPOLATION_LIMIT_MS,
  MAX_TOTAL_DISPLAY_DELAY_MS,
  DISPLAY_DELAY_MS,
  DISPLAY_DELAY_SLEW_MAX_RATE,
} from './swarmInterpolation.js';
import { POSE_RING_DEPTH } from '../../core/contracts/IRenderer.js';

const FRAME_MS = 1000 / 60;
/** One server tick in game ms. */
const TICK_GAME_MS = 1000 / 60;
const START_MS = 10_000;
/** One-way link delay (wall ms). */
const LINK_MS = 40;
const EPS = 1e-6;
/** How far (wall ms) the post-stall tick clock may sit from a stall-free run. */
const BACKLOG_DRIFT_TOLERANCE_MS = 2;
/** How close (wall ms) the delay is to its target 1.6 s after a 400 ms stall. */
const CATCH_UP_TOLERANCE_MS = 10;

interface Stall { atMs: number; durationMs: number; idle: boolean }

interface FrameTrace { t: number; delay: number; target: number; readPoint: number; newest: number }

/**
 * Run `durationMs` of 60 Hz frames at game speed `speed`. The server ticks at
 * 60 × speed per wall second; each tick's packet arrives LINK_MS later. During
 * a stall nothing arrives: a network stall delivers its backlog at the end, an
 * idle stall (idle sector) never sends it. Returns one trace row per frame;
 * `stamps`, when given, receives each tick's ring stamp.
 */
function run(speed: number, durationMs: number, stall?: Stall, stamps?: number[]): FrameTrace[] {
  setSwarmDisplaySpeed(speed);
  const tickWallMs = TICK_GAME_MS / speed;
  const out: FrameTrace[] = [];
  let tick = 0;
  for (let f = 1; f * FRAME_MS <= durationMs; f++) {
    const rel = f * FRAME_MS;
    const now = START_MS + rel;
    for (;;) {
      const sendRel = tick * tickWallMs;
      let arriveRel = sendRel + LINK_MS;
      const inStall = stall !== undefined && sendRel >= stall.atMs && sendRel < stall.atMs + stall.durationMs;
      if (inStall && stall.idle) { tick++; continue; }
      if (inStall) arriveRel = Math.max(arriveRel, stall.atMs + stall.durationMs + LINK_MS);
      if (arriveRel > rel) break;
      const stamp = swarmArrivalStampMs(tick, now);
      if (stamps) stamps[tick] = stamp;
      noteSwarmStreamStamp(tick, stamp);
      tick++;
    }
    stepSwarmDisplayDelay(FRAME_MS, now);
    const delay = getSwarmDisplayDelayMs();
    out.push({ t: now, delay, target: getSwarmDisplayDelayTargetMs(), readPoint: now - delay, newest: getSwarmStreamNewestStampMs() });
  }
  return out;
}

describe('stream-stall hold (S4-5)', () => {
  beforeEach(() => { resetSwarmTickClock(); });
  afterEach(() => { setSwarmDisplaySpeed(1); resetSwarmTickClock(); });

  it('a live stream never holds: the delay stays at the 100 ms floor', () => {
    const trace = run(1, 3000);
    expect(getSwarmHoldFrameCount()).toBe(0);
    expect(getSwarmResyncCount()).toBe(0);
    for (const r of trace) expect(r.delay).toBe(DISPLAY_DELAY_MS);
  });

  it('400 ms stall: the read point parks at newest + glide limit, then resumes from there', () => {
    const trace = run(1, 4000, { atMs: 2000, durationMs: 400, idle: false });
    expect(getSwarmHoldFrameCount()).toBeGreaterThan(0);
    expect(getSwarmResyncCount()).toBe(0);
    for (let i = 1; i < trace.length; i++) {
      const prev = trace[i - 1]!;
      const r = trace[i]!;
      if (Number.isNaN(prev.newest)) continue; // before the first packet
      // Never past the stream's newest stamp + glide limit (no freeze-then-snap).
      expect(r.readPoint).toBeLessThanOrEqual(r.newest + EXTRAPOLATION_LIMIT_MS + EPS);
      // The read point never goes back, and never runs faster than the slew allows.
      expect(r.readPoint).toBeGreaterThanOrEqual(prev.readPoint - EPS);
      expect(r.readPoint - prev.readPoint).toBeLessThanOrEqual(FRAME_MS * (1 + DISPLAY_DELAY_SLEW_MAX_RATE) + EPS);
      expect(r.delay).toBeLessThanOrEqual(MAX_TOTAL_DISPLAY_DELAY_MS + EPS);
    }
    // Catch-up is the slew alone: by the end the delay has come back to its
    // (still moving, lateness-fed) target.
    const last = trace[trace.length - 1]!;
    expect(Math.abs(last.delay - last.target)).toBeLessThan(CATCH_UP_TOLERANCE_MS);
  });

  it('a 1 s stall re-syncs exactly once and never passes the 400 ms bound', () => {
    const trace = run(1, 4000, { atMs: 2000, durationMs: 1000, idle: false });
    expect(getSwarmResyncCount()).toBe(1);
    for (const r of trace) expect(r.delay).toBeLessThanOrEqual(MAX_TOTAL_DISPLAY_DELAY_MS + EPS);
  });

  it('idle-sector resume: one re-sync, and the delay is at its target once packets return', () => {
    const idle: Stall = { atMs: 2000, durationMs: 4000, idle: true };
    const trace = run(1, 8000, idle);
    expect(getSwarmResyncCount()).toBe(1);
    const resumeAt = START_MS + idle.atMs + idle.durationMs + LINK_MS;
    for (const r of trace) {
      if (r.t >= resumeAt) expect(r.delay).toBe(r.target);
    }
  });

  it('the hold never needs more history than the pose ring holds', () => {
    // At the bound the read point is MAX_TOTAL_DISPLAY_DELAY_MS game ms back:
    // that many ticks (plus the bracketing pose) must fit the ring.
    expect(Math.ceil(MAX_TOTAL_DISPLAY_DELAY_MS / TICK_GAME_MS) + 1).toBeLessThanOrEqual(POSE_RING_DEPTH);
  });

  it('stall backlog does not drag the tick clock: resumed stamps continue the held timeline', () => {
    const stall: Stall = { atMs: 2000, durationMs: 600, idle: false };
    const cleanStamps: number[] = [];
    run(1, 4000, undefined, cleanStamps);
    resetSwarmTickClock();
    const stalledStamps: number[] = [];
    run(1, 4000, stall, stalledStamps);
    // Every backlog packet keeps the gap to its stall-free stamp it had when
    // the stall began (the whole backlog shifts together, never stretches):
    // without the guard ~36 backlog packets drifted the clock ~100 ms late.
    const firstBacklogTick = Math.ceil(stall.atMs / TICK_GAME_MS);
    const lastBacklogTick = Math.ceil((stall.atMs + stall.durationMs) / TICK_GAME_MS) - 1;
    const shift = stalledStamps[firstBacklogTick]! - cleanStamps[firstBacklogTick]!;
    for (let k = firstBacklogTick; k <= lastBacklogTick; k++) {
      expect(Math.abs(stalledStamps[k]! - cleanStamps[k]! - shift), `tick ${k}`).toBeLessThan(BACKLOG_DRIFT_TOLERANCE_MS);
    }
  });
});
