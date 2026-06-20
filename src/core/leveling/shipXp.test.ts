import { describe, it, expect } from 'vitest';
import {
  LEVEL_CAP,
  XP_PER_KILL_DIVISOR,
  XP_CURVE_BASE,
  xpForKill,
  xpToNext,
  applyKillXp,
} from './shipXp.js';

describe('shipXp — per-instance XP curve (Phase 4 WS-B1)', () => {
  describe('xpForKill — victim toughness weighting', () => {
    it('scales with victim maxHealth (tougher = more XP)', () => {
      const scoutXp = xpForKill(300);
      const capitalXp = xpForKill(3000);
      expect(capitalXp).toBeGreaterThan(scoutXp);
      // Linear in maxHealth: chosen on exact divisor multiples so rounding
      // doesn't blur the 10× relationship.
      const a = xpForKill(XP_PER_KILL_DIVISOR * 5); // 5
      const b = xpForKill(XP_PER_KILL_DIVISOR * 50); // 50
      expect(b).toBe(a * 10);
    });

    it('is exactly maxHealth / XP_PER_KILL_DIVISOR, rounded, floored at 1', () => {
      expect(xpForKill(XP_PER_KILL_DIVISOR)).toBe(1);
      expect(xpForKill(XP_PER_KILL_DIVISOR * 5)).toBe(5);
      // A trivially weak victim still yields at least 1 XP.
      expect(xpForKill(1)).toBe(1);
      expect(xpForKill(0)).toBe(1);
    });

    it('never returns a negative or fractional value', () => {
      const v = xpForKill(777);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
    });
  });

  describe('xpToNext — escalating curve', () => {
    it('costs more at each higher level', () => {
      for (let l = 1; l < LEVEL_CAP - 1; l++) {
        expect(xpToNext(l + 1)).toBeGreaterThan(xpToNext(l));
      }
    });

    it('returns base for level 1', () => {
      expect(xpToNext(1)).toBe(XP_CURVE_BASE);
    });

    it('returns Infinity at and beyond the cap (no further levelling)', () => {
      expect(xpToNext(LEVEL_CAP)).toBe(Infinity);
      expect(xpToNext(LEVEL_CAP + 3)).toBe(Infinity);
    });
  });

  describe('applyKillXp — accumulate + threshold + cap', () => {
    it('accumulates XP below threshold without levelling', () => {
      const cost = xpToNext(1);
      const r = applyKillXp(1, 0, cost - 1);
      expect(r.level).toBe(1);
      expect(r.xp).toBe(cost - 1);
      expect(r.levelsGained).toBe(0);
    });

    it('levels up exactly once when crossing one threshold, carrying the remainder', () => {
      const cost = xpToNext(1);
      const r = applyKillXp(1, 0, cost + 3);
      expect(r.level).toBe(2);
      expect(r.levelsGained).toBe(1);
      expect(r.xp).toBe(3); // remainder carried into level 2
    });

    it('does not double-count a single kill (one level per threshold)', () => {
      // Exactly the threshold → level once, remainder 0.
      const cost = xpToNext(1);
      const r = applyKillXp(1, 0, cost);
      expect(r.level).toBe(2);
      expect(r.levelsGained).toBe(1);
      expect(r.xp).toBe(0);
    });

    it('can gain multiple levels from one large award', () => {
      const cost1 = xpToNext(1);
      const cost2 = xpToNext(2);
      const r = applyKillXp(1, 0, cost1 + cost2 + 5);
      expect(r.level).toBe(3);
      expect(r.levelsGained).toBe(2);
      expect(r.xp).toBe(5);
    });

    it('caps at LEVEL_CAP and stops accumulating XP past it', () => {
      // Huge award from level 1.
      const r = applyKillXp(1, 0, 10_000_000);
      expect(r.level).toBe(LEVEL_CAP);
      expect(r.levelsGained).toBe(LEVEL_CAP - 1);
      // At cap, xp is pinned to 0 (no further progress bar).
      expect(r.xp).toBe(0);
    });

    it('is a no-op at the cap', () => {
      const r = applyKillXp(LEVEL_CAP, 0, 5000);
      expect(r.level).toBe(LEVEL_CAP);
      expect(r.levelsGained).toBe(0);
      expect(r.xp).toBe(0);
    });

    it('treats a non-positive award as a no-op', () => {
      const r = applyKillXp(2, 7, 0);
      expect(r.level).toBe(2);
      expect(r.xp).toBe(7);
      expect(r.levelsGained).toBe(0);
    });
  });
});
