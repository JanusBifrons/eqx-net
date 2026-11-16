import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GRAPHICS_QUALITY, MAX_BUFFER_SIDE, loadGraphicsQualityPreference, readGraphicsQualityParams,
  renderResolution, resolveGraphicsQuality, saveGraphicsQualityPreference,
} from './graphicsQuality';

function memStore(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
}

describe('graphics quality settings', () => {
  it('defaults to today\'s look (multisampling, screen density, no softening)', () => {
    expect(resolveGraphicsQuality('', null)).toEqual({ aa: 'msaa', renderScale: 1, texSoft: 0 });
  });

  it('URL beats the saved choice, per setting', () => {
    const q = resolveGraphicsQuality('?aa=fxaa&renderscale=2', { aa: 'off', renderScale: 0.75, texSoft: 1 });
    expect(q).toEqual({ aa: 'fxaa', renderScale: 2, texSoft: 1 });
  });

  it('ignores unknown URL values', () => {
    expect(readGraphicsQualityParams('?aa=ultra&renderscale=3&texsoft=7')).toEqual({});
  });

  it('round-trips through storage and drops invalid saved values', () => {
    const s = memStore();
    saveGraphicsQualityPreference({ aa: 'max', renderScale: 1.5, texSoft: 0.5 }, s);
    expect(loadGraphicsQualityPreference(s)).toEqual({ aa: 'max', renderScale: 1.5, texSoft: 0.5 });
    s.setItem('eqxGfxQuality', JSON.stringify({ aa: 'nope', renderScale: 9, texSoft: 0 }));
    expect(loadGraphicsQualityPreference(s)).toEqual({ texSoft: 0 });
    s.setItem('eqxGfxQuality', '{broken');
    expect(loadGraphicsQualityPreference(s)).toBeNull();
    expect(DEFAULT_GRAPHICS_QUALITY.aa).toBe('msaa');
  });
});

describe('renderResolution', () => {
  it('scale 1 is the screen density, unchanged', () => {
    expect(renderResolution(2.625, 1, 412, 915)).toBe(2.625);
  });

  it('supersampling multiplies the density', () => {
    expect(renderResolution(1, 2, 1920, 1080)).toBe(2);
  });

  it('caps the buffer side, but never below the screen density', () => {
    const r = renderResolution(1.5, 2, 2560, 1440);
    expect(2560 * r).toBeLessThanOrEqual(MAX_BUFFER_SIDE);
    expect(r).toBeGreaterThanOrEqual(1.5);
    expect(renderResolution(2, 2, 3840, 2160)).toBe(2);
  });

  it('the saver scale renders below the screen density', () => {
    expect(renderResolution(3, 0.75, 412, 915)).toBe(2.25);
  });
});
