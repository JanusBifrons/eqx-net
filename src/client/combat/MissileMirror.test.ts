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
 */

import { describe, it, expect } from 'vitest';
import {
  applyMissileSnapshot,
  removeMissile,
  resolveMissileDisplayPose,
  MISSILE_DISPLAY_DELAY_MS,
  MISSILE_EXTRAPOLATION_CAP_MS,
} from './MissileMirror';
import { MISSILE_POSE_RING_DEPTH, type RenderMirror } from '../../core/contracts/IRenderer';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages';

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

  it('resolveMissileDisplayPose returns null for unknown ids', () => {
    const mirror = makeMirror();
    expect(resolveMissileDisplayPose(mirror, 999, 1000)).toBeNull();
  });
});
