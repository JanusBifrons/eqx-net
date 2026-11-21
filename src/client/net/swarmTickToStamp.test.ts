/**
 * S5-1 (netcode gap smoothing, wave 6): a read-only "tick to stamp".
 *
 * `swarmTickToStampMs(tick, nowMs)` must give the stamp `swarmArrivalStampMs`
 * would give for that tick at that moment, and change nothing: no tick clock,
 * lateness counter, estimate, delay, target or hold state. Before the tick
 * clock is seeded it returns NaN.
 *
 * Driven through the same calls the decoder makes per packet
 * (`swarmArrivalStampMs` + `noteSwarmStreamStamp`) and once per 60 Hz frame
 * (`stepSwarmDisplayDelay`), over packets that arrive in order, late,
 * reordered, after a re-seed and during a stream-stall hold.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  swarmArrivalStampMs,
  swarmTickToStampMs,
  noteSwarmStreamStamp,
  stepSwarmDisplayDelay,
  setSwarmDisplaySpeed,
  resetSwarmTickClock,
  getSwarmDisplayDelayMs,
  getSwarmDisplayDelayTargetMs,
  getSwarmStreamNewestStampMs,
  getSwarmResyncCount,
  getSwarmHoldFrameCount,
  getSwarmLatenessLastMs,
  getSwarmLatenessMaxMs,
  getSwarmLatenessSumMs,
  getSwarmLatenessCount,
  getSwarmLatenessEstimateMs,
  getSwarmLatenessDeviationMs,
  getSwarmOverwriteUnreadCount,
  getSwarmOldEndClampCount,
  getSwarmGlideLimitCount,
  TICK_CLOCK_RESYNC_MS,
} from './swarmInterpolation.js';

const FRAME_MS = 1000 / 60;
const TICK_GAME_MS = 1000 / 60;
const START_MS = 10_000;
/** One-way link delay (wall ms). */
const LINK_MS = 40;
/** Extra delay (wall ms) of a "late" packet. */
const LATE_MS = 30;
/** Every Nth tick arrives late. */
const LATE_EVERY = 7;
/** Every Nth tick swaps arrival with the tick after it (reordered pair). */
const REORDER_EVERY = 11;
/** Network stall (backlog delivered at the end): the hold parks during it. */
const STALL_AT_MS = 1500;
/** Stall length (game ms; wall = this / speed): long enough to park the hold,
 *  short enough not to pass MAX_TOTAL_DISPLAY_DELAY_MS (a re-sync, no hold). */
const STALL_GAME_MS = 600;
/** Idle gap long enough to re-seed the tick clock; ticks restart from 0. */
const RESEED_AT_MS = 3000;
const RESEED_GAP_MS = TICK_CLOCK_RESYNC_MS + 500;
const DURATION_MS = 5000;
/** Offsets (ticks) probed besides the packet's own tick: near, far back,
 *  and far enough ahead to take the re-seed branch. */
const PROBE_OFFSETS = [1, -30, 10_000];

interface Packet { tick: number; arriveRel: number }

/** The packet schedule for one run: in order, late, reordered, a stall with
 *  backlog, then an idle gap that restarts the tick basis (re-seed). */
function schedule(speed: number): Packet[] {
  const tickWallMs = TICK_GAME_MS / speed;
  const out: Packet[] = [];
  let base = 0;
  let tick = 0;
  for (let sendRel = 0; sendRel < DURATION_MS; sendRel += tickWallMs) {
    if (base === 0 && sendRel >= RESEED_AT_MS) {
      base = RESEED_GAP_MS;
      tick = 0;
    }
    let arriveRel = sendRel + base + LINK_MS;
    if (tick % LATE_EVERY === LATE_EVERY - 1) arriveRel += LATE_MS;
    if (sendRel >= STALL_AT_MS && sendRel < STALL_AT_MS + STALL_GAME_MS / speed) {
      arriveRel = Math.max(arriveRel, STALL_AT_MS + STALL_GAME_MS / speed + LINK_MS);
    }
    out.push({ tick, arriveRel });
    tick++;
  }
  for (let i = REORDER_EVERY; i + 1 < out.length; i += REORDER_EVERY) {
    const a = out[i]!;
    const b = out[i + 1]!;
    const t = a.tick; a.tick = b.tick; b.tick = t;
  }
  // Delivery order is arrival order (stable for equal arrivals).
  return out.map((p, i) => ({ p, i })).sort((x, y) => x.p.arriveRel - y.p.arriveRel || x.i - y.i).map((x) => x.p);
}

/** Every observable the tick clock feeds. */
function observables(): number[] {
  return [
    getSwarmLatenessLastMs(), getSwarmLatenessMaxMs(), getSwarmLatenessSumMs(), getSwarmLatenessCount(),
    getSwarmLatenessEstimateMs(), getSwarmLatenessDeviationMs(),
    getSwarmDisplayDelayMs(), getSwarmDisplayDelayTargetMs(), getSwarmStreamNewestStampMs(),
    getSwarmResyncCount(), getSwarmHoldFrameCount(),
    getSwarmOverwriteUnreadCount(), getSwarmOldEndClampCount(), getSwarmGlideLimitCount(),
  ];
}

interface RunResult {
  stamps: number[];
  frames: number[][];
  /** Index of the first packet delivered while the stall hold was parked. */
  firstHoldPacket: number;
  /** Index of the first packet after the idle gap (re-seeds the clock). */
  firstReseedPacket: number;
  /** `stop`'s answer when the run stopped at `stopAt`. */
  stopped: number;
}

type Probe = (tick: number, now: number) => void;

/**
 * Drive the schedule frame by frame, as the decoder and mirror do. `probe`
 * (if given) runs before every `swarmArrivalStampMs`. At packet index
 * `stopAt` the run instead returns `stop(now)` (in `stopped`) and ends.
 */
function drive(speed: number, packets: Packet[], probe?: Probe, stopAt = -1, stop?: (now: number) => number): RunResult {
  resetSwarmTickClock();
  setSwarmDisplaySpeed(speed);
  const r: RunResult = { stamps: [], frames: [], firstHoldPacket: -1, firstReseedPacket: -1, stopped: Number.NaN };
  let k = 0;
  let prevHoldFrames = 0;
  let holdLastFrame = false;
  let prevArrive = Number.NaN;
  const endMs = DURATION_MS + RESEED_GAP_MS + LINK_MS + LATE_MS;
  for (let f = 1; f * FRAME_MS <= endMs; f++) {
    const rel = f * FRAME_MS;
    const now = START_MS + rel;
    while (k < packets.length && packets[k]!.arriveRel <= rel) {
      const p = packets[k]!;
      if (k === stopAt && stop) { r.stopped = stop(now); return r; }
      if (holdLastFrame && r.firstHoldPacket < 0) r.firstHoldPacket = k;
      if (p.arriveRel - prevArrive > TICK_CLOCK_RESYNC_MS && r.firstReseedPacket < 0) r.firstReseedPacket = k;
      prevArrive = p.arriveRel;
      probe?.(p.tick, now);
      const stamp = swarmArrivalStampMs(p.tick, now);
      r.stamps.push(stamp);
      noteSwarmStreamStamp(p.tick, stamp);
      k++;
    }
    stepSwarmDisplayDelay(FRAME_MS, now);
    const holdFrames = getSwarmHoldFrameCount();
    holdLastFrame = holdFrames > prevHoldFrames;
    prevHoldFrames = holdFrames;
    r.frames.push(observables());
  }
  return r;
}

describe('swarmTickToStampMs (S5-1)', () => {
  beforeEach(() => { resetSwarmTickClock(); setSwarmDisplaySpeed(1); });
  afterEach(() => { resetSwarmTickClock(); setSwarmDisplaySpeed(1); });

  it('is NaN before the tick clock is seeded, and changes nothing', () => {
    const before = observables();
    expect(Number.isNaN(swarmTickToStampMs(5, START_MS))).toBe(true);
    expect(observables()).toEqual(before);
    // The first packet still seeds the clock (stamp = arrival).
    expect(swarmArrivalStampMs(5, START_MS)).toBe(START_MS);
    expect(swarmTickToStampMs(5, START_MS)).toBe(START_MS);
    resetSwarmTickClock();
    expect(Number.isNaN(swarmTickToStampMs(5, START_MS))).toBe(true);
  });

  for (const speed of [1, 2]) {
    describe(`at ${speed}x`, () => {
      const packets = schedule(speed);

      it('equals swarmArrivalStampMs for each packet tick and leaves every getter alone', () => {
        const reference = drive(speed, packets);
        // The schedule really covers a stall hold and a re-seed.
        expect(reference.firstHoldPacket).toBeGreaterThan(0);
        expect(reference.firstReseedPacket).toBeGreaterThan(reference.firstHoldPacket);
        expect(reference.stamps.length).toBe(packets.length);

        const readOnly: number[] = [];
        const probed = drive(speed, packets, (tick, now) => {
          const before = observables();
          readOnly.push(swarmTickToStampMs(tick, now));
          for (const off of PROBE_OFFSETS) swarmTickToStampMs(tick + off, now);
          expect(observables()).toEqual(before);
        });
        // Probing changed no later stamp (so no tick clock) and no per-frame observable.
        expect(probed.stamps).toEqual(reference.stamps);
        expect(probed.frames).toEqual(reference.frames);
        // First packet: unseeded, NaN. Every later one: the updating stamp, exactly.
        expect(Number.isNaN(readOnly[0]!)).toBe(true);
        for (let i = 1; i < readOnly.length; i++) expect(readOnly[i]).toBe(reference.stamps[i]);
      });

      it('equals swarmArrivalStampMs for other ticks at the same moment (near, far back, re-seed branch)', () => {
        const reference = drive(speed, packets);
        const samples = [
          1, 40, // in order / early
          LATE_EVERY - 1, REORDER_EVERY, REORDER_EVERY + 1, // late, reordered
          reference.firstHoldPacket, reference.firstHoldPacket + 3, // stall backlog, hold parked
          reference.firstReseedPacket, reference.firstReseedPacket + 5, // first packets of a new timeline
          packets.length - 1,
        ];
        for (const k of samples) {
          for (const off of [0, ...PROBE_OFFSETS]) {
            const tick = packets[k]!.tick + off;
            const readOnly = drive(speed, packets, undefined, k, (now) => swarmTickToStampMs(tick, now)).stopped;
            const updating = drive(speed, packets, undefined, k, (now) => swarmArrivalStampMs(tick, now)).stopped;
            expect(Number.isFinite(readOnly)).toBe(true);
            expect(readOnly).toBe(updating);
          }
        }
      });
    });
  }
});
