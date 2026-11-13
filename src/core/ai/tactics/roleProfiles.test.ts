/**
 * AI overhaul slice 3 — every ship kind names a tactical role, every role has a
 * complete profile, and the sensor range is size-correct (× fire range).
 */
import { describe, it, expect } from 'vitest';
import { SHIP_KINDS_LIST } from '../../../shared-types/shipKinds.js';
import { AI_ROLES } from '../../../shared-types/shipKinds/types.js';
import { ON_SIGHT_ENGAGE_RANGE } from '../../../shared-types/allegiances.js';
import { ROLE_PROFILES, roleProfile, roleSensorRange } from './roleProfiles.js';

describe('ship aiRole + role profiles', () => {
  it('every catalogue kind has a valid aiRole', () => {
    for (const k of SHIP_KINDS_LIST) {
      expect(AI_ROLES, k.id).toContain(k.aiRole);
    }
  });

  it('maps the archetypes as planned', () => {
    const role = (id: string): string | undefined => SHIP_KINDS_LIST.find((k) => k.id === id)?.aiRole;
    expect(role('scout')).toBe('scout');
    expect(role('interceptor')).toBe('interceptor');
    expect(role('fighter')).toBe('fighter');
    expect(role('missile-frigate')).toBe('missileBoat');
    expect(role('gunship')).toBe('gunship');
    expect(role('battleship')).toBe('capital');
    expect(role('robot-square')).toBe('robot');
    expect(role('trader-hauler')).toBe('civilian');
  });

  it('every role has a complete, frozen, in-range profile', () => {
    expect(Object.keys(ROLE_PROFILES).sort()).toEqual([...AI_ROLES].sort());
    for (const r of AI_ROLES) {
      const p = roleProfile(r);
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.manoeuvreWeights)).toBe(true);
      expect(p.sensorRangeMul).toBeGreaterThan(0);
      expect(p.rangeBand.min).toBeGreaterThanOrEqual(0);
      expect(p.rangeBand.max).toBeGreaterThan(p.rangeBand.min);
      expect(p.aggression).toBeGreaterThanOrEqual(0);
      expect(p.aggression).toBeLessThanOrEqual(1);
      expect(p.reactionTicks).toBeGreaterThan(0);
      expect(p.aimErrorRad).toBeGreaterThanOrEqual(0);
      for (const w of Object.values(p.manoeuvreWeights)) expect(w).toBeGreaterThanOrEqual(0);
      const m = p.moraleWeights;
      expect(m.fightOn + m.fallBack + m.flee).toBeGreaterThan(0);
    }
  });

  it('sensor range scales with fire range, floored at the on-sight range', () => {
    expect(roleSensorRange('fighter', 10)).toBe(ON_SIGHT_ENGAGE_RANGE);
    const big = 10 * ON_SIGHT_ENGAGE_RANGE;
    expect(roleSensorRange('capital', big)).toBe(big * ROLE_PROFILES.capital.sensorRangeMul);
  });
});
