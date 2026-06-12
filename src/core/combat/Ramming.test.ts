import { describe, it, expect } from 'vitest';
import {
  aggregateRamming,
  ramSpeedFactor,
  ramMassDifferentialFactor,
  ramDamageTo,
  RAM_MIN_IMPACT_SPEED,
  RAM_SPEED_FULL,
  RAM_DAMAGE_MAX,
  FORCE_PER_UNIT_SPEED,
} from './Ramming.js';
import type { Contact } from '../physics/contactDrain.js';

function mk(
  aId: string,
  bId: string,
  force: number,
  vax = 1,
  vay = 2,
  vbx = 3,
  vby = 4,
  impactSpeed?: number,
  aMass?: number,
  bMass?: number,
): Contact {
  return {
    aId,
    bId,
    vAxPost: vax,
    vAyPost: vay,
    vBxPost: vbx,
    vByPost: vby,
    forceMagnitude: force,
    impactSpeed,
    aMass,
    bMass,
  };
}

describe('ramSpeedFactor (reverse-square on closing speed)', () => {
  it('is exactly 0 at or below RAM_MIN_IMPACT_SPEED — a tiny / slow bump is free', () => {
    expect(ramSpeedFactor(0)).toBe(0);
    expect(ramSpeedFactor(RAM_MIN_IMPACT_SPEED - 1)).toBe(0);
    expect(ramSpeedFactor(RAM_MIN_IMPACT_SPEED)).toBe(0);
  });

  it('rises as the SQUARE of the normalised over-floor speed, saturating at 1.0', () => {
    // Hand-derived: floor 50, full 700, span 650.
    // Quarter-point: speed = 50 + 650/4 = 212.5 → (0.25)² = 0.0625.
    expect(ramSpeedFactor(212.5)).toBeCloseTo(0.0625, 9);
    // Mid-point: speed = 50 + 650/2 = 375 → (0.5)² = 0.25.
    expect(ramSpeedFactor(375)).toBeCloseTo(0.25, 9);
    // Saturates at RAM_SPEED_FULL and stays clamped above it.
    expect(ramSpeedFactor(RAM_SPEED_FULL)).toBeCloseTo(1, 9);
    expect(ramSpeedFactor(10_000)).toBe(1);
  });

  it('is convex — a moderate over-floor speed deals a SMALL fraction (vs old linear)', () => {
    // The whole point of R2.31: at half the saturation speed you get a QUARTER
    // of the factor, not half — moderate rams are disproportionately gentle.
    expect(ramSpeedFactor(375)).toBeLessThan(0.5 * ramSpeedFactor(RAM_SPEED_FULL));
  });
});

describe('ramMassDifferentialFactor (asymmetric, equal-mass ⇒ 0)', () => {
  it('is 0 for EQUAL masses — two equal ships at any speed deal nothing', () => {
    expect(ramMassDifferentialFactor(1, 1)).toBe(0);
    expect(ramMassDifferentialFactor(30, 30)).toBe(0);
    expect(ramMassDifferentialFactor(5000, 5000)).toBe(0);
  });

  it('rises toward 1 as the OTHER body gets heavier (the light self is crushed)', () => {
    // (3-1)/(3+1) = 0.5 ; (5000-1)/(5001) ≈ 0.9996.
    expect(ramMassDifferentialFactor(1, 3)).toBeCloseTo(0.5, 9);
    expect(ramMassDifferentialFactor(1, 5000)).toBeCloseTo(4999 / 5001, 9);
  });

  it('clamps to 0 for the HEAVIER body — a heavy ship ramming a light one is unharmed', () => {
    expect(ramMassDifferentialFactor(3, 1)).toBe(0);
    expect(ramMassDifferentialFactor(5000, 1)).toBe(0);
  });

  it('returns 0 when both masses are absent/zero (no differential to compute)', () => {
    expect(ramMassDifferentialFactor(0, 0)).toBe(0);
  });
});

describe('ramDamageTo (cap × speed-factor × mass-differential)', () => {
  it('needs BOTH high speed AND a mass differential — neither alone deals damage', () => {
    // Huge speed, equal mass ⇒ 0.
    expect(ramDamageTo(RAM_SPEED_FULL, 5, 5)).toBe(0);
    // Huge mass differential, at-floor speed ⇒ 0.
    expect(ramDamageTo(RAM_MIN_IMPACT_SPEED, 1, 5000)).toBe(0);
  });

  it('crushes the LIGHT body and spares the HEAVY one at full speed', () => {
    // self=1, other=3, speed=full → 50 × 1 × 0.5 = 25 (hand-derived).
    expect(ramDamageTo(RAM_SPEED_FULL, 1, 3)).toBeCloseTo(25, 9);
    // The heavy side (self=3, other=1) → 50 × 1 × 0 = 0.
    expect(ramDamageTo(RAM_SPEED_FULL, 3, 1)).toBe(0);
  });

  it('a light fighter (1) into a heavy capital (5000) at full speed ≈ the cap', () => {
    expect(ramDamageTo(RAM_SPEED_FULL, 1, 5000)).toBeCloseTo(RAM_DAMAGE_MAX * (4999 / 5001), 6);
  });

  it('a moderate-speed light-into-heavy is disproportionately gentle', () => {
    // self=1, other=3, speed=375 (mid) → 50 × 0.25 × 0.5 = 6.25.
    expect(ramDamageTo(375, 1, 3)).toBeCloseTo(6.25, 9);
  });

  it('never exceeds RAM_DAMAGE_MAX', () => {
    expect(ramDamageTo(10_000, 1, 1e9)).toBeLessThanOrEqual(RAM_DAMAGE_MAX);
  });
});

describe('aggregateRamming', () => {
  it('one contact ⇒ one pair with that force', () => {
    const out = aggregateRamming([mk('a', 'b', 1000)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.force).toBe(1000);
    expect(out[0]).toMatchObject({ aId: 'a', bId: 'b' });
  });

  it('SUMS N same-pair sub-events (the compound-collider case) — never multiplies', () => {
    // A hull polygon = N triangle colliders ⇒ one ram emits N sub-events
    // sharing {a,b}. Force comes from the SUM (for the impulse/broadcast);
    // impactSpeed + masses are per-PAIR, shared by every sub-event, so the
    // asymmetric damage is computed ONCE from them, never N-multiplied.
    const out = aggregateRamming([
      mk('a', 'b', 400, 1, 2, 3, 4, RAM_SPEED_FULL, 1, 3),
      mk('a', 'b', 500, 1, 2, 3, 4, RAM_SPEED_FULL, 1, 3),
      mk('a', 'b', 300, 1, 2, 3, 4, RAM_SPEED_FULL, 1, 3),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.force).toBe(1200);
    expect(out[0]!.impactSpeed).toBe(RAM_SPEED_FULL);
    // a is the LIGHT body (mass 1 vs 3) → takes 25; b (heavy) → 0.
    expect(out[0]!.damageA).toBeCloseTo(25, 9);
    expect(out[0]!.damageB).toBe(0);
  });

  it('collapses the unordered pair: (a,b) and (b,a) sub-events are one pair', () => {
    const out = aggregateRamming([mk('a', 'b', 500), mk('b', 'a', 700)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.force).toBe(1200);
  });

  it('keeps distinct pairs separate', () => {
    const out = aggregateRamming([mk('a', 'b', 500), mk('c', 'd', 900)]);
    expect(out).toHaveLength(2);
    const byForce = out.map((p) => p.force).sort((x, y) => x - y);
    expect(byForce).toEqual([500, 900]);
  });

  it('representative (ids + post-velocities) is the max-single-force sub-event', () => {
    const out = aggregateRamming([
      mk('a', 'b', 200, 9, 9, 9, 9),
      mk('a', 'b', 800, 1, 2, 3, 4), // max ⇒ representative
      mk('a', 'b', 100, 7, 7, 7, 7),
    ]);
    expect(out[0]!.force).toBe(1100);
    expect(out[0]!.vA).toEqual({ x: 1, y: 2 });
    expect(out[0]!.vB).toEqual({ x: 3, y: 4 });
  });

  it('EQUAL-mass pair deals NO damage even at a huge closing speed (R2.31)', () => {
    const out = aggregateRamming([mk('a', 'b', 5000, 1, 2, 3, 4, 10_000, 5, 5)]);
    expect(out[0]!.damageA).toBe(0);
    expect(out[0]!.damageB).toBe(0);
  });

  it('ASYMMETRIC: a light body into a heavy body — light is crushed, heavy ~0', () => {
    const out = aggregateRamming([mk('light', 'heavy', 5000, 1, 2, 3, 4, RAM_SPEED_FULL, 1, 1000)]);
    // light (self=1, other=1000): 50 × 1 × (999/1001) ≈ 49.9.
    expect(out[0]!.damageA).toBeCloseTo(RAM_DAMAGE_MAX * (999 / 1001), 6);
    // heavy (self=1000, other=1): 0.
    expect(out[0]!.damageB).toBe(0);
  });

  it('SMOKE: a slow bump deals NO damage even with a big mass differential', () => {
    // "a tiny bump on a structure should not be destroying it." 20 u/s is well
    // below the 50 u/s floor → speed factor 0 → 0 damage regardless of mass.
    const bump = aggregateRamming([mk('a', 'b', 20 * FORCE_PER_UNIT_SPEED, 1, 2, 3, 4, 20, 1, 5000)]);
    expect(bump[0]!.damageA).toBe(0);
    expect(bump[0]!.damageB).toBe(0);
  });

  it('uses a force-derived impact speed when the contact has none (legacy/replay)', () => {
    // No measured impactSpeed ⇒ force / FORCE_PER_UNIT_SPEED. Force at 80 u/s,
    // with a mass differential the light side takes damage.
    const out = aggregateRamming([mk('a', 'b', 80 * FORCE_PER_UNIT_SPEED, 1, 2, 3, 4, undefined, 1, 5000)]);
    expect(out[0]!.impactSpeed).toBeCloseTo(80, 9);
    expect(out[0]!.damageA).toBeCloseTo(ramDamageTo(80, 1, 5000), 9);
    expect(out[0]!.damageB).toBe(0);
  });

  it('absent masses ⇒ no differential ⇒ no damage (safe legacy fallback)', () => {
    const out = aggregateRamming([mk('a', 'b', 5000, 1, 2, 3, 4, 10_000)]);
    expect(out[0]!.damageA).toBe(0);
    expect(out[0]!.damageB).toBe(0);
  });

  it('summed force + asymmetric damage are independent of input order (determinism)', () => {
    const a = aggregateRamming([
      mk('a', 'b', 500, 1, 2, 3, 4, RAM_SPEED_FULL, 1, 3),
      mk('c', 'd', 900),
      mk('a', 'b', 400, 1, 2, 3, 4, RAM_SPEED_FULL, 1, 3),
    ]);
    const b = aggregateRamming([
      mk('a', 'b', 400, 1, 2, 3, 4, RAM_SPEED_FULL, 1, 3),
      mk('a', 'b', 500, 1, 2, 3, 4, RAM_SPEED_FULL, 1, 3),
      mk('c', 'd', 900),
    ]);
    const norm = (ps: ReturnType<typeof aggregateRamming>) =>
      ps
        .map((p) => `${[p.aId, p.bId].sort().join(',')}:${p.force}:${p.damageA.toFixed(4)}:${p.damageB.toFixed(4)}`)
        .sort();
    expect(norm(a)).toEqual(norm(b));
  });

  it('empty input ⇒ no pairs', () => {
    expect(aggregateRamming([])).toEqual([]);
  });
});
