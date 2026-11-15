/** `?livery=` look flag: parsed like `?shiplight=`, and implies Machined art. */
import { describe, expect, it } from 'vitest';
import { readLivery, resolveArtMode } from './artMode.js';

describe('readLivery', () => {
  it('parses a, b and c', () => {
    expect(readLivery('?livery=a')).toBe('a');
    expect(readLivery('?room=sector&livery=b')).toBe('b');
    expect(readLivery('?livery=c&art=machined')).toBe('c');
    expect(readLivery('?livery=b2')).toBe('b2');
    expect(readLivery('?livery=b3&art=machined')).toBe('b3');
    expect(readLivery('?livery=b4')).toBe('b4');
    expect(readLivery('?livery=b7')).toBe('b7');
  });
  it('off, absent or unknown is undefined', () => {
    expect(readLivery('?livery=off')).toBeUndefined();
    expect(readLivery('')).toBeUndefined();
    expect(readLivery('?livery=d')).toBeUndefined();
    expect(readLivery('?livery=b8')).toBe('b8');
    expect(readLivery('?livery=b9')).toBeUndefined();
  });
  it('a livery forces Machined art unless ?art= says otherwise', () => {
    expect(resolveArtMode('?livery=a', true, null)).toBe('machined');
    expect(resolveArtMode('?livery=b', true, 'classic')).toBe('machined');
    expect(resolveArtMode('?livery=off', true, null)).toBe('classic');
    expect(resolveArtMode('?livery=c&art=classic', true, null)).toBe('classic');
  });
});
