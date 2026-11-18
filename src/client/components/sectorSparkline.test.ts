import { describe, expect, it } from 'vitest';
import { sparklinePath } from './sectorSparkline';

const s = (holder: string | null, holderShare: number, atMs = 0) => ({ atMs, holder, holderShare });

describe('sparklinePath', () => {
  it('is empty with no samples', () => {
    expect(sparklinePath([], 100, 20)).toEqual({ path: '', flips: [], holder: null });
  });

  it('runs oldest left to newest right, share up', () => {
    const g = sparklinePath([s('a', 0), s('a', 50), s('a', 100)], 100, 20);
    expect(g.path).toBe('M0,20 L50,10 L100,0');
    expect(g.holder).toBe('a');
    expect(g.flips).toEqual([]);
  });

  it('marks every change of holder', () => {
    const g = sparklinePath([s('a', 80), s('b', 60), s('b', 70), s(null, 0)], 90, 10);
    expect(g.flips).toEqual([30, 90]);
    expect(g.holder).toBeNull();
  });

  it('draws nobody-holds as zero and clamps the share', () => {
    const g = sparklinePath([s(null, 40), s('a', 140)], 10, 10);
    expect(g.path).toBe('M0,10 L10,0');
  });

  it('draws a lone sample as a short dash', () => {
    expect(sparklinePath([s('a', 50)], 100, 20).path).toBe('M50,10 L51,10');
  });
});
