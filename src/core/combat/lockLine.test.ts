import { describe, it, expect } from 'vitest';
import { lockLineScore, lockLineHolds, LOCK_LINE } from './lockLine.js';

/** The shared lock-line rule (client pick + server `lock_track` check, #15). */
describe('lockLine', () => {
  // Line straight ahead (+y): dir = (-sin 0, cos 0) = (0, 1).
  const score = (dx: number, dy: number, held = false, radius = 20, reach = 600): number =>
    lockLineScore(dx, dy, 0, 1, radius, reach, held);

  it('holds a target on the line, ahead and within reach', () => {
    expect(Number.isFinite(score(0, 300))).toBe(true);
    expect(Number.isFinite(score(60, 300))).toBe(true); // inside the 70 + 0.12·300 cone
  });

  it('rejects targets behind, past reach × slack, or outside the cone', () => {
    expect(score(0, -10)).toBe(Infinity);
    expect(score(0, 600 * LOCK_LINE.reachSlack + 1)).toBe(Infinity);
    expect(score(200, 300)).toBe(Infinity);
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
    expect(lockLineHolds(0, 300, 0, 20, 600)).toBe(true);
    expect(lockLineHolds(300, 0, -Math.PI / 2, 20, 600)).toBe(true); // bearing −π/2 points +x
    expect(lockLineHolds(300, 0, Math.PI / 2, 20, 600)).toBe(false);
    expect(lockLineHolds(120, 300, 0, 20, 600)).toBe(true); // sticky cone
  });
});
