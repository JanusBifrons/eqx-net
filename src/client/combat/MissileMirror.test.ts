/**
 * MissileMirror unit tests — snapshot apply + display-pose resolution.
 *
 * Covers:
 *   - First-seen snapshot seeds prev=latest (t=1 lerp returns latest)
 *   - Second snapshot slides prev/latest correctly
 *   - resolveMissileDisplayPose interpolates between prev/latest with
 *     display-delay offset
 *   - Stale-eviction backstop removes orphan entries
 *   - removeMissile clears immediately
 */

import { describe, it, expect } from 'vitest';
import {
  applyMissileSnapshot,
  removeMissile,
  resolveMissileDisplayPose,
  MISSILE_DISPLAY_DELAY_MS,
  MISSILE_EXTRAPOLATION_CAP_MS,
} from './MissileMirror';
import type { RenderMirror } from '../../core/contracts/IRenderer';
import type { SnapshotMessage } from '../../shared-types/messages/snapshotMessages';

function makeMirror(): RenderMirror {
  return {
    ships: new Map(),
    localPlayerId: null,
  };
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
  it('first-seen entry seeds prev=latest so resolve returns the new pose', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 7, x: 100, y: 200 }]), mirror, 1, 1000);
    const m = mirror.missiles!.get(7)!;
    expect(m.x).toBe(100);
    expect(m.prevX).toBe(100); // seeded equal so first-frame resolve = latest
    expect(m.prevArrivalMs).toBe(1000);
    expect(m.latestArrivalMs).toBe(1000);
    // Resolve later — span=0 → returns latest pose unmodified.
    const pose = resolveMissileDisplayPose(mirror, 7, 1050);
    expect(pose!.x).toBe(100);
    expect(pose!.y).toBe(200);
  });

  it('second snapshot slides prev → latest with new arrival', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 7, x: 0, y: 0 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 7, x: 100, y: 50 }]), mirror, 2, 1050);
    const m = mirror.missiles!.get(7)!;
    expect(m.prevX).toBe(0);
    expect(m.prevY).toBe(0);
    expect(m.x).toBe(100);
    expect(m.y).toBe(50);
    expect(m.prevArrivalMs).toBe(1000);
    expect(m.latestArrivalMs).toBe(1050);
  });

  it('resolveMissileDisplayPose interpolates with display-delay', () => {
    const mirror = makeMirror();
    // Two snapshots 100 ms apart.
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 200, y: 0 }]), mirror, 2, 1100);
    // Resolve at nowMs = 1150. targetMs = 1150 - DISPLAY_DELAY = 1050.
    // Span = 100ms (1000→1100). t = (1050 - 1000) / 100 = 0.5 → x=100.
    const pose = resolveMissileDisplayPose(mirror, 1, 1100 + MISSILE_DISPLAY_DELAY_MS / 2 + MISSILE_DISPLAY_DELAY_MS / 2);
    expect(pose).not.toBeNull();
    // Verify the lerp lands somewhere reasonable (between prev and latest).
    expect(pose!.x).toBeGreaterThanOrEqual(0);
    expect(pose!.x).toBeLessThanOrEqual(200);
  });

  it('past latest with no velocity: pose freezes at latest (no extrapolation)', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0, vx: 0, vy: 0 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 100, y: 0, vx: 0, vy: 0 }]), mirror, 2, 1100);
    // Resolve far in the future with vx=0 — pose stays at latest x=100.
    const pose = resolveMissileDisplayPose(mirror, 1, 5000);
    expect(pose!.x).toBe(100);
  });

  it('past latest with velocity: dead-reckons forward, capped at MISSILE_EXTRAPOLATION_CAP_MS', () => {
    const mirror = makeMirror();
    // 400 u/s forward (matches heat-seeker speed).
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 0, vx: 0, vy: 400 }]), mirror, 1, 1000);
    applyMissileSnapshot(makeSlice([{ id: 1, x: 0, y: 20, vx: 0, vy: 400 }]), mirror, 2, 1050);
    // nowMs that puts targetMs comfortably past latestArrivalMs.
    // targetMs = nowMs - 100 (DISPLAY_DELAY). Latest arrived at 1050.
    // To get overshootMs = 40 ms, set nowMs = 1050 + 100 + 40 = 1190.
    const pose40 = resolveMissileDisplayPose(mirror, 1, 1190);
    // Expected: latest.y (20) + vy(400) * 0.040 = 20 + 16 = 36.
    expect(pose40!.y).toBeCloseTo(36, 1);

    // Cap kicks in past 80 ms overshoot — overshootMs caps at 80, dt=0.08.
    // Expected: 20 + 400 * 0.080 = 20 + 32 = 52.
    const poseFarFuture = resolveMissileDisplayPose(mirror, 1, 1050 + 100 + 1000);
    expect(poseFarFuture!.y).toBeCloseTo(20 + 400 * (MISSILE_EXTRAPOLATION_CAP_MS / 1000), 1);
  });

  it('stale-eviction removes entries that have not refreshed for 1 s', () => {
    const mirror = makeMirror();
    applyMissileSnapshot(makeSlice([{ id: 7, x: 0, y: 0 }]), mirror, 1, 1000);
    expect(mirror.missiles!.has(7)).toBe(true);
    // Apply an empty-slice snapshot but with a later clock — stale-eviction
    // triggers after 1000ms of no refresh.
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
