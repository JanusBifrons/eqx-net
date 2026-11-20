import { describe, expect, it } from 'vitest';
import { buildEntry } from './packedStock.js';

describe('Build-menu packed stock (economy v2)', () => {
  it('starter kinds are always free and plain', () => {
    expect(buildEntry('solar', {})).toEqual({ label: 'Solar Panel', locked: false, count: null });
  });

  it('a held crate shows its count; with none a non-Capital still builds from the bank', () => {
    expect(buildEntry('smelter', { 'structure:smelter': 2 })).toEqual({ label: 'Smelter ×2', locked: false, count: 2 });
    expect(buildEntry('smelter', {})).toEqual({ label: 'Smelter', locked: false, count: 0 });
  });

  it('only the Capital locks without its packed crate', () => {
    expect(buildEntry('capital', {}).locked).toBe(true);
    expect(buildEntry('capital', {}).label).toContain('needs packed');
    expect(buildEntry('capital', { 'structure:capital': 1 })).toMatchObject({ locked: false, count: 1 });
  });

  it('before the first reply nothing is locked', () => {
    expect(buildEntry('smelter', null).locked).toBe(false);
    expect(buildEntry('capital', null).locked).toBe(false);
  });
});
