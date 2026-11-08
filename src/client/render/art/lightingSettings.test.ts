/**
 * GPU lighting settings (plan prancy-squishing-donut 1b). The user:
 * "performance and configurability is king, so we can toggle these off per
 * device granularly". Each feature has its own switch, and a feature that is
 * off is not compiled into the shader at all.
 */
import { describe, it, expect } from 'vitest';
import { BAKED_LOOK, LOOK_F, LOOK_REAL, ALL_ON, lightingDefines, lightingFromSearch, engineLightIntensity, engineLightReach } from './lightingSettings.js';

describe('lighting settings', () => {
  it('the baked look compiles only the self shadow', () => {
    expect(lightingDefines(BAKED_LOOK).defines).toBe('#define SELF_SHADOW 1');
    expect(lightingDefines({ ...BAKED_LOOK, selfShadowSteps: 0 }).key).toBe('base');
  });

  it('every feature switch reaches the shader on its own', () => {
    const d = (s: string): string => lightingDefines(lightingFromSearch(s, { ...BAKED_LOOK, selfShadowSteps: 0 })).defines;
    expect(d('?fill=1')).toContain('FILL_LIGHT');
    expect(d('?points=4')).toContain('POINT_LIGHTS 4');
    expect(d('?capshadow=1')).toMatch(/OCC_SHADOW[\s\S]*OCCLUDERS/);
    expect(d('?capao=1')).toContain('OCC_AO');
    expect(d('?capbounce=1')).toContain('OCC_BOUNCE');
    expect(d('?capao=1')).not.toContain('OCC_SHADOW');
  });

  it('looks: F, realistic (no ambient) and everything; per-feature overrides win', () => {
    expect(lightingFromSearch('?look=f')).toEqual(LOOK_F);
    expect(lightingFromSearch('?look=real').ambientBoost).toBe(0);
    expect(lightingFromSearch('?look=all')).toEqual(ALL_ON);
    expect(lightingFromSearch('?look=all&points=0&capshadow=0').pointLights).toBe(0);
    expect(lightingFromSearch('?look=real&engines=0').engineLights).toBe(false);
    expect(LOOK_REAL.engineLights).toBe(true);
  });

  it('engines light by size and thrust', () => {
    expect(engineLightIntensity(3, 1)).toBeCloseTo(4 * engineLightIntensity(3, 0));
    expect(engineLightIntensity(12, 0.5)).toBeGreaterThan(engineLightIntensity(3, 0.5) * 3);
    expect(engineLightReach(12)).toBeGreaterThan(engineLightReach(3));
  });
});
