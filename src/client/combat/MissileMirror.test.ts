/**
 * MissileMirror unit tests — snapshot apply + pose-ring display resolution
 * (playtest 2026-06-10 Issue 11: missiles backported to the drone pose-ring).
 *
 * Covers:
 *   - First-seen snapshot seeds the ring (resolve returns the seeded pose)
 *   - Second+ snapshots slide into the ring (newest pose tracked)
 *   - resolveMissileDisplayPose interpolates between BRACKETING ring samples
 *     at now − display-delay
 *   - Extrapolation past the newest sample, capped
 *   - Jittered arrival times → smooth, monotonic resolved motion (the fix)
 *   - Ring-depth structural invariant
 *   - Stale-eviction + removeMissile + null-for-unknown
 *   - The shared drone display delay (S5-4): followed when it changes,
 *     fixed fallback before the drone clock seeds, wall ms at 2× and 0.7×
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  applyMissileSnapshot,
  publishSwarmDisplayDelay,
  removeMissile,
  resolveMissileDisplayPose,
  MISSILE_DISPLAY_DELAY_MS,
  MISSILE_EXTRAPOLATION_CAP_MS,
} from './MissileMirror';
import { MISSILE_POSE_RING_DEPTH, type RenderMirror } from '../../core/contracts/IRenderer';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages';
import {
  getSwarmDisplayDelayMs,
  noteSwarmStreamStamp,
  resetSwarmTickClock,
  setSwarmDisplayDelayMs,
  setSwarmDisplaySpeed,
  stepSwarmDisplayDelay,
  swarmArrivalStampMs,
} from '../net/swarmInterpolation.js';

function makeMirror(): RenderMirror {
  return { ships: new Map(), localPlayerId: null };
}

function makeSlice(entries: Array<{
  id: number; x: number; y: number; vx?: number; vy?: number; angle?: number; angvel?: number; lifePct?: number;
}>): NonNullable<SnapshotMessage['missiles']> {
  return entries.map((e) => ({
    id: e.id,
    x: e.x, y: e.y,
    vx: e.vx ?? 0, vy: e.vy ?? 0,
    angle: e.angle ?? 0,
    angvel: e.angvel ?? 0,
    ownerId: 'player-a',
    weaponId: 'heat-seeker' as const,
    lifePct: e.lifePct ?? 1,
  }));
}

describe('MissileMirror.applyMissileSnapshot', () => {
  it('first-seen entry seeds the ring; resolve returns the seeded pose', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 7, x: 100, y: 200 }]), mirror, 1, 1000);
    const m = mirror.missiles!.get(7)!;
    expect(m.x).toBe(100);
    expect(m.latestArrivalMs).toBe(1000);
    expect(m.poseRing.filter((e) => !e.empty).length).toBe(1);
    // count-1 → pin to the single sample.
    const pose = resolveMissileDisplayPose(mirror, 7, 1050);
    expect(pose!.x).toBe(100);
    expect(pose!.y).toBe(200);
  });

  it('successive snapshots slide into the ring (newest pose tracked)', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 7, x: 0, y: 0 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 7, x: 100, y: 50 }]), mirror, 2, 1050);
    const m = mirror.missiles!.get(7)!;
    expect(m.x).toBe(100);
    expect(m.y).toBe(50);
    expect(m.latestArrivalMs).toBe(1050);
    expect(m.poseRing.filter((e) => !e.empty).length).toBe(2);
  });

  it('interpolates between the two bracketing ring samples at now − display-delay', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 200, y: 0 }]), mirror, 2, 1100);
    // target = nowMs − 100. Pick nowMs so target = 1050 (midway 1000→1100) → x≈100.
    const pose = resolveMissileDisplayPose(mirror, 1, 1050 + MISSILE_DISPLAY_DELAY_MS);
    expect(pose).not.toBeNull();
    expect(pose!.x).toBeCloseTo(100, 5);
  });

  it('teleport bound: just over the shared bound snaps, just under interpolates', () => {
    // span 100 ms → bound = max(TELEPORT_FLOOR_U, 2500 u/s × 0.1 s) = 250 u.
    const over = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0 }]), over, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 251, y: 0 }]), over, 2, 1100);
    const snapped = resolveMissileDisplayPose(over, 1, 1050 + MISSILE_DISPLAY_DELAY_MS);
    expect(snapped!.x).toBe(251);

    const under = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0 }]), under, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 249, y: 0 }]), under, 2, 1100);
    const lerped = resolveMissileDisplayPose(under, 1, 1050 + MISSILE_DISPLAY_DELAY_MS);
    expect(lerped!.x).toBeGreaterThan(0);
    expect(lerped!.x).toBeLessThan(249);
  });

  it('past the newest sample with velocity: dead-reckons forward, capped', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0, vx: 0, vy: 400 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 20, vx: 0, vy: 400 }]), mirror, 2, 1050);
    // overshootMs = nowMs − 100 − 1050. nowMs 1190 → target 1090 → overshoot 40.
    const pose40 = resolveMissileDisplayPose(mirror, 1, 1190);
    expect(pose40!.y).toBeCloseTo(20 + 400 * 0.04, 1); // 36
    // Far future → capped at MISSILE_EXTRAPOLATION_CAP_MS.
    const poseFar = resolveMissileDisplayPose(mirror, 1, 1050 + 100 + 5000);
    expect(poseFar!.y).toBeCloseTo(20 + 400 * (MISSILE_EXTRAPOLATION_CAP_MS / 1000), 1);
  });

  it('past the newest sample with zero velocity: freezes at the newest pose', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0, vx: 0, vy: 0 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 100, y: 0, vx: 0, vy: 0 }]), mirror, 2, 1100);
    expect(resolveMissileDisplayPose(mirror, 1, 5000)!.x).toBe(100);
  });

  it('JITTERED arrival times → smooth, monotonic resolved motion (the ~20Hz-look fix)', () => {
    const mirror = makeMirror();
    // Missile moving +x at the real heat-seeker speed (400 u/s ⇒ ~20 u per
    // nominal 50 ms), but the snapshots ARRIVE with jitter (53/45/57/48 ms
    // gaps). The pre-fix velocity dead-reckon made the visible speed cheat the
    // same motion across varying wall-clock windows → speed-up/slow-down jitter.
    const vx = 400;
    const arrivals = [1000, 1053, 1098, 1155, 1203];
    arrivals.forEach((t, i) => {
      // Pose advances with WALL-CLOCK arrival time × speed, so the buffered
      // truth is internally consistent (what the server would have sent).
      applyMissileSnapshot(makeSlice([{ id: 1, x: ((t - 1000) / 1000) * vx, y: 0, vx, vy: 0 }]), mirror, i + 1, t);
    });
    // Sample every 16 ms across the buffered window: never backward, never a
    // whole-snapshot snap (the jitter artifact).
    let prev = -Infinity;
    let maxStep = 0;
    for (let now = 1110; now <= 1300; now += 16) {
      const p = resolveMissileDisplayPose(mirror, 1, now)!;
      expect(p.x).toBeGreaterThanOrEqual(prev - 1e-6); // monotonic non-decreasing
      if (prev > -Infinity) maxStep = Math.max(maxStep, p.x - prev);
      prev = p.x;
    }
    // 16 ms at 400 u/s ≈ 6.4 u/step; allow headroom but far below a
    // whole-snapshot (~20 u) jitter snap.
    expect(maxStep).toBeLessThan(12);
  });

  it('HOMING CURVE: angvel-interpolated path tracks the server arc within ~2u (FAILS on linear lerp)', () => {
    // WS-C #5. A heat-seeker STEERS, so its true path between two 20 Hz
    // snapshots is an ARC, not a straight chord. We simulate the server's exact
    // homing integration (m.angle += angvel*DT each 60 Hz tick; vx/vy recomputed
    // from the curved angle) to build a ground-truth path, sample it at the 20 Hz
    // (every 3 ticks) snapshot cadence, feed those snapshots WITH the per-tick
    // signed angvel, and assert the client's resolved display pose lands on the
    // TRUE arc — not the straight chord the old velocity-only lerp produced.
    const SPEED = 400;
    const DT = 1 / 60;
    const TURN = 4.0; // rad/s — a hard, sustained turn (tight homing curve)
    const mirror = makeMirror();

    // Ground-truth integration, identical to MissileSimulation.advance.
    let x = 0, y = 0, angle = 0;
    const truth: Array<{ ms: number; x: number; y: number }> = [];
    // 9-tick (~150 ms) snapshot spacing models a JITTERY mobile link where
    // snapshots arrive sparsely — the chord-vs-arc error grows ~quadratically
    // with the span, so a sparse cadence is where the linear lerp visibly
    // diverges (and where the user reports the "jumps"). The display delay is
    // 100 ms, so a 150 ms bracket keeps the read point comfortably interpolating.
    const SNAP_EVERY = 9;
    let arrivalMs = 1000;
    let tick = 0;
    // 36 ticks = 5 snapshots — fills the ring + gives a comfortable bracketed
    // window to sample.
    for (; tick <= 36; tick++) {
      const nowMs = 1000 + tick * (DT * 1000);
      truth.push({ ms: nowMs, x, y });
      if (tick % SNAP_EVERY === 0) {
        // The angvel shipped is the CONSTANT per-tick turn rate.
        applyMissileSnapshot(
          makeSlice([{ id: 1, x, y, vx: -Math.sin(angle) * SPEED, vy: Math.cos(angle) * SPEED, angle, angvel: TURN }]),
          mirror, tick + 1, arrivalMs,
        );
        arrivalMs = 1000 + (tick + SNAP_EVERY) * (DT * 1000);
      }
      // Advance one server tick: turn, then integrate the curved velocity.
      angle += TURN * DT;
      x += -Math.sin(angle) * SPEED * DT;
      y += Math.cos(angle) * SPEED * DT;
    }

    // Find the true position at a target render time that lands strictly INSIDE
    // a bracketed snapshot window (so we exercise interpolation, not extrapolation).
    function truthAt(ms: number): { x: number; y: number } {
      for (let i = 0; i < truth.length - 1; i++) {
        const a = truth[i]!, b = truth[i + 1]!;
        if (ms >= a.ms && ms <= b.ms) {
          const t = (ms - a.ms) / (b.ms - a.ms);
          return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        }
      }
      const last = truth[truth.length - 1]!;
      return { x: last.x, y: last.y };
    }

    // Sample several render times across the buffered window. resolve reads at
    // now − MISSILE_DISPLAY_DELAY_MS, so pick `now` so the read point sits well
    // inside the snapshot bracket (between the 2nd snapshot at tick 9 and the
    // 4th at tick 27).
    let maxErr = 0;
    let prevX = -Infinity, prevY = -Infinity;
    let maxStep = 0;
    for (let readMs = 1000 + 10 * (DT * 1000); readMs <= 1000 + 26 * (DT * 1000); readMs += 8) {
      const now = readMs + MISSILE_DISPLAY_DELAY_MS;
      const pose = resolveMissileDisplayPose(mirror, 1, now)!;
      const t = truthAt(readMs);
      maxErr = Math.max(maxErr, Math.hypot(pose.x - t.x, pose.y - t.y));
      if (prevX > -Infinity) {
        maxStep = Math.max(maxStep, Math.hypot(pose.x - prevX, pose.y - prevY));
      }
      prevX = pose.x; prevY = pose.y;
    }

    // Curve-aware interpolation lands on the true arc. The old straight-chord
    // lerp (no angvel) bows away from the arc by the chord sagitta — at SPEED
    // 400, TURN 2.5, over a ~50 ms snapshot span the chord error is several units
    // (well past 2u), so this assertion FAILS on the pre-WS-C linear path.
    expect(maxErr).toBeLessThan(2);
    // Frame-to-frame motion stays smooth (no per-arrival snap). 8 ms at 400 u/s
    // ≈ 3.2 u/step; allow headroom but far below a whole-snapshot (~20 u) jump.
    expect(maxStep).toBeLessThan(6);
  });

  it('EXTRAPOLATION past newest applies angvel: angle keeps turning, vx/vy follow the curve', () => {
    // WS-C #5. When arrivals stall the renderer dead-reckons past the newest
    // sample. With angvel it must keep TURNING (angle advances) and recompute
    // vx/vy from the curved angle — not coast straight on a frozen heading.
    const SPEED = 400;
    const mirror = makeMirror();
    // Two samples 50 ms apart; newest at angle 0 moving +y, turning at +1 rad/s.
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0, vx: 0, vy: SPEED, angle: 0, angvel: 1 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 20, vx: 0, vy: SPEED, angle: 0, angvel: 1 }]), mirror, 2, 1050);
    // Read 60 ms past the newest arrival (target = 1110, newest = 1050 →
    // overshoot 60 ms). Angle should have advanced ~ +0.06 rad.
    const pose = resolveMissileDisplayPose(mirror, 1, 1110 + MISSILE_DISPLAY_DELAY_MS)!;
    expect(pose.angle).toBeGreaterThan(0.03); // turned, not frozen at 0
    // The x must have drifted off the straight +y line because the heading
    // curved (a frozen-angle dead-reckon keeps x === 0 exactly).
    expect(Math.abs(pose.x)).toBeGreaterThan(0.5);
  });

  it('ring depth invariant: never retains more than MISSILE_POSE_RING_DEPTH samples', () => {
    const mirror = makeMirror();
    for (let i = 0; i < MISSILE_POSE_RING_DEPTH + 4; i++) {
      applyMissileSnapshot(makeSlice([{ id: 1, x: i * 10, y: 0 }]), mirror, i + 1, 1000 + i * 50);
    }
    const m = mirror.missiles!.get(1)!;
    expect(m.poseRing.length).toBe(MISSILE_POSE_RING_DEPTH);
    expect(m.poseRing.filter((e) => !e.empty).length).toBeLessThanOrEqual(MISSILE_POSE_RING_DEPTH);
  });

  it('stale-eviction removes entries not refreshed for 1 s', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 7, x: 0, y: 0 }]), mirror, 1, 1000);
    expect(mirror.missiles!.has(7)).toBe(true);
    applyMissileSnapshot(undefined, mirror, 2, 1000 + 1500);
    expect(mirror.missiles!.has(7)).toBe(false);
  });

  it('removeMissile deletes immediately', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0 }, { id: 2, x: 50, y: 0 }]), mirror, 1, 1000);
    expect(mirror.missiles!.size).toBe(2);
    removeMissile(mirror, 1);
    expect(mirror.missiles!.has(1)).toBe(false);
    expect(mirror.missiles!.has(2)).toBe(true);
  });

  // ── Campaign 5.1c (review A1 residual b) — SLICE-DRIVEN removal. The
  // `missile_detonated` event is AOI-filtered INDEPENDENTLY of the pose slice,
  // so a viewer could hold a live mirror entry whose removal event was
  // filtered away: the sprite dead-reckoned to the extrapolation cap then
  // FROZE for the remaining ~750 ms of the old 1 s stale window — the exact
  // "missile stops moving, then fades" report. Absence from the slice is now
  // the authoritative removal signal (the event stays as the fast/VFX path):
  // a missile the slice stopped carrying despawns within the extrapolation
  // cap, so the frozen-ghost phase cannot exist. ──
  it('a missile ABSENT from the slice despawns within the extrapolation cap (failed pre-fix: 1 s frozen ghost)', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 7, x: 0, y: 0 }]), mirror, 1, 1000);
    expect(mirror.missiles!.has(7)).toBe(true);
    // 300 ms of slice absence (~6 snapshot cadences) — gone or out of view.
    applyMissileSnapshot(undefined, mirror, 7, 1300);
    expect(mirror.missiles!.has(7)).toBe(false);
  });

  it('a missile survives a couple of dropped/coalesced snapshots (150 ms slice gap)', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 7, x: 0, y: 0 }]), mirror, 1, 1000);
    applyMissileSnapshot(undefined, mirror, 2, 1150);
    expect(mirror.missiles!.has(7)).toBe(true);
  });
});

// ── Campaign 5.1b (review A1 residual a) — a SINGLE-sample missile must MOVE.
// `resolveMissileDisplayPose` pinned to the sole sample while `count === 1`,
// so every missile's first ~display-delay (and every AOI re-entry) rendered
// FROZEN at its first pose, then jumped when interpolation began — drones
// never showed this because their cadence is 3× higher. The pose is now
// reconstructed along the sample's own velocity/homing curve (dt clamped to
// [−display-delay, +extrapolation-cap]), so the missile flies smoothly from
// its very first rendered frame. A zero-velocity sample still resolves to the
// sample point (the legacy seeded-pose case is unchanged). ──
describe('MissileMirror — single-sample reconstruction (campaign 5.1b)', () => {
  it('a single-sample missile MOVES between its first frames (failed pre-fix: pinned frozen)', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0, vx: 0, vy: 400 }]), mirror, 1, 1000);
    // Render targets predate the only sample (display delay 100 ms): the pose
    // reconstructs BACKWARD along the flight line instead of pinning.
    const early = resolveMissileDisplayPose(mirror, 1, 1040)!; // target 940 → dt −60 ms
    const later = resolveMissileDisplayPose(mirror, 1, 1090)!; // target 990 → dt −10 ms
    expect(later.y).toBeGreaterThan(early.y); // it MOVES frame to frame
    expect(early.y).toBeCloseTo(-400 * 0.06, 1);
    expect(later.y).toBeCloseTo(-400 * 0.01, 1);
  });

  it('single-sample reconstruction is clamped on both sides (display delay back, cap forward)', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0, vx: 0, vy: 400 }]), mirror, 1, 1000);
    // Instant render: target 900 → dt clamped to −display-delay (−100 ms).
    const instant = resolveMissileDisplayPose(mirror, 1, 1000)!;
    expect(instant.y).toBeCloseTo(-400 * (MISSILE_DISPLAY_DELAY_MS / 1000), 1);
    // Long after with no further samples: forward reconstruction caps like the
    // past-newest branch (then the slice-absence despawn reaps it anyway).
    const far = resolveMissileDisplayPose(mirror, 1, 1000 + 5000)!;
    expect(far.y).toBeCloseTo(400 * (MISSILE_EXTRAPOLATION_CAP_MS / 1000), 1);
  });

  it('resolveMissileDisplayPose returns null for unknown ids', () => {
    const mirror = makeMirror();
    expect(resolveMissileDisplayPose(mirror, 999, 1000)).toBeNull();
  });
});

/** Ring samples of one missile, oldest tick first. */
function ringByTick(mirror: RenderMirror, id: number): Array<{ serverTick: number; arrivalMs: number }> {
  return mirror.missiles!.get(id)!.poseRing
    .filter((e) => !e.empty)
    .map((e) => ({ serverTick: e.serverTick, arrivalMs: e.arrivalMs }))
    .sort((a, b) => a.serverTick - b.serverTick);
}

describe('MissileMirror — samples stamped on the drone tick timeline (S5-2)', () => {
  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
  });
  afterEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
  });

  it('a backlog drained in one frame keeps its server spacing (failed pre-fix: equal arrival stamps)', () => {
    // Drone packet for tick 100 at 1000 ms seeds the clock; one frame step.
    swarmArrivalStampMs(100, 1000);
    stepSwarmDisplayDelay(0, 1000);
    // A frame stall: missile ticks 103 and 106 are both handled at 1200 ms.
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0 }]), mirror, 103, 1200);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 30, y: 0 }]), mirror, 106, 1200);
    const ring = ringByTick(mirror, 1);
    expect(ring[0]!.arrivalMs).toBeCloseTo(1050, 6);
    expect(ring[1]!.arrivalMs).toBeCloseTo(1100, 6);
    // Despawn still runs on the real arrival time.
    expect(mirror.missiles!.get(1)!.latestArrivalMs).toBe(1200);
    // Midway in server time → midway in position.
    const pose = resolveMissileDisplayPose(mirror, 1, 1075 + MISSILE_DISPLAY_DELAY_MS);
    expect(pose!.x).toBeCloseTo(15, 6);
  });

  it('NaN fallback: no drone packet yet → arrival stamps, playback continuous', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0, vx: 600 }]), mirror, 100, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 30, y: 0, vx: 600 }]), mirror, 103, 1050);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 60, y: 0, vx: 600 }]), mirror, 106, 1100);
    expect(ringByTick(mirror, 1).map((e) => e.arrivalMs)).toEqual([1000, 1050, 1100]);
    // Every frame moves forward by speed × frame time: no snap, no freeze.
    let prevX = resolveMissileDisplayPose(mirror, 1, 1100)!.x;
    for (let now = 1110; now <= 1200; now += 10) {
      const x = resolveMissileDisplayPose(mirror, 1, now)!.x;
      expect(x - prevX).toBeCloseTo(6, 6);
      prevX = x;
    }
  });

  it('when the drone clock seeds mid-flight, the ring is re-stamped onto one basis (never runs backwards)', () => {
    const mirror = makeMirror();
    // Arrival-stamped while unseeded.
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0 }]), mirror, 100, 1000);
    // A drone packet puts tick 110 at 1010 ms: tick 103 maps to ~893 ms,
    // before the tick-100 arrival stamp.
    swarmArrivalStampMs(110, 1010);
    stepSwarmDisplayDelay(0, 1010);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 30, y: 0 }]), mirror, 103, 1020);
    const ring = ringByTick(mirror, 1);
    // Tick spacing, give or take the read-only drift-up term (1 % of lateness).
    expect(Math.abs(ring[1]!.arrivalMs - ring[0]!.arrivalMs - 50)).toBeLessThan(1);
    expect(ring[1]!.arrivalMs).toBeLessThanOrEqual(1020);
  });
});

describe('MissileMirror — teleport span is game ms', () => {
  // Two samples 100 wall ms apart. At game speed s that is 100·s game ms, so
  // the bound is max(64, 2500 u/s × 0.1 s × s): 500 u at 2×, 175 u at 0.7×.
  function resolveAtSpeed(timeScale: number, gapU: number): number {
    const mirror = makeMirror();
    mirror.timeScale = timeScale;
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: gapU, y: 0 }]), mirror, 2, 1100);
    return resolveMissileDisplayPose(mirror, 1, 1050 + MISSILE_DISPLAY_DELAY_MS / timeScale)!.x;
  }

  it('2×: a 400 u step in 100 wall ms is real motion (interpolates; failed pre-fix: snapped)', () => {
    expect(resolveAtSpeed(2, 400)).toBeCloseTo(200, 6);
    expect(resolveAtSpeed(2, 501)).toBe(501);
  });

  it('0.7×: a 200 u step in 100 wall ms is a teleport (snaps; failed pre-fix: interpolated)', () => {
    expect(resolveAtSpeed(0.7, 200)).toBe(200);
    expect(resolveAtSpeed(0.7, 170)).toBeCloseTo(85, 6);
  });
});

describe('MissileMirror — reads the shared drone display delay (S5-4)', () => {
  const SEED_TICK = 100;
  const SEED_MS = 1000;
  /** Game-time speed of the scripted missile: 10 u per server tick at any speed. */
  const U_PER_TICK = 10;
  const TICK_GAME_MS = 1000 / 60;

  beforeEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
  });
  afterEach(() => {
    resetSwarmTickClock();
    setSwarmDisplaySpeed(1);
  });

  /** Seed the drone tick clock (tick 100 at 1000 ms) with the delay pinned to
   *  `delayWallMs`, then feed a straight-flying missile every third tick up to
   *  `nowMs`, each handled on time (never a sample from the future). Returns the mirror. */
  function flyMissile(speed: number, delayWallMs: number, nowMs: number): RenderMirror {
    setSwarmDisplaySpeed(speed);
    setSwarmDisplayDelayMs(delayWallMs);
    // As the decoder does for a tick-stamped drone packet.
    noteSwarmStreamStamp(SEED_TICK, swarmArrivalStampMs(SEED_TICK, SEED_MS));
    stepSwarmDisplayDelay(0, SEED_MS);
    const mirror = makeMirror();
    mirror.timeScale = speed === 1 ? undefined : speed;
    const tickWallMs = TICK_GAME_MS / speed;
    const vx = (U_PER_TICK / TICK_GAME_MS) * 1000;
    for (let tick = SEED_TICK; SEED_MS + (tick - SEED_TICK) * tickWallMs <= nowMs; tick += 3) {
      const atMs = SEED_MS + (tick - SEED_TICK) * tickWallMs;
      applyMissileSnapshot(makeSlice([{ id: 1, x: (tick - SEED_TICK) * U_PER_TICK, y: 0, vx }]), mirror, tick, atMs);
    }
    publishSwarmDisplayDelay(mirror);
    return mirror;
  }

  /** Where the missile truly was at wall time `tMs` (stamp timeline). */
  function trueX(speed: number, tMs: number): number {
    return ((tMs - SEED_MS) * speed / TICK_GAME_MS) * U_PER_TICK;
  }

  it('reads at now − the shared delay, and follows it when it changes (failed pre-fix: fixed 100 ms)', () => {
    const mirror = flyMissile(1, 200, SEED_MS + 450);
    expect(mirror.swarmDisplayDelayMs).toBe(200);
    const now = SEED_MS + 450;
    expect(resolveMissileDisplayPose(mirror, 1, now)!.x).toBeCloseTo(trueX(1, now - 200), 6);

    // The drone delay glides to 150; the next publish carries it.
    setSwarmDisplayDelayMs(150);
    for (let i = 0; i < 60 && getSwarmDisplayDelayMs() !== 150; i++) stepSwarmDisplayDelay(1000);
    expect(getSwarmDisplayDelayMs()).toBe(150);
    publishSwarmDisplayDelay(mirror);
    expect(mirror.swarmDisplayDelayMs).toBe(150);
    expect(resolveMissileDisplayPose(mirror, 1, now)!.x).toBeCloseTo(trueX(1, now - 150), 6);
  });

  it('before the drone clock seeds: publishes NaN and the missile keeps its fixed delay', () => {
    const mirror = makeMirror();
    publishSwarmDisplayDelay(mirror);
    expect(Number.isNaN(mirror.swarmDisplayDelayMs)).toBe(true);
    // No drone packet: samples keep arrival stamps (S5-2 fallback).
    for (let i = 0; i <= 10; i++) {
      applyMissileSnapshot(makeSlice([{ id: 1, x: i * 30, y: 0, vx: 600 }]), mirror, 100 + i * 3, 1000 + i * 50);
    }
    const now = 1400;
    expect(resolveMissileDisplayPose(mirror, 1, now)!.x).toBeCloseTo((now - MISSILE_DISPLAY_DELAY_MS - 1000) * 0.6, 6);
    // Same with the field absent (a mirror nothing published to), at 2×.
    mirror.swarmDisplayDelayMs = undefined;
    mirror.timeScale = 2;
    expect(resolveMissileDisplayPose(mirror, 1, now)!.x).toBeCloseTo((now - MISSILE_DISPLAY_DELAY_MS / 2 - 1000) * 0.6, 6);
  });

  it('2×: the shared delay is already wall ms (not divided again by the speed)', () => {
    const mirror = flyMissile(2, 80, SEED_MS + 200); // floor 50, ceiling 140 wall ms at 2×
    expect(mirror.swarmDisplayDelayMs).toBe(80);
    const now = SEED_MS + 200;
    expect(resolveMissileDisplayPose(mirror, 1, now)!.x).toBeCloseTo(trueX(2, now - 80), 6);
  });

  it('0.7×: the shared delay is already wall ms (not divided again by the speed)', () => {
    const mirror = flyMissile(0.7, 250, SEED_MS + 650); // floor ~142.9, ceiling 400 wall ms at 0.7×
    expect(mirror.swarmDisplayDelayMs).toBe(250);
    const now = SEED_MS + 650;
    expect(resolveMissileDisplayPose(mirror, 1, now)!.x).toBeCloseTo(trueX(0.7, now - 250), 6);
  });
});
