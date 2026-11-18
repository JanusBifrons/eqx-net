import { describe, expect, it } from 'vitest';
import { agoLabel, controlTrend, sparklinePath, trendLine, trendShort } from './sectorSparkline';

const s = (holder: string | null, holderShare: number, atMs = 0) => ({ atMs, holder, holderShare });
/** One sample a minute, oldest first. */
const minutes = (...rows: Array<[string | null, number]>) => rows.map(([h, v], i) => s(h, v, i * 60_000));

describe('sparklinePath', () => {
  it('is empty with no samples', () => {
    expect(sparklinePath([], 100, 20)).toEqual({ path: '', flips: [], holder: null, last: null });
  });

  it('runs oldest left to newest right, share up; `last` is the newest point', () => {
    const g = sparklinePath([s('a', 0), s('a', 50), s('a', 100)], 100, 20);
    expect(g.path).toBe('M0,20 L50,10 L100,0');
    expect(g.holder).toBe('a');
    expect(g.flips).toEqual([]);
    expect(g.last).toEqual({ x: 100, y: 0 });
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

describe('controlTrend', () => {
  it('is null under two samples (nothing to compare yet)', () => {
    expect(controlTrend([])).toBeNull();
    expect(controlTrend([s('a', 60)])).toBeNull();
  });

  it('holder gaining: share up over the last 10 samples', () => {
    const rows = minutes(['a', 20], ['a', 54], ...Array.from({ length: 9 }, () => ['a', 58] as [string, number]), ['a', 62]);
    // 12 samples: the window starts at index 1 (54), not the older 20.
    expect(controlTrend(rows)).toEqual({ gainer: 'holder', pct: 8, minutes: 10 });
  });

  it('challenger gaining: holder share down', () => {
    expect(controlTrend(minutes(['a', 70], ['a', 66], ['a', 62]))).toEqual({ gainer: 'challenger', pct: 8, minutes: 2 });
  });

  it('steady: no whole-percent change', () => {
    expect(controlTrend(minutes(['a', 62], ['a', 62.3], ['a', 62.2]))).toEqual({ gainer: 'steady', pct: 0, minutes: 2 });
  });

  it('a holder that took the sector inside the window counts from zero', () => {
    expect(controlTrend(minutes(['b', 55], ['a', 51], ['a', 53]))).toEqual({ gainer: 'holder', pct: 53, minutes: 2 });
  });
});

describe('trend text', () => {
  const up = { gainer: 'holder', pct: 8, minutes: 10 } as const;
  const down = { gainer: 'challenger', pct: 8, minutes: 10 } as const;
  const flat = { gainer: 'steady', pct: 0, minutes: 10 } as const;

  it('full line names who is gaining', () => {
    expect(trendLine(up, 'Sol Dominion', 'Robot Dominion')).toBe('Sol Dominion gaining · +8% in 10 min');
    expect(trendLine(down, 'Sol Dominion', 'Robot Dominion')).toBe('Robot Dominion gaining · +8% in 10 min');
    expect(trendLine(down, 'Sol Dominion', null)).toBe('Sol Dominion losing · −8% in 10 min');
    expect(trendLine(flat, 'Sol Dominion', null)).toBe('Steady');
  });

  it('phone label is short', () => {
    expect(trendShort(up, 'Sol Dominion', null)).toBe('Sol +8% / 10 min');
    expect(trendShort(down, 'Sol Dominion', 'Robot Dominion')).toBe('Robot +8% / 10 min');
    expect(trendShort(flat, 'Sol Dominion', null)).toBe('Steady');
  });
});

describe('agoLabel', () => {
  it('reads minutes, hours, then days', () => {
    expect(agoLabel(-5)).toBe('just now');
    expect(agoLabel(59_000)).toBe('just now');
    expect(agoLabel(12 * 60_000)).toBe('12 min ago');
    expect(agoLabel(3 * 3_600_000)).toBe('3 h ago');
    expect(agoLabel(3 * 86_400_000)).toBe('3 days ago');
  });
});
