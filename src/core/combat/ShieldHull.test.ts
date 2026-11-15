import { describe, it, expect } from 'vitest';
import {
  applyLayeredDamage,
  regenStep,
  type ShieldHullState,
  type ShieldRegenParams,
} from './ShieldHull.js';

const KIND: ShieldRegenParams = {
  shieldMax: 100,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 100 / 120,
};

const st = (shield: number, hull: number, lastDamageTick = 0): ShieldHullState => ({
  shield,
  hull,
  lastDamageTick,
});

describe('applyLayeredDamage', () => {
  it('shield absorbs a partial hit; hull untouched', () => {
    const s = st(100, 100);
    const r = applyLayeredDamage(s, 30, 50);
    expect(s.shield).toBe(70);
    expect(s.hull).toBe(100);
    expect(r).toMatchObject({ hitLayer: 'shield', brokeThisHit: false, shieldAbsorbed: 30, hullDamage: 0 });
    expect(s.lastDamageTick).toBe(50);
  });

  it('the FINAL hit before the shield drops is fully absorbed — NO spillover', () => {
    // A 1 HP shield eats an arbitrarily large single hit. Overkill is lost.
    const s = st(1, 100);
    const r = applyLayeredDamage(s, 1_000_000_000, 7);
    expect(s.shield).toBe(0);
    expect(s.hull).toBe(100); // hull completely untouched
    expect(r).toMatchObject({ hitLayer: 'shield', brokeThisHit: true, shieldAbsorbed: 1, hullDamage: 0 });
  });

  it('exact-deplete reports brokeThisHit and leaves hull intact', () => {
    const s = st(30, 80);
    const r = applyLayeredDamage(s, 30, 1);
    expect(s.shield).toBe(0);
    expect(s.hull).toBe(80);
    expect(r.brokeThisHit).toBe(true);
  });

  it('once shield is 0, damage goes to hull (no re-break)', () => {
    const s = st(0, 100, 5);
    const r = applyLayeredDamage(s, 25, 9);
    expect(s.hull).toBe(75);
    expect(r).toMatchObject({ hitLayer: 'hull', brokeThisHit: false, hullDamage: 25 });
    expect(s.lastDamageTick).toBe(9);
  });

  it('hull clamps at 0 (never negative); hullDamage is the real amount lost', () => {
    const s = st(0, 10);
    const r = applyLayeredDamage(s, 50, 2);
    expect(s.hull).toBe(0);
    expect(r.hullDamage).toBe(10);
  });

  it('damage <= 0 is a no-op and does NOT reset the regen timer', () => {
    const s = st(40, 100, 12);
    const r = applyLayeredDamage(s, 0, 999);
    expect(s).toEqual({ shield: 40, hull: 100, lastDamageTick: 12 });
    expect(r).toMatchObject({ shieldAbsorbed: 0, hullDamage: 0, brokeThisHit: false });
    applyLayeredDamage(s, -5, 999);
    expect(s.lastDamageTick).toBe(12);
  });

  it('a hull hit also resets the regen timer', () => {
    const s = st(0, 100, 3);
    applyLayeredDamage(s, 10, 250);
    expect(s.lastDamageTick).toBe(250);
  });
});

describe('regenStep (Halo-classic)', () => {
  it('does nothing while inside the post-damage delay window', () => {
    const s = st(0, 100, 100);
    const r = regenStep(s, KIND, 100 + KIND.shieldRegenDelayTicks - 1);
    expect(s.shield).toBe(0);
    expect(r).toMatchObject({ regenerated: false, restoredThisStep: false });
  });

  it('restores by exactly shieldRegenRate once the delay elapses; reports the 0-cross once', () => {
    const s = st(0, 100, 100);
    const t0 = 100 + KIND.shieldRegenDelayTicks;
    const r1 = regenStep(s, KIND, t0);
    expect(s.shield).toBeCloseTo(KIND.shieldRegenRate, 9);
    expect(r1.restoredThisStep).toBe(true); // 0 -> >0 crossing
    expect(r1.regenerated).toBe(true);
    const r2 = regenStep(s, KIND, t0 + 1);
    expect(s.shield).toBeCloseTo(2 * KIND.shieldRegenRate, 9);
    expect(r2.restoredThisStep).toBe(false); // crossing fires only once
  });

  it('clamps at shieldMax and reports regenComplete exactly once', () => {
    const s = st(KIND.shieldMax - KIND.shieldRegenRate / 2, 100, 0);
    const r1 = regenStep(s, KIND, KIND.shieldRegenDelayTicks);
    expect(s.shield).toBe(KIND.shieldMax);
    expect(r1.regenComplete).toBe(true);
    const r2 = regenStep(s, KIND, KIND.shieldRegenDelayTicks + 1);
    expect(r2).toMatchObject({ regenerated: false, regenComplete: false });
  });

  it('a dead ship (hull <= 0) never regens its shield', () => {
    const s = st(0, 0, 0);
    const r = regenStep(s, KIND, 10_000);
    expect(s.shield).toBe(0);
    expect(r.regenerated).toBe(false);
  });

  it('new damage resets the delay so an in-progress regen stalls until the new window', () => {
    const s = st(0, 100, 0);
    regenStep(s, KIND, KIND.shieldRegenDelayTicks); // shield ticks up once (~0.83)
    expect(s.shield).toBeGreaterThan(0);
    // A hit during regen lands on the freshly-regenerated shield and also
    // resets lastDamageTick.
    applyLayeredDamage(s, 5, KIND.shieldRegenDelayTicks + 1);
    const shieldAfterHit = s.shield;
    const stalled = regenStep(s, KIND, KIND.shieldRegenDelayTicks + 2); // inside the NEW delay
    expect(stalled.regenerated).toBe(false);
    expect(s.shield).toBe(shieldAfterHit);
    // Regen only resumes once the full delay has elapsed past the NEW hit.
    const resumed = regenStep(s, KIND, KIND.shieldRegenDelayTicks + 1 + KIND.shieldRegenDelayTicks);
    expect(resumed.regenerated).toBe(true);
  });
});

describe('applyLayeredDamage with a per-layer multiplier (weapon targetFactor)', () => {
  const MINER = { shield: 0, hull: 0.05 };

  it('a raised shield takes damage x shield factor; 0 is a no-op that keeps the regen timer', () => {
    const s = st(50, 100, 7);
    const r = applyLayeredDamage(s, 40, 500, MINER);
    expect(s).toEqual({ shield: 50, hull: 100, lastDamageTick: 7 });
    expect(r).toEqual({ hitLayer: 'shield', brokeThisHit: false, shieldAbsorbed: 0, hullDamage: 0 });
  });

  it('an exposed hull takes damage x hull factor', () => {
    const s = st(0, 100, 7);
    const r = applyLayeredDamage(s, 40, 500, MINER);
    expect(s.hull).toBeCloseTo(98, 10);
    expect(s.lastDamageTick).toBe(500);
    expect(r.hitLayer).toBe('hull');
    expect(r.hullDamage).toBeCloseTo(2, 10);
  });

  it('the shield factor alone scales a shield hit (and can break it)', () => {
    const s = st(10, 100);
    const r = applyLayeredDamage(s, 40, 500, { shield: 0.5, hull: 1 });
    expect(s.shield).toBe(0);
    expect(r.brokeThisHit).toBe(true);
    expect(r.shieldAbsorbed).toBe(10);
  });

  it('a x1 multiplier is byte-identical to no multiplier', () => {
    const a = st(30, 100); const b = st(30, 100);
    expect(applyLayeredDamage(a, 12.3, 9, { shield: 1, hull: 1 })).toEqual(applyLayeredDamage(b, 12.3, 9));
    expect(a).toEqual(b);
  });
});
