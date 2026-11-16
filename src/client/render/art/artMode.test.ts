/** `?livery=` look flag: on by default (b8), `off` turns it off, a named
 *  treatment implies Machined art; the default never changes the art mode. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LIVERY, readLivery, readOreLook, resolveArtMode } from './artMode.js';

describe('readLivery', () => {
  it('the default livery is b8', () => {
    expect(DEFAULT_LIVERY).toBe('b8');
  });
  it('parses the named treatments', () => {
    expect(readLivery('?livery=a')).toBe('a');
    expect(readLivery('?room=sector&livery=b')).toBe('b');
    expect(readLivery('?livery=c&art=machined')).toBe('c');
    expect(readLivery('?livery=b2')).toBe('b2');
    expect(readLivery('?livery=b3&art=machined')).toBe('b3');
    expect(readLivery('?livery=b4')).toBe('b4');
    expect(readLivery('?livery=b7')).toBe('b7');
    expect(readLivery('?livery=b8')).toBe('b8');
  });
  it('absent or unknown is the default livery', () => {
    expect(readLivery('')).toBe('b8');
    expect(readLivery('?room=sector&art=machined')).toBe('b8');
    expect(readLivery('?livery=d')).toBe('b8');
    expect(readLivery('?livery=b9')).toBe('b8');
  });
  it('off is no livery', () => {
    expect(readLivery('?livery=off')).toBeUndefined();
    expect(readLivery('?room=sector&livery=off&art=machined')).toBeUndefined();
  });
  it('a named livery forces Machined art unless ?art= says otherwise', () => {
    expect(resolveArtMode('?livery=a', true, null)).toBe('machined');
    expect(resolveArtMode('?livery=b8', true, 'classic')).toBe('machined');
    expect(resolveArtMode('?livery=c&art=classic', true, null)).toBe('classic');
  });
  it('the default livery (and off) never changes the art mode', () => {
    expect(resolveArtMode('', true, null)).toBe('classic');
    expect(resolveArtMode('', false, 'classic')).toBe('classic');
    expect(resolveArtMode('', false, null)).toBe('machined');
    expect(resolveArtMode('?livery=off', true, null)).toBe('classic');
    expect(resolveArtMode('?livery=off', false, 'machined')).toBe('machined');
    expect(resolveArtMode('?livery=d', true, null)).toBe('classic');
  });
});

describe('readOreLook (cut-field ore look trial, F1c)', () => {
  it('reads the four styles and ignores anything else', () => {
    expect(readOreLook('?ore=tint')).toBe('tint');
    expect(readOreLook('?room=x&ore=seams')).toBe('seams');
    expect(readOreLook('?ore=off')).toBe('off');
    expect(readOreLook('?ore=gold')).toBeUndefined();
    expect(readOreLook('')).toBeUndefined();
  });
});
