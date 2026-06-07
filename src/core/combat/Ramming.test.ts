import { describe, it, expect } from 'vitest';
import {
  aggregateRamming,
  ramDamageFromImpactSpeed,
  RAM_MIN_IMPACT_SPEED,
  RAM_DAMAGE_PER_SPEED,
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
  };
}

describe('ramDamageFromImpactSpeed', () => {
  it('is exactly 0 at or below RAM_MIN_IMPACT_SPEED — a tiny bump is free', () => {
    expect(ramDamageFromImpactSpeed(0)).toBe(0);
    expect(ramDamageFromImpactSpeed(RAM_MIN_IMPACT_SPEED - 1)).toBe(0);
    expect(ramDamageFromImpactSpeed(RAM_MIN_IMPACT_SPEED)).toBe(0);
  });

  it('ramps linearly above the floor, then clamps at RAM_DAMAGE_MAX', () => {
    const justAbove = RAM_MIN_IMPACT_SPEED + 10;
    expect(ramDamageFromImpactSpeed(justAbove)).toBeCloseTo(10 * RAM_DAMAGE_PER_SPEED, 9);
    // A brutal closing speed clamps at the per-pair-per-tick cap.
    expect(ramDamageFromImpactSpeed(10_000)).toBe(RAM_DAMAGE_MAX);
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
    // impactSpeed is a per-PAIR property (the bodies' closing speed) shared by
    // every sub-event, so damage is computed ONCE from it, never N-multiplied.
    const out = aggregateRamming([
      mk('a', 'b', 400, 1, 2, 3, 4, 120),
      mk('a', 'b', 500, 1, 2, 3, 4, 120),
      mk('a', 'b', 300, 1, 2, 3, 4, 120),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.force).toBe(1200);
    expect(out[0]!.impactSpeed).toBe(120);
    // Damage = the single per-pair impact speed through the curve, NOT 3×.
    expect(out[0]!.damage).toBeCloseTo(ramDamageFromImpactSpeed(120), 9);
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

  it('damage is gated on MEASURED impact speed: below floor ⇒ 0, above ⇒ ramps, capped', () => {
    const slow = aggregateRamming([mk('a', 'b', 5000, 1, 2, 3, 4, RAM_MIN_IMPACT_SPEED - 5)]);
    expect(slow[0]!.damage).toBe(0); // 0 even with a big force, because slow
    const mid = aggregateRamming([mk('a', 'b', 5000, 1, 2, 3, 4, RAM_MIN_IMPACT_SPEED + 30)]);
    expect(mid[0]!.damage).toBeCloseTo(30 * RAM_DAMAGE_PER_SPEED, 9);
    const brutal = aggregateRamming([mk('a', 'b', 5000, 1, 2, 3, 4, 100_000)]);
    expect(brutal[0]!.damage).toBe(RAM_DAMAGE_MAX);
  });

  it('SMOKE 2026-06-07: a slow bump deals NO damage even though it clears the OLD force floor', () => {
    // The reported bug: "a tiny bump on a structure should not be destroying
    // it." A 20 u/s drift is well below the 50 u/s gate → 0 damage, even though
    // its force (1200 N) sailed past the OLD 300 N force floor (which would have
    // dealt 10.8 HP/tick). A genuine ~200 u/s ram still bites.
    const bumpSpeed = 20;
    const bump = aggregateRamming([
      mk('a', 'b', bumpSpeed * FORCE_PER_UNIT_SPEED, 1, 2, 3, 4, bumpSpeed),
    ]);
    expect(bump[0]!.damage).toBe(0);
    const ramSpeed = 200;
    const ram = aggregateRamming([
      mk('a', 'b', ramSpeed * FORCE_PER_UNIT_SPEED, 1, 2, 3, 4, ramSpeed),
    ]);
    expect(ram[0]!.damage).toBeGreaterThan(0);
  });

  it('falls back to a force-derived impact speed when the contact has none (legacy/replay)', () => {
    // No measured impactSpeed ⇒ force / FORCE_PER_UNIT_SPEED. Force 4800 N ⇒
    // 80 u/s ⇒ above the 50 floor ⇒ damage > 0.
    const out = aggregateRamming([mk('a', 'b', 80 * FORCE_PER_UNIT_SPEED)]);
    expect(out[0]!.impactSpeed).toBeCloseTo(80, 9);
    expect(out[0]!.damage).toBeCloseTo(ramDamageFromImpactSpeed(80), 9);
  });

  it('summed force + damage are independent of input order (determinism)', () => {
    const a = aggregateRamming([mk('a', 'b', 500), mk('c', 'd', 900), mk('a', 'b', 400)]);
    const b = aggregateRamming([mk('a', 'b', 400), mk('a', 'b', 500), mk('c', 'd', 900)]);
    const norm = (ps: ReturnType<typeof aggregateRamming>) =>
      ps
        .map((p) => `${[p.aId, p.bId].sort().join(',')}:${p.force}:${p.damage}`)
        .sort();
    expect(norm(a)).toEqual(norm(b));
  });

  it('empty input ⇒ no pairs', () => {
    expect(aggregateRamming([])).toEqual([]);
  });
});
