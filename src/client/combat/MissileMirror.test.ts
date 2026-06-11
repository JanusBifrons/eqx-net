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
  id: number; x: number; y: number; vx?: number; vy?: number; angle?: number; lifePct?: number;
}>): NonNullable<SnapshotMessage['missiles']> {
  return entries.map((e) => ({
    id: e.id,
    x: e.x, y: e.y,
    vx: e.vx ?? 0, vy: e.vy ?? 0,
    angle: e.angle ?? 0,
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
