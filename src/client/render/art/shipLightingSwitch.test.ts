/** `?shiplight=gpu` (plan prancy-squishing-donut R2): off unless asked, only with Machined art. */
import { describe, expect, it } from 'vitest';
import { resolveArtMode, resolveShipLighting } from './artMode.js';
import { LOOK_NIGHT } from './lightingSettings.js';

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
});
