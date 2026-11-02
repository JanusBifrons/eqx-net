import { describe, expect, it } from 'vitest';
import {
  FIXED_FACTIONS,
  clampStanding,
  defaultFactionPolicy,
  factionDisplayName,
  factionStance,
  isNpcFactionId,
  policyActsOnStanding,
  registerNpcFactions,
  standingLabel,
} from './factions.js';
import { REP_PRICE_SWING, ROBOT_TRUCE_AT, TRADER_REFUSE_BELOW } from './economy.js';

const PLAYER = '6a7e0000-0000-4000-8000-0000000000a1';

describe('faction catalogue', () => {
  it('has the original sides, the four region powers and the Ancients', () => {
    const ids = FIXED_FACTIONS.map((f) => f.id);
    expect(ids.slice(0, 3)).toEqual(['drones', 'robots', 'traders']);
    // The region ids from galaxy.ts `GALAXY_FACTIONS` (shared-types can't import
    // core; src/core/galaxy/galaxyFactions.test.ts checks the two agree).
    const regions = [
      { id: 'core', displayName: 'Sol Dominion' },
      { id: 'verdant-reach', displayName: 'Verdant Reach' },
      { id: 'crimson-expanse', displayName: 'Crimson Expanse' },
      { id: 'azure-deep', displayName: 'Azure Deep' },
    ];
    for (const r of regions) {
      expect(ids, r.id).toContain(r.id);
      expect(factionDisplayName(r.id)).toBe(r.displayName);
    }
    expect(ids).toContain('ancients');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a player id is not an NPC faction', () => {
    expect(isNpcFactionId(PLAYER)).toBe(false);
    expect(isNpcFactionId('core')).toBe(true);
  });

  it('registers generated factions once; fixed ids win', () => {
    registerNpcFactions([
      { id: 'test-minor-co', displayName: 'Test Minor Co.', kind: 'minor', color: 0 },
      { id: 'traders', displayName: 'Imposter', kind: 'minor', color: 0 },
    ]);
    registerNpcFactions([{ id: 'test-minor-co', displayName: 'Renamed', kind: 'minor', color: 0 }]);
    expect(factionDisplayName('test-minor-co')).toBe('Test Minor Co.');
    expect(factionDisplayName('traders')).toBe('Traders');
  });
});

describe('standing', () => {
  it('clamps to ±100 in 0.1 steps', () => {
    expect(clampStanding(250)).toBe(100);
    expect(clampStanding(-250)).toBe(-100);
    expect(clampStanding(1.26)).toBe(1.3);
    expect(clampStanding(Number.NaN)).toBe(0);
  });

  it('labels on one scale', () => {
    expect(standingLabel(50)).toBe('Allied');
    expect(standingLabel(15)).toBe('Friendly');
    expect(standingLabel(0)).toBe('Neutral');
    expect(standingLabel(-15)).toBe('Wary');
    expect(standingLabel(-50)).toBe('Hostile');
  });
});

describe('factionStance (the fixed layer under standing)', () => {
  it('keeps the original allegiance table', () => {
    expect(factionStance('robots', PLAYER)).toBe('hostile');
    expect(factionStance('drones', 'robots')).toBe('hostile');
    expect(factionStance('traders', 'drones')).toBe('neutral');
    expect(factionStance('traders', 'traders')).toBe('friendly');
  });

  it('robots attack the new factions; everyone else starts neutral', () => {
    expect(factionStance('robots', 'core')).toBe('hostile');
    expect(factionStance('robots', 'ancients')).toBe('hostile');
    expect(factionStance('core', 'robots')).toBe('neutral');
    expect(factionStance('core', 'azure-deep')).toBe('neutral');
    expect(factionStance('core', PLAYER)).toBe('neutral');
    expect(factionStance('drones', 'core')).toBe('neutral');
  });
});

describe('default policies reproduce the pre-faction rules', () => {
  it('traders: price swing and refusal; robots: the truce', () => {
    expect(defaultFactionPolicy('traders').priceSwing).toBe(REP_PRICE_SWING);
    expect(defaultFactionPolicy('traders').refuseTradeBelow).toBe(TRADER_REFUSE_BELOW);
    expect(defaultFactionPolicy('robots').hostileBelow).toBe(ROBOT_TRUCE_AT);
  });

  it('every other faction, and every player, never acts on standing by default', () => {
    for (const f of FIXED_FACTIONS) {
      if (f.id === 'robots') continue;
      expect(policyActsOnStanding(defaultFactionPolicy(f.id)), f.id).toBe(false);
    }
    expect(policyActsOnStanding(defaultFactionPolicy(PLAYER))).toBe(false);
  });
});
