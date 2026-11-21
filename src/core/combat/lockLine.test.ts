import { describe, it, expect } from 'vitest';
import { lockLineScore, lockLineHolds } from './lockLine.js';

/** The shared lock-line rule (client pick + server `lock_track` check, #15). */
describe('lockLine', () => {
  // Line straight ahead (+y): dir = (-sin 0, cos 0) = (0, 1).
  const score = (dx: number, dy: number, held = false, radius = 20, reach = 600): number =>
    lockLineScore(dx, dy, 0, 1, radius, reach, held, 0);

  it('holds a target on the line, ahead and within reach', () => {
    expect(Number.isFinite(score(0, 300))).toBe(true);
    expect(Number.isFinite(score(60, 300))).toBe(true); // inside the 70 + 0.12·300 cone
  });

  it('rejects targets behind or outside the cone', () => {
    expect(score(0, -10)).toBe(Infinity);
    expect(score(200, 300)).toBe(Infinity);
  });

  // Owner 2026-11-21: a ship can only be locked from about 1 km for now
  // (`LOCK_TUNING.maxLockRange`), so the line ends there, whatever the reach.
  it('holds a target on the line out to lock range (1 km), not past it', () => {
    expect(Number.isFinite(score(0, 600 * 1.1 + 1))).toBe(true);
    expect(Number.isFinite(score(0, 900))).toBe(true);
    expect(score(0, 1200)).toBe(Infinity);
    expect(lockLineHolds(0, 900, 0, 20, 600, 0)).toBe(true);
    expect(lockLineHolds(0, 1200, 0, 20, 38_700, 0)).toBe(false);
    // Hull to hull: a battleship (radius ~2,876) 0.9 km off a fighter's hull
    // is on the line; 1.3 km off it is not.
    expect(lockLineHolds(0, 24 + 900 + 2876, 0, 2876, 600, 24)).toBe(true);
    expect(lockLineHolds(0, 24 + 1300 + 2876, 0, 2876, 600, 24)).toBe(false);
    // Still nearer first among equally centred targets.
    expect(score(0, 300)).toBeLessThan(score(0, 900));
  });

  it('the held target keeps a wider (sticky) cone and always wins', () => {
    const dx = 120; // outside the plain cone at 300 (70 + 36 = 106), inside ×1.6
    expect(score(dx, 300)).toBe(Infinity);
    expect(score(dx, 300, true)).toBe(-1);
  });

  it('nearer, better-centred targets score lower', () => {
    expect(score(0, 100)).toBeLessThan(score(0, 500));
    expect(score(10, 300)).toBeLessThan(score(50, 300));
  });

  it('lockLineHolds uses the world bearing (ship-angle convention) and the sticky cone', () => {
    expect(lockLineHolds(0, 300, 0, 20, 600, 0)).toBe(true);
    expect(lockLineHolds(300, 0, -Math.PI / 2, 20, 600, 0)).toBe(true); // bearing −π/2 points +x
    expect(lockLineHolds(300, 0, Math.PI / 2, 20, 600, 0)).toBe(false);
    expect(lockLineHolds(120, 300, 0, 20, 600, 0)).toBe(true); // sticky cone
  });
});
