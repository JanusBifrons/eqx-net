import { describe, it, expect } from 'vitest';
import { armOrder, evenReps } from './order';

describe('perf rep order', () => {
  it('rounds odd rep counts up to even', () => {
    expect(evenReps(3)).toBe(4);
    expect(evenReps(4)).toBe(4);
    expect(evenReps(7)).toBe(8);
    expect(evenReps(1)).toBe(2);
  });

  it('two arms alternate', () => {
    expect(armOrder(['b', 'h'], 0)).toEqual(['b', 'h']);
    expect(armOrder(['b', 'h'], 1)).toEqual(['h', 'b']);
  });

  it('with the A/A arm, head runs before base in exactly half of any even rep count', () => {
    for (const reps of [2, 4, 6, 8, 10]) {
      let baseFirst = 0;
      for (let i = 0; i < reps; i++) {
        const o = armOrder(['b', 'h', 'a'], i);
        expect([...o].sort()).toEqual(['a', 'b', 'h']);
        if (o.indexOf('b') < o.indexOf('h')) baseFirst++;
      }
      expect(baseFirst).toBe(reps / 2);
    }
  });
});
