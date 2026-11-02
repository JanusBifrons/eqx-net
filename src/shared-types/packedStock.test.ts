import { describe, expect, it } from 'vitest';
import { buildEntry } from './packedStock.js';

describe('Build-menu packed stock (economy v2)', () => {
  it('starter kinds are always free and plain', () => {
    expect(buildEntry('solar', {})).toEqual({ label: 'Solar Panel', locked: false, count: null });
  });

  it('a non-starter kind shows the count, or is locked with a hint', () => {
    expect(buildEntry('smelter', { 'structure:smelter': 2 })).toEqual({ label: 'Smelter ×2', locked: false, count: 2 });
    expect(buildEntry('smelter', {})).toEqual({ label: 'Smelter · buy packed', locked: true, count: 0 });
  });

  it('before the first reply nothing is locked', () => {
    expect(buildEntry('smelter', null).locked).toBe(false);
  });
});
