import { describe, it, expect } from 'vitest';
import {
  wallGeometry,
  resolveWallHit,
  isWallActive,
  wallPairKey,
  rayCrossesSegment,
  SHIELD_WALL_STUN_MS,
} from './ShieldWall.js';

describe('ShieldWall — pure span geometry + grid-power model', () => {
  describe('wallGeometry', () => {
    it('mid-points and measures a horizontal span', () => {
      const g = wallGeometry(-100, 40, 100, 40);
      expect(g.midX).toBe(0);
      expect(g.midY).toBe(40);
      expect(g.length).toBe(200);
      expect(g.angle).toBe(0);
    });
    it('measures a diagonal span (length + heading)', () => {
      const g = wallGeometry(0, 0, 30, 40);
      expect(g.length).toBe(50); // 3-4-5
      expect(g.angle).toBeCloseTo(Math.atan2(40, 30), 6);
      expect(g.midX).toBe(15);
      expect(g.midY).toBe(20);
    });
  });

  describe('resolveWallHit', () => {
    it('the grid surplus alone absorbs a small hit (no drain, no stun)', () => {
      expect(resolveWallHit(10, 50, 0)).toEqual({ batteryDrain: 0, stun: false });
    });
    it('the excess over surplus drains batteries, no stun while they cover it', () => {
      // damage 80, surplus 50 → 30 over surplus, batteries have 100 → drain 30.
      expect(resolveWallHit(80, 50, 100)).toEqual({ batteryDrain: 30, stun: false });
    });
    it('overwhelming surplus + batteries drains them dry and stuns', () => {
      // damage 80, surplus 50 → 30 over, batteries only 20 → drain 20 + stun.
      expect(resolveWallHit(80, 50, 20)).toEqual({ batteryDrain: 20, stun: true });
    });
    it('a deficit grid (netPower < 0) gives zero free buffer', () => {
      // No surplus → the whole hit must come from batteries; 10 > 0 charge → stun.
      expect(resolveWallHit(10, -5, 0)).toEqual({ batteryDrain: 0, stun: true });
      expect(resolveWallHit(10, -5, 10)).toEqual({ batteryDrain: 10, stun: false });
    });
    it('a zero/negative hit is a no-op', () => {
      expect(resolveWallHit(0, 50, 100)).toEqual({ batteryDrain: 0, stun: false });
    });
  });

  describe('isWallActive', () => {
    it('blocks only while powered AND past the stun window', () => {
      expect(isWallActive(true, 0, 1000)).toBe(true); // powered, not stunned
      expect(isWallActive(false, 0, 1000)).toBe(false); // unpowered
      expect(isWallActive(true, 5000, 1000)).toBe(false); // still stunned
      expect(isWallActive(true, 5000, 5000)).toBe(true); // stun just expired
    });
    it('uses SHIELD_WALL_STUN_MS as the documented window', () => {
      const hitAt = 1000;
      const until = hitAt + SHIELD_WALL_STUN_MS;
      expect(isWallActive(true, until, hitAt + 4999)).toBe(false);
      expect(isWallActive(true, until, hitAt + 5000)).toBe(true);
    });
  });

  it('wallPairKey is order-independent', () => {
    expect(wallPairKey('a', 'b')).toBe(wallPairKey('b', 'a'));
    expect(wallPairKey('struct-9', 'struct-2')).toBe('struct-2|struct-9');
  });

  describe('rayCrossesSegment (beam-vs-wall absorption)', () => {
    // Wall span A(-50,100)→B(50,100). Ray from origin straight up (+y unit).
    it('returns the distance where a ray crosses the wall span', () => {
      expect(rayCrossesSegment(0, 0, 0, 1, -50, 100, 50, 100)).toBe(100);
    });
    it('misses when the crossing is off the segment ends', () => {
      // Ray up at x=200 — passes the wall's infinite line but off the segment.
      expect(rayCrossesSegment(200, 0, 0, 1, -50, 100, 50, 100)).toBeNull();
    });
    it('misses when the wall is behind the ray origin (t < 0)', () => {
      expect(rayCrossesSegment(0, 200, 0, 1, -50, 100, 50, 100)).toBeNull();
    });
    it('returns null for a ray parallel to the wall', () => {
      expect(rayCrossesSegment(0, 0, 1, 0, -50, 100, 50, 100)).toBeNull();
    });
  });
});
