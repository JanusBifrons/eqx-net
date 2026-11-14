import { describe, expect, it } from 'vitest';
import {
  MORALE_BURST_WINDOW_TICKS,
  MORALE_OUTCOME,
  MoraleTracker,
  MORALE_TRIGGER,
  moraleSeed,
  moraleWeightsFor,
  rollMorale,
  type MoraleInputs,
  type MoraleWeights,
  type MutableMoraleWeights,
} from './morale.js';

const BASE: MoraleWeights = { fightOn: 0.5, fallBack: 0.3, flee: 0.2 };

const NEUTRAL: MoraleInputs = {
  hullFrac: 1,
  recentDamageRate: 0,
  alliesNear: 0,
  enemiesNear: 1,
  ownSize: 10,
  enemySize: 10,
  isCapitalNearbyFriendly: false,
};

function probs(inputs: MoraleInputs, base: MoraleWeights = BASE): MutableMoraleWeights {
  const w = moraleWeightsFor(inputs, base, { fightOn: 0, fallBack: 0, flee: 0 });
  const t = w.fightOn + w.fallBack + w.flee;
  return { fightOn: w.fightOn / t, fallBack: w.fallBack / t, flee: w.flee / t };
}

describe('rollMorale', () => {
  it('neutral inputs leave the base weights unchanged', () => {
    const p = probs(NEUTRAL);
    expect(p.fightOn).toBeCloseTo(0.5, 10);
    expect(p.fallBack).toBeCloseTo(0.3, 10);
    expect(p.flee).toBeCloseTo(0.2, 10);
  });

  it('10k rolls over varying seeds approximate the normalised weights', () => {
    const inputs: MoraleInputs = { ...NEUTRAL, hullFrac: 0.4, recentDamageRate: 0.3, alliesNear: 2 };
    const expected = probs(inputs);
    const counts = [0, 0, 0];
    const N = 10_000;
    for (let i = 0; i < N; i++) counts[rollMorale(inputs, BASE, moraleSeed(i * 7 + 1, i))]!++;
    expect(counts[MORALE_OUTCOME.FightOn]! / N).toBeCloseTo(expected.fightOn, 1);
    expect(Math.abs(counts[MORALE_OUTCOME.FightOn]! / N - expected.fightOn)).toBeLessThan(0.02);
    expect(Math.abs(counts[MORALE_OUTCOME.FallBack]! / N - expected.fallBack)).toBeLessThan(0.02);
    expect(Math.abs(counts[MORALE_OUTCOME.Flee]! / N - expected.flee)).toBeLessThan(0.02);
  });

  it('is deterministic: same seed, same outcome', () => {
    for (let id = 0; id < 50; id++) {
      const seed = moraleSeed(id, 3);
      const a = rollMorale(NEUTRAL, BASE, seed);
      expect(rollMorale(NEUTRAL, BASE, seed)).toBe(a);
    }
    expect(moraleSeed(5, 1)).toBe(moraleSeed(5, 1));
    expect(moraleSeed(5, 1)).not.toBe(moraleSeed(5, 2));
    expect(moraleSeed(5, 1)).not.toBe(moraleSeed(6, 1));
  });

  it('all-zero weights fall back to FightOn; a zero-weight outcome never rolls', () => {
    expect(rollMorale(NEUTRAL, { fightOn: 0, fallBack: 0, flee: 0 }, 123)).toBe(MORALE_OUTCOME.FightOn);
    for (let i = 0; i < 500; i++) {
      expect(rollMorale(NEUTRAL, { fightOn: 1, fallBack: 1, flee: 0 }, moraleSeed(i, 0))).not.toBe(MORALE_OUTCOME.Flee);
    }
  });

  it('clamps negative / NaN base weights to 0', () => {
    const w = moraleWeightsFor(NEUTRAL, { fightOn: -1, fallBack: Number.NaN, flee: 1 }, { fightOn: 0, fallBack: 0, flee: 0 });
    expect(w.fightOn).toBe(0);
    expect(w.fallBack).toBe(0);
    expect(w.flee).toBeGreaterThan(0);
  });
});

describe('morale modifiers move the odds the documented way', () => {
  const p0 = probs(NEUTRAL);

  it('more allies near: fight on and fall back up, flee down', () => {
    const p = probs({ ...NEUTRAL, alliesNear: 4 });
    expect(p.fightOn).toBeGreaterThan(p0.fightOn);
    expect(p.flee).toBeLessThan(p0.flee);
    const w0 = moraleWeightsFor(NEUTRAL, BASE, { fightOn: 0, fallBack: 0, flee: 0 });
    const w = moraleWeightsFor({ ...NEUTRAL, alliesNear: 4 }, BASE, { fightOn: 0, fallBack: 0, flee: 0 });
    expect(w.fallBack).toBeGreaterThan(w0.fallBack);
  });

  it('heavy / fast damage: flee up', () => {
    expect(probs({ ...NEUTRAL, recentDamageRate: 0.5 }).flee).toBeGreaterThan(p0.flee);
  });

  it('outsized enemy: flee up; we are the bigger: fight on up', () => {
    expect(probs({ ...NEUTRAL, enemySize: 80 }).flee).toBeGreaterThan(p0.flee);
    expect(probs({ ...NEUTRAL, enemySize: 2 }).fightOn).toBeGreaterThan(p0.fightOn);
  });

  it('low hull: fight on down', () => {
    expect(probs({ ...NEUTRAL, hullFrac: 0.1 }).fightOn).toBeLessThan(p0.fightOn);
  });

  it('friendly capital near: fall back up', () => {
    expect(probs({ ...NEUTRAL, isCapitalNearbyFriendly: true }).fallBack).toBeGreaterThan(p0.fallBack);
  });
});

describe('MoraleTracker', () => {
  it('hull thresholds fire once, and re-arm only after healing past hysteresis', () => {
    const t = new MoraleTracker();
    expect(t.update(0, 0.9, 0, 0)).toBe(-1);
    expect(t.update(1, 0.5, 0, 0)).toBe(MORALE_TRIGGER.Hull50);
    expect(t.update(2, 0.45, 0, 0)).toBe(-1);
    expect(t.update(3, 0.58, 0, 0)).toBe(-1); // not above 0.6: still disarmed
    expect(t.update(4, 0.5, 0, 0)).toBe(-1);
    expect(t.update(5, 0.61, 0, 0)).toBe(-1); // re-armed
    expect(t.update(6, 0.49, 0, 0)).toBe(MORALE_TRIGGER.Hull50);
    expect(t.update(7, 0.25, 0, 0)).toBe(MORALE_TRIGGER.Hull25);
    expect(t.update(8, 0.2, 0, 0)).toBe(-1);
    expect(t.triggerCount).toBe(3);
  });

  it('a single blow from full to under 25 % fires one Hull25 roll, not two', () => {
    const t = new MoraleTracker();
    expect(t.update(0, 0.2, 0, 0)).toBe(MORALE_TRIGGER.Hull25);
    expect(t.update(1, 0.2, 0, 0)).toBe(-1);
  });

  it('burst detection uses ticks: fast damage fires, the same damage spread out does not', () => {
    const fast = new MoraleTracker();
    for (let i = 0; i < 5; i++) fast.noteDamage(i * 10, 5, 100); // 25 % in 50 ticks
    expect(fast.update(50, 0.75, 0, 0)).toBe(MORALE_TRIGGER.Burst);
    expect(fast.update(51, 0.75, 0, 0)).toBe(-1);

    const slow = new MoraleTracker();
    for (let i = 0; i < 5; i++) {
      slow.noteDamage(i * MORALE_BURST_WINDOW_TICKS, 5, 100);
      expect(slow.update(i * MORALE_BURST_WINDOW_TICKS, 1 - 0.05 * (i + 1), 0, 0)).toBe(-1);
    }
    expect(slow.windowDamageFrac(4 * MORALE_BURST_WINDOW_TICKS)).toBeLessThan(0.2);
  });

  it('burst re-arms after the window drains', () => {
    const t = new MoraleTracker();
    t.noteDamage(0, 30, 100);
    expect(t.update(0, 0.7, 0, 0)).toBe(MORALE_TRIGGER.Burst);
    expect(t.update(MORALE_BURST_WINDOW_TICKS * 2, 0.7, 0, 0)).toBe(-1);
    expect(t.windowDamageFrac(MORALE_BURST_WINDOW_TICKS * 2)).toBe(0);
    t.noteDamage(MORALE_BURST_WINDOW_TICKS * 2 + 1, 30, 100);
    expect(t.update(MORALE_BURST_WINDOW_TICKS * 2 + 1, 0.7, 0, 0)).toBe(MORALE_TRIGGER.Burst);
  });

  it('capital lost fires on the next update only', () => {
    const t = new MoraleTracker();
    t.noteCapitalLost();
    expect(t.update(0, 1, 0, 0)).toBe(MORALE_TRIGGER.CapitalLost);
    expect(t.update(1, 1, 0, 0)).toBe(-1);
  });

  it('outnumbered 3:1 fires once and re-arms when the odds drop under 2:1', () => {
    const t = new MoraleTracker();
    expect(t.update(0, 1, 1, 5)).toBe(-1); // 5 vs 2
    expect(t.update(1, 1, 1, 6)).toBe(MORALE_TRIGGER.Outnumbered); // 6 vs 2
    expect(t.update(2, 1, 1, 7)).toBe(-1);
    expect(t.update(3, 1, 1, 3)).toBe(-1); // 3 < 4: re-armed
    expect(t.update(4, 1, 0, 3)).toBe(MORALE_TRIGGER.Outnumbered); // alone vs 3
  });

  it('reset returns to a fresh tracker', () => {
    const t = new MoraleTracker();
    t.update(0, 0.2, 0, 0);
    t.reset();
    expect(t.triggerCount).toBe(0);
    expect(t.update(0, 0.2, 0, 0)).toBe(MORALE_TRIGGER.Hull25);
  });
});
