import { describe, expect, it } from 'vitest';
import { clampStickOrigin, isTap, leashOrigin, stickVector } from './floatingStickMath';
import { formatCredits, scrambleChangedDigits } from './RollingCounter';
import { hudSizeFor } from './useHudScale';

describe('floating stick maths', () => {
  it('spawns under the finger, pulled in so the ring stays on screen', () => {
    const o = { x: 0, y: 0 };
    clampStickOrigin(200, 200, 50, 844, 390, o);
    expect(o).toEqual({ x: 200, y: 200 });
    clampStickOrigin(3, 388, 50, 844, 390, o);
    expect(o).toEqual({ x: 56, y: 390 - 56 });
  });

  it('vector is normalised, clamped to the ring, y DOWN', () => {
    const v = { x: 0, y: 0, mag: 0 };
    stickVector(100, 100, 125, 100, 50, v);
    expect(v.x).toBeCloseTo(0.5);
    expect(v.y).toBeCloseTo(0);
    expect(v.mag).toBeCloseTo(0.5);
    stickVector(100, 100, 100, 400, 50, v); // far below → clamped
    expect(v.y).toBeCloseTo(1);
    expect(v.mag).toBe(1);
    stickVector(100, 100, 100, 100, 50, v);
    expect(v.mag).toBe(0);
  });

  it('leash drags the origin behind a finger that overruns the ring', () => {
    const o = { x: 100, y: 100 };
    expect(leashOrigin(o, 130, 100, 50)).toBe(false);
    expect(leashOrigin(o, 200, 100, 50)).toBe(true);
    expect(o.x).toBeCloseTo(150);
    expect(Math.hypot(200 - o.x, 100 - o.y)).toBeCloseTo(50);
  });

  it('tap = short and still', () => {
    expect(isTap(120, 3)).toBe(true);
    expect(isTap(400, 3)).toBe(false);
    expect(isTap(120, 30)).toBe(false);
  });
});

describe('credits counter', () => {
  it('formats with grouping, floors, never negative', () => {
    expect(formatCredits(12345.9)).toBe('12,345');
    expect(formatCredits(-5)).toBe('0');
  });

  it('scrambles only the digits that differ from the target', () => {
    const out = scrambleChangedDigits('12,345', '12,999', () => 0.75); // rand digit = 7
    expect(out).toBe('12,777');
    // unchanged digits and separators kept
    expect(scrambleChangedDigits('1,000', '1,000', () => 0.1)).toBe('1,000');
  });
});

describe('size class', () => {
  it('sizes by the SHORT side + pointer, so a landscape phone stays "phone"', () => {
    expect(hudSizeFor(844, 390, true)).toBe('phone');
    expect(hudSizeFor(390, 844, true)).toBe('phone');
    expect(hudSizeFor(1024, 768, true)).toBe('tablet');
    expect(hudSizeFor(1280, 720, false)).toBe('desk');
  });
});
