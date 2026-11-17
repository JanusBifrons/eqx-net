import { describe, expect, it } from 'vitest';
import { HISTORY_SAMPLES, HISTORY_SAMPLE_MS, SectorControlHistory } from './sectorControlHistory.js';

describe('SectorControlHistory — a preallocated 60-sample ring per sector', () => {
  it('is due at once, then once per sample interval', () => {
    const h = new SectorControlHistory(['a']);
    expect(h.due(0)).toBe(true);
    h.commit(0);
    expect(h.due(HISTORY_SAMPLE_MS - 1)).toBe(false);
    expect(h.due(HISTORY_SAMPLE_MS)).toBe(true);
  });

  it('returns samples oldest first and keeps only the last hour', () => {
    const h = new SectorControlHistory(['a', 'b']);
    for (let i = 0; i < HISTORY_SAMPLES + 5; i++) {
      h.record('a', i * HISTORY_SAMPLE_MS, i % 2 === 0 ? 'core' : null, i);
    }
    const s = h.samples('a')!;
    expect(s).toHaveLength(HISTORY_SAMPLES);
    expect(s[0]).toEqual({ atMs: 5 * HISTORY_SAMPLE_MS, holder: null, holderShare: 5 });
    expect(s[HISTORY_SAMPLES - 1]!.atMs).toBe((HISTORY_SAMPLES + 4) * HISTORY_SAMPLE_MS);
    expect(h.samples('b')).toEqual([]);
  });

  it('an unknown sector has no history and records nothing', () => {
    const h = new SectorControlHistory(['a']);
    h.record('zz', 0, 'core', 50);
    expect(h.samples('zz')).toBeNull();
  });
});
