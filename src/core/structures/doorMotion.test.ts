import { describe, it, expect } from 'vitest';
import { DOOR_POS_MAX, DOOR_POWER_LEVELS, DOOR_TRAVEL_TICKS } from './gateGeometry.js';
import { doorArrived, doorClipTime, doorLevelFromSupply, doorPosAt, type DoorSegment } from './doorMotion.js';

const seg = (p0: number, dir: 1 | -1, level: number, t0 = 1000): DoorSegment => ({ p0, t0, dir, level });

describe('doorMotion — pure solid-door clock', () => {
  it('constants: 3 s travel at 60 Hz, 15 levels', () => {
    expect(DOOR_TRAVEL_TICKS).toBe(180);
    expect(DOOR_POWER_LEVELS).toBe(15);
    expect(DOOR_POS_MAX).toBe(2700);
  });

  it('full power opens shut-to-open in exactly 3 s (180 ticks)', () => {
    const s = seg(0, 1, 15);
    expect(doorPosAt(s, 1000 + 179)).toBe(DOOR_POS_MAX - 15);
    expect(doorArrived(s, 1000 + 179)).toBe(false);
    expect(doorPosAt(s, 1000 + 180)).toBe(DOOR_POS_MAX);
    expect(doorArrived(s, 1000 + 180)).toBe(true);
    const c = seg(DOOR_POS_MAX, -1, 15);
    expect(doorArrived(c, 1000 + 179)).toBe(false);
    expect(doorPosAt(c, 1000 + 180)).toBe(0);
    expect(doorArrived(c, 1000 + 180)).toBe(true);
  });

  it('every power level moves `level` units per tick, integer exact', () => {
    for (let level = 0; level <= 15; level++) {
      const s = seg(1350, 1, level);
      for (const dt of [0, 1, 7, 33, 89]) {
        const p = doorPosAt(s, 1000 + dt);
        expect(Number.isInteger(p)).toBe(true);
        expect(p).toBe(Math.min(DOOR_POS_MAX, 1350 + level * dt));
      }
      if (level > 0) {
        // Full travel takes 180 * 15 / level ticks, rounded up.
        const ticks = Math.ceil(DOOR_POS_MAX / level);
        const open = seg(0, 1, level);
        expect(doorArrived(open, 1000 + ticks - 1)).toBe(false);
        expect(doorArrived(open, 1000 + ticks)).toBe(true);
      }
    }
  });

  it('level 0 freezes the door wherever it is (shut, mid, open)', () => {
    for (const p0 of [0, 1234, DOOR_POS_MAX]) {
      for (const dir of [1, -1] as const) {
        const s = seg(p0, dir, 0);
        expect(doorPosAt(s, 1000 + 100000)).toBe(p0);
      }
    }
    expect(doorArrived(seg(0, -1, 0), 5000)).toBe(true);
    expect(doorArrived(seg(1234, 1, 0), 5000)).toBe(false);
    expect(doorArrived(seg(DOOR_POS_MAX, 1, 0), 5000)).toBe(true);
  });

  it('clamps at both ends and reads p0 before t0', () => {
    expect(doorPosAt(seg(2600, 1, 15), 1000 + 1000)).toBe(DOOR_POS_MAX);
    expect(doorPosAt(seg(100, -1, 15), 1000 + 1000)).toBe(0);
    expect(doorPosAt(seg(500, 1, 15), 900)).toBe(500);
  });

  it('doorLevelFromSupply rounds the clamped fraction to 0..15', () => {
    expect(doorLevelFromSupply(1)).toBe(15);
    expect(doorLevelFromSupply(2)).toBe(15);
    expect(doorLevelFromSupply(0)).toBe(0);
    expect(doorLevelFromSupply(-0.5)).toBe(0);
    expect(doorLevelFromSupply(Number.NaN)).toBe(0);
    expect(doorLevelFromSupply(0.5)).toBe(8); // 7.5 rounds up
    expect(doorLevelFromSupply(0.03)).toBe(0);
    expect(doorLevelFromSupply(0.04)).toBe(1);
  });

  it('doorClipTime maps position to clip ticks; scrub reproduces doorPosAt', () => {
    expect(doorClipTime(0)).toBe(0);
    expect(doorClipTime(DOOR_POS_MAX)).toBe(DOOR_TRAVEL_TICKS);
    const s = seg(900, -1, 6);
    const from = doorClipTime(s.p0);
    const rate = (s.dir * s.level) / DOOR_POWER_LEVELS;
    for (const dt of [0, 10, 50, 149, 150]) {
      const clipT = Math.max(0, Math.min(DOOR_TRAVEL_TICKS, from + rate * dt));
      expect(clipT).toBeCloseTo(doorClipTime(doorPosAt(s, s.t0 + dt)), 9);
    }
  });
});
