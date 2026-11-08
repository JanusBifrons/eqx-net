/** `?shiplight=gpu` (plan prancy-squishing-donut R2): off unless asked, only with Machined art. */
import { describe, expect, it } from 'vitest';
import { resolveArtMode, resolveShipLighting } from './artMode.js';
import { LOOK_NIGHT, defaultLightingPreset, presetSettings } from './lightingSettings.js';

describe('resolveShipLighting', () => {
  it('is off by default and with classic art', () => {
    expect(resolveShipLighting('', 'machined')).toBeUndefined();
    expect(resolveShipLighting('?shiplight=gpu', 'classic')).toBeUndefined();
  });
  it('defaults to the night-side look; per-feature switches apply', () => {
    expect(resolveShipLighting('?shiplight=gpu', 'machined')).toEqual(LOOK_NIGHT);
    const s = resolveShipLighting('?shiplight=gpu&look=f&points=4', 'machined')!;
    expect(s.sunElevDeg).toBe(25);
    expect(s.pointLights).toBe(4);
  });
  it('asking for it implies the Machined look (an automated browser defaults to classic)', () => {
    expect(resolveArtMode('?shiplight=gpu', true, null)).toBe('machined');
    expect(resolveArtMode('?shiplight=gpu&art=classic', true, null)).toBe('classic');
    expect(resolveArtMode('', true, null)).toBe('classic');
  });
  it('is plain data (it crosses to the render worker on BOOT)', () => {
    const s = resolveShipLighting('?shiplight=gpu', 'machined')!;
    expect(structuredClone(s)).toEqual(s);
  });

describe('lighting levels (default on for players)', () => {
  it('players get their device default; automation stays baked unless the URL asks', () => {
    expect(resolveShipLighting('', 'machined', { touch: false })).toEqual(LOOK_NIGHT);
    expect(resolveShipLighting('', 'machined', { touch: true })).toEqual(presetSettings('medium'));
    expect(resolveShipLighting('', 'machined', { touch: true, deviceMemoryGb: 2 })).toEqual(presetSettings('low'));
    expect(resolveShipLighting('', 'machined', { touch: false, automation: true })).toBeUndefined();
    expect(resolveShipLighting('?shiplight=medium', 'machined', { automation: true })).toEqual(presetSettings('medium'));
  });
  it('URL beats saved beats default; baked is the old look; classic art is never lit', () => {
    expect(resolveShipLighting('', 'machined', { saved: 'baked', touch: false })).toBeUndefined();
    expect(resolveShipLighting('?shiplight=low', 'machined', { saved: 'high' })).toEqual(presetSettings('low'));
    expect(resolveShipLighting('?shiplight=baked', 'machined', { saved: 'high' })).toBeUndefined();
    expect(resolveShipLighting('', 'classic', { saved: 'high' })).toBeUndefined();
    expect(defaultLightingPreset(false)).toBe('high');
    expect(resolveArtMode('?shiplight=baked', true, null)).toBe('classic');
    expect(resolveArtMode('?shiplight=low', true, null)).toBe('machined');
  });
  it('lower levels do less per pixel', () => {
    const lo = presetSettings('low'), md = presetSettings('medium'), hi = presetSettings('high');
    expect(lo.selfShadowSteps).toBeLessThan(md.selfShadowSteps);
    expect(md.selfShadowSteps).toBeLessThan(hi.selfShadowSteps);
    expect(md.pointLights).toBeLessThanOrEqual(hi.pointLights);
  });
});
});
