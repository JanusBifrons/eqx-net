/**
 * Netgap S1-6: another player's ship through the real client, in three
 * fixtures, with today's numbers recorded (plan sections 3.2, 3.3, 5.2, 9.1).
 *
 * Each fixture flies one remote fighter on its own authoritative "server"
 * PhysicsWorld, scripts it into the snapshots of a captured session through
 * `replayCapture({ remoteShip })`, and reads the drawn pose the renderer
 * would draw on every frame (physics plus the decaying correction offset):
 *
 *  (a) turn in a gap: the pilot starts turning while snapshots are held;
 *  (b) two corrections in a row: two 10 u nudges land on consecutive frames,
 *      so the second arrives while the first is still easing (plan 3.3);
 *  (c) a real teleport: a 2000 u jump (plan 3.2: no guard, it is glided).
 *
 * Capture: 2q0jxw (dense ~90 Hz frames, ~50 ms snapshots). All three
 * fixtures act inside its quiet stretch (capture time 51.6-56.5 s, no
 * natural snapshot gap over 150 ms), so the counts measure the fixture, not
 * the capture's own stalls. Everything runs on the capture's mock clock.
 *
 * Truth per frame: the server tick at the frame's capture time, read off the
 * capture's own (arrival time, server tick) pairs, and the scripted track
 * interpolated at that tick.
 *
 * The numbers below are TODAY's, locked exactly. A fix that changes them
 * updates them in the same PR; the `it.fails` cases flip to `it` when the
 * target behaviour lands (S2-1 for the step, S2-3 for the teleport).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import RAPIER from '@dimforge/rapier2d-compat';
import { PhysicsWorld, type ShipInput, type ShipPhysicsState } from '../../src/core/physics/World.js';
import { loadCapture, type TimelineEvent } from './captureLoader.js';
import {
  replayCapture,
  type RemoteDrawnPoseSample,
  type RemoteShipWireState,
  type ReplayResult,
} from './captureHarness.js';
import {
  countMotionArtefacts,
  MOTION_SNAP_TOLERANCE_U,
  type MotionCounters,
  type MotionFrame,
} from '../scenarios/assertions.js';

const CAPTURE = 'diag/captures/2026-05-21T16-04-16Z-2q0jxw';
const REMOTE_ID = 'remote-pilot';
const KIND = 'fighter';
const TICK_S = 1 / 60;
/** Far from the local ship, so the two never touch. */
const REMOTE_OFFSET_Y = 3000;
const HEADING = 0.6;

/** Every fixture acts at this capture time (inside the quiet stretch). */
const EVENT_MS = 53000;
/** Frames counted: from just before the event until well after it settles. */
const WINDOW_START_MS = EVENT_MS - 500;
const WINDOW_END_MS = EVENT_MS + 2500;

/** (a): snapshots are held this long; the pilot starts turning this far in. */
const GAP_MS = 400;
const TURN_AFTER_GAP_START_MS = 100;
/** (b): size of each of the two nudges (over the 1 u "moved" threshold). */
const NUDGE_U = 10;
/** (c): jump size. */
const TELEPORT_U = 2000;
/** (c): an offset over this is still gliding the jump (ordinary corrections
 *  on a thrusting ship stay near 10 u). */
const LARGE_OFFSET_U = 100;

const IDLE: ShipInput = { thrust: false, turnLeft: false, turnRight: false, boost: false, reverse: false };
const THRUST: ShipInput = { ...IDLE, thrust: true };
const THRUST_LEFT: ShipInput = { ...IDLE, thrust: true, turnLeft: true };

type SnapshotEvent = Extract<TimelineEvent, { kind: 'snapshot' }>;

interface TrackPoint extends ShipPhysicsState {
  angvel: number;
  /** Input the pilot holds at this tick; null = idle (no bits on the wire). */
  input: ShipInput | null;
}

interface Script {
  inputAt(tick: number): ShipInput | null;
  /** Replace the server state at this tick (a nudge or a teleport), or null. */
  editAt(tick: number, s: ShipPhysicsState): ShipPhysicsState | null;
}

interface Timeline {
  snaps: SnapshotEvent[];
  rafMs: number[];
  firstTick: number;
  lastTick: number;
  startX: number;
  startY: number;
}

function readTimeline(): Timeline {
  const cap = loadCapture(CAPTURE);
  const snaps = cap.events.filter((e): e is SnapshotEvent => e.kind === 'snapshot');
  const rafMs = cap.events.filter((e) => e.kind === 'rafTick').map((e) => e.ts);
  return {
    snaps,
    rafMs,
    firstTick: snaps[0]!.data.serverTick,
    lastTick: snaps[snaps.length - 1]!.data.serverTick,
    startX: snaps[0]!.data.serverX,
    startY: snaps[0]!.data.serverY + REMOTE_OFFSET_Y,
  };
}

/** The server's tick at capture time `atMs`, from the capture's own pairs. */
function serverTickAt(tl: Timeline, atMs: number): number {
  const s = tl.snaps;
  if (atMs <= s[0]!.ts) return s[0]!.data.serverTick;
  for (let i = 1; i < s.length; i++) {
    const b = s[i]!;
    if (atMs > b.ts) continue;
    const a = s[i - 1]!;
    const u = b.ts > a.ts ? (atMs - a.ts) / (b.ts - a.ts) : 1;
    return a.data.serverTick + (b.data.serverTick - a.data.serverTick) * u;
  }
  return s[s.length - 1]!.data.serverTick;
}

/** Fly the script on a server world once, keeping every tick's state. */
async function buildTrack(tl: Timeline, script: Script, vx0: number, vy0: number): Promise<TrackPoint[]> {
  const server = await PhysicsWorld.create();
  server.spawnShip(REMOTE_ID, tl.startX, tl.startY, KIND);
  server.setShipState(REMOTE_ID, { x: tl.startX, y: tl.startY, vx: vx0, vy: vy0, angle: HEADING, angvel: 0 });
  const track: TrackPoint[] = [];
  for (let t = tl.firstTick; t <= tl.lastTick + 1; t++) {
    const cur = server.getShipState(REMOTE_ID)!;
    const edited = script.editAt(t, { x: cur.x, y: cur.y, vx: cur.vx, vy: cur.vy, angle: cur.angle, angvel: cur.angvel ?? 0 });
    if (edited) server.setShipState(REMOTE_ID, edited);
    const s = server.getShipState(REMOTE_ID)!;
    const input = script.inputAt(t);
    track.push({ x: s.x, y: s.y, vx: s.vx, vy: s.vy, angle: s.angle, angvel: s.angvel ?? 0, input });
    if (input) server.applyInput(REMOTE_ID, input);
    server.tick(TICK_S);
  }
  server.dispose();
  return track;
}

function wireAt(tl: Timeline, track: TrackPoint[], tick: number): RemoteShipWireState {
  const p = track[tick - tl.firstTick]!;
  return {
    x: p.x, y: p.y, vx: p.vx, vy: p.vy, angle: p.angle, angvel: p.angvel,
    ...(p.input
      ? {
          lastInput: {
            thrust: p.input.thrust,
            turnLeft: p.input.turnLeft,
            turnRight: p.input.turnRight,
            boost: p.input.boost === true,
            reverse: p.input.reverse === true,
          },
        }
      : {}),
  };
}

function trueAt(tl: Timeline, track: TrackPoint[], atMs: number): { x: number; y: number } {
  const t = serverTickAt(tl, atMs) - tl.firstTick;
  const i = Math.min(Math.floor(t), track.length - 2);
  const u = t - i;
  const a = track[i]!;
  const b = track[i + 1]!;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

function windowFrames(res: ReplayResult): RemoteDrawnPoseSample[] {
  return res.remoteDrawnPoses.filter(
    (p) => !Number.isNaN(p.physX) && p.atMs >= WINDOW_START_MS && p.atMs <= WINDOW_END_MS,
  );
}

function motionFrames(tl: Timeline, track: TrackPoint[], frames: RemoteDrawnPoseSample[]): MotionFrame[] {
  return frames.map((p) => {
    const tr = trueAt(tl, track, p.atMs);
    return { atMs: p.atMs, drawnX: p.x, drawnY: p.y, trueX: tr.x, trueY: tr.y };
  });
}

/** Counters rounded to 3 decimals, so the locked values read cleanly. */
function rounded(c: MotionCounters): MotionCounters {
  const r = (v: number): number => Math.round(v * 1000) / 1000;
  return {
    snaps: c.snaps,
    largestSnapU: r(c.largestSnapU),
    totalSnapU: r(c.totalSnapU),
    freezeFrames: c.freezeFrames,
    backwardSteps: c.backwardSteps,
    meanLatenessMs: r(c.meanLatenessMs),
    maxLatenessMs: r(c.maxLatenessMs),
  };
}

function drawnStepU(frames: RemoteDrawnPoseSample[], i: number): number {
  return Math.hypot(frames[i]!.x - frames[i - 1]!.x, frames[i]!.y - frames[i - 1]!.y);
}

describe('other players\' ships through gaps and corrections — today\'s numbers (netgap S1-6)', () => {
  let tl: Timeline;

  beforeAll(async () => {
    await RAPIER.init();
    tl = readTimeline();
  });

  describe('(a) the ship turns while snapshots are held in a gap', () => {
    let counters: MotionCounters;
    let heldCount = 0;

    beforeAll(async () => {
      const turnTick = Math.ceil(serverTickAt(tl, EVENT_MS + TURN_AFTER_GAP_START_MS));
      const track = await buildTrack(tl, {
        inputAt: (t) => (t >= turnTick ? THRUST_LEFT : THRUST),
        editAt: () => null,
      }, 0, 0);
      const res = await replayCapture(CAPTURE, {
        remoteShip: {
          id: REMOTE_ID,
          kind: KIND,
          stateAt: (t) => wireAt(tl, track, t),
          deliverAtMs: (_t, atMs) => {
            if (atMs < EVENT_MS || atMs >= EVENT_MS + GAP_MS) return atMs;
            heldCount++;
            return EVENT_MS + GAP_MS;
          },
        },
      });
      counters = rounded(countMotionArtefacts(motionFrames(tl, track, windowFrames(res))));
    });

    it('records today\'s counts', () => {
      expect(heldCount).toBe(9);
      // S2-1 (continuous offset): largest snap 99.388 -> 26.49 u, total
      // 216.609 -> 212.087 u, but the gap's correction is now spread over
      // more frames, so more of them cross the snap tolerance (41 -> 50).
      expect(counters.snaps).toBe(50);
      expect(counters.largestSnapU).toBeCloseTo(26.49, 2);
      expect(counters.totalSnapU).toBeCloseTo(212.087, 2);
      expect(counters.freezeFrames).toBe(10);
      expect(counters.backwardSteps).toBe(0);
      // Negative: drawn ahead of the truth, which is read at the snapshots'
      // ARRIVAL times (one-way delay late) while remotes are forward-predicted.
      expect(counters.meanLatenessMs).toBeCloseTo(-88.428, 2);
      // Not investigated: on a turning track the lateness search (2 s either
      // side) may match a point the truth passed much earlier.
      expect(counters.maxLatenessMs).toBeCloseTo(1451.1, 2);
    });
  });

  describe('(b) two corrections in a row, the second while the first is still easing', () => {
    let counters: MotionCounters;
    let firstStepU = 0;
    let secondStepU = 0;
    let firstOffsetU = 0;
    let offsetBeforeSecondU = 0;

    beforeAll(async () => {
      // The two snapshots after EVENT_MS carry the two nudges.
      const k = tl.snaps.findIndex((s) => s.ts >= EVENT_MS);
      const snapA = tl.snaps[k]!;
      const snapB = tl.snaps[k + 1]!;
      const tickA = snapA.data.serverTick;
      const tickB = snapB.data.serverTick;
      // Hold A to the last frame before B arrives: A applies on that frame,
      // B on the next one.
      const lastFrameBeforeB = tl.rafMs.filter((ms) => ms > snapA.ts && ms < snapB.ts).pop();
      expect(lastFrameBeforeB).toBeDefined();
      const track = await buildTrack(tl, {
        inputAt: () => null,
        editAt: (t, s) => (t === tickA || t === tickB ? { ...s, x: s.x + NUDGE_U } : null),
      }, 0, 0);
      const res = await replayCapture(CAPTURE, {
        remoteShip: {
          id: REMOTE_ID,
          kind: KIND,
          stateAt: (t) => wireAt(tl, track, t),
          deliverAtMs: (t, atMs) => (t === tickA ? lastFrameBeforeB! : atMs),
        },
      });
      const frames = windowFrames(res);
      const iA = frames.findIndex((p) => p.lastAppliedServerTick >= tickA);
      const iB = frames.findIndex((p) => p.lastAppliedServerTick >= tickB);
      expect(iB).toBe(iA + 1);
      firstStepU = drawnStepU(frames, iA);
      secondStepU = drawnStepU(frames, iB);
      firstOffsetU = Math.hypot(frames[iA]!.offsetX, frames[iA]!.offsetY);
      offsetBeforeSecondU = Math.hypot(frames[iB - 1]!.offsetX, frames[iB - 1]!.offsetY);
      counters = rounded(countMotionArtefacts(motionFrames(tl, track, frames)));
    });

    it('records today\'s counts and the step at each correction', () => {
      // First correction: the drawn ship stays put and starts easing (offset
      // -10 u after one frame of decay: 8.283 u left, 1.717 u moved).
      expect(firstOffsetU).toBeCloseTo(8.283, 2);
      expect(firstStepU).toBeCloseTo(1.717, 2);
      // Second correction, one frame later: the 8.283 u still easing is
      // carried into the new offset (S2-1), so the drawn ship only eases
      // (3.138 u; was 10.000 u when the easing part was dropped).
      expect(offsetBeforeSecondU).toBeCloseTo(8.283, 2);
      expect(secondStepU).toBeCloseTo(3.138, 2);
      expect(counters.snaps).toBe(3);
      expect(counters.largestSnapU).toBeCloseTo(4.887, 2);
      expect(counters.totalSnapU).toBeCloseTo(11.451, 2);
      expect(counters.freezeFrames).toBe(3);
      expect(counters.backwardSteps).toBe(0);
      expect(counters.meanLatenessMs).toBeCloseTo(3.516, 2);
      expect(counters.maxLatenessMs).toBeCloseTo(104.791, 2);
    });

    // Plan 3.3, S2-1: new offset = drawn before - physics after, so the
    // second correction moves the drawn ship no more than the first one did
    // (plus the snap tolerance). 3.138 u against 1.717 u (was 10.000 u).
    it('no step on the second correction', () => {
      expect(secondStepU).toBeLessThanOrEqual(firstStepU + MOTION_SNAP_TOLERANCE_U);
    });
  });

  describe('(c) a real teleport', () => {
    let counters: MotionCounters;
    /** Frames after the teleport arrives whose offset is still over LARGE_OFFSET_U. */
    let glideFrames = 0;
    /** Drawn step on the frame the teleport arrives. */
    let arrivalStepU = 0;

    beforeAll(async () => {
      const k = tl.snaps.findIndex((s) => s.ts >= EVENT_MS);
      const tickT = tl.snaps[k]!.data.serverTick;
      const track = await buildTrack(tl, {
        inputAt: () => THRUST,
        editAt: (t, s) => (t === tickT ? { ...s, x: s.x + TELEPORT_U } : null),
      }, 0, 0);
      const res = await replayCapture(CAPTURE, {
        remoteShip: { id: REMOTE_ID, kind: KIND, stateAt: (t) => wireAt(tl, track, t) },
      });
      const frames = windowFrames(res);
      const iT = frames.findIndex((p) => p.lastAppliedServerTick >= tickT);
      for (let i = iT; i < frames.length; i++) {
        if (Math.hypot(frames[i]!.offsetX, frames[i]!.offsetY) > LARGE_OFFSET_U) glideFrames++;
      }
      arrivalStepU = drawnStepU(frames, iT);
      counters = rounded(countMotionArtefacts(motionFrames(tl, track, frames)));
    });

    it('records today\'s counts: the 2000 u jump is drawn in one frame', () => {
      // S2-1 made the offset continuous, so the jump glided eight frames
      // (snaps 46, backward steps 14). S2-3 snaps a jump no ship could fly:
      // the drawn ship moves the whole ~2000 u on the arrival frame (was
      // 341.4 u) and the glide is gone (8 -> 0 frames; snaps 46 -> 37,
      // largest 527.919 -> 1423.837 u, total 1665.288 -> 1524.661 u,
      // backward steps 14 -> 2). The largest snap is the jump itself, read
      // against a truth taken at the snapshot's arrival time.
      expect(glideFrames).toBe(0);
      expect(arrivalStepU).toBeCloseTo(1991.9, 0);
      expect(counters.snaps).toBe(37);
      expect(counters.largestSnapU).toBeCloseTo(1423.837, 2);
      expect(counters.totalSnapU).toBeCloseTo(1524.661, 2);
      expect(counters.freezeFrames).toBe(1);
      expect(counters.backwardSteps).toBe(2);
      expect(counters.meanLatenessMs).toBeCloseTo(-154.663, 2);
      expect(counters.maxLatenessMs).toBeCloseTo(19.6, 2);
    });

    // Plan 3.2, S2-3: a real teleport is snapped on the frame it arrives,
    // not glided (was 8 frames drawn more than 100 u off).
    it('a real teleport snaps in one frame', () => {
      expect(glideFrames).toBe(0);
    });
  });
});
