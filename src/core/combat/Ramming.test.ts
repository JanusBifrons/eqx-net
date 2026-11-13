/**
 * Locks the SHAPE of the impact-based ramming model (owner decision
 * 2026-11-13, "ramming as a weapon"), which replaced the 2026-06-12
 * mass-differential model. The old tests locked "equal masses ⇒ 0" and
 * "the heavier body takes 0" — exactly what the owner rejected — so they were
 * rewritten, not kept. Locked now: damage is driven by the closing speed
 * ALONG THE CONTACT NORMAL (head-on > glancing, monotone in angle), shared by
 * weight (equal ⇒ equal, lighter ⇒ more), free below the floor, monotone in
 * speed, capped, and computed once per pair per tick.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateRamming,
  ramImpactEnergy,
  ramShareTo,
  ramDamageTo,
  RAM_MIN_IMPACT_SPEED,
  RAM_DAMAGE_MAX,
  FORCE_PER_UNIT_SPEED,
} from './Ramming.js';
import type { Contact } from '../physics/contactDrain.js';

/** 2× default ship scale: every gameplay fighter-class kind is mass 8 with a
 *  ~601 u/s top speed and 150 shield + 150 hull. */
const FIGHTER_MASS = 8;
const FIGHTER_TOP_SPEED = 601;
const FIGHTER_POOL = 300;
const DESTROYER_MASS = 400;

function mk(
  aId: string,
  bId: string,
  force: number,
  opts: { impactSpeed?: number; normalSpeed?: number; aMass?: number; bMass?: number; v?: [number, number, number, number] } = {},
): Contact {
  const [vax, vay, vbx, vby] = opts.v ?? [1, 2, 3, 4];
  return {
    aId,
    bId,
    vAxPost: vax,
    vAyPost: vay,
    vBxPost: vbx,
    vByPost: vby,
    forceMagnitude: force,
    impactSpeed: opts.impactSpeed,
    normalSpeed: opts.normalSpeed,
    aMass: opts.aMass,
    bMass: opts.bMass,
  };
}

const headOn = 2 * FIGHTER_TOP_SPEED;
const glancing = (deg: number): number => headOn * Math.sin((deg * Math.PI) / 180);

describe('ramImpactEnergy (½·μ·(vN − floor)²)', () => {
  it('is 0 at or below the floor — a slow bump is free', () => {
    expect(ramImpactEnergy(0, 8, 8)).toBe(0);
    expect(ramImpactEnergy(RAM_MIN_IMPACT_SPEED, 8, 8)).toBe(0);
  });

  it('uses the reduced mass and the over-floor speed squared (hand-derived)', () => {
    // μ = 8·8/16 = 4; over = 150 − 50 = 100 ⇒ ½·4·100² = 20 000.
    expect(ramImpactEnergy(150, 8, 8)).toBeCloseTo(20_000, 6);
  });

  it('absent / zero mass ⇒ 0 (safe legacy fallback)', () => {
    expect(ramImpactEnergy(1000, 0, 8)).toBe(0);
    expect(ramImpactEnergy(1000, 8, 0)).toBe(0);
  });
});

describe('ramShareTo (weight split)', () => {
  it('equal masses split 50/50', () => {
    expect(ramShareTo(8, 8)).toBe(0.5);
  });
  it('the lighter body always takes more; the two shares sum to 1', () => {
    expect(ramShareTo(8, 400)).toBeGreaterThan(ramShareTo(400, 8));
    expect(ramShareTo(8, 400) + ramShareTo(400, 8)).toBeCloseTo(1, 12);
  });
});

describe('ramDamageTo (impact-based)', () => {
  it('a full-speed fighter head-on removes a BIG chunk from BOTH fighters, equally (40-60 % of the pool)', () => {
    const d = ramDamageTo(headOn, FIGHTER_MASS, FIGHTER_MASS);
    expect(d).toBeGreaterThan(0.4 * FIGHTER_POOL);
    expect(d).toBeLessThan(0.6 * FIGHTER_POOL);
    expect(ramDamageTo(headOn, FIGHTER_MASS, FIGHTER_MASS)).toBe(d); // symmetric
  });

  it('a glancing 20° scrape at the same speed deals < 15 % of the head-on', () => {
    expect(ramDamageTo(glancing(20), 8, 8)).toBeLessThan(0.15 * ramDamageTo(headOn, 8, 8));
  });

  it('is monotone in the angle of attack (shallower ⇒ less)', () => {
    let prev = -1;
    for (const deg of [5, 10, 20, 30, 45, 60, 75, 90]) {
      const d = ramDamageTo(glancing(deg), 8, 8);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('is monotone in normal speed', () => {
    let prev = -1;
    for (let v = 0; v <= 2000; v += 50) {
      const d = ramDamageTo(v, 8, 8);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });

  it('a bump below the floor deals 0, whatever the masses', () => {
    expect(ramDamageTo(RAM_MIN_IMPACT_SPEED - 1, 8, 8)).toBe(0);
    expect(ramDamageTo(RAM_MIN_IMPACT_SPEED, 8, 1e6)).toBe(0);
  });

  it('a fighter into a parked capital at full speed: the fighter takes a big chunk, the capital a scratch', () => {
    const fighter = ramDamageTo(FIGHTER_TOP_SPEED, FIGHTER_MASS, DESTROYER_MASS);
    const capital = ramDamageTo(FIGHTER_TOP_SPEED, DESTROYER_MASS, FIGHTER_MASS);
    expect(fighter).toBeGreaterThan(0.4 * FIGHTER_POOL);
    expect(capital).toBeLessThan(0.05 * fighter);
  });

  it('an ONCOMING capital adds its speed and nearly crushes the fighter', () => {
    expect(ramDamageTo(FIGHTER_TOP_SPEED + 184, FIGHTER_MASS, DESTROYER_MASS)).toBeGreaterThan(0.8 * FIGHTER_POOL);
  });

  it('never exceeds RAM_DAMAGE_MAX', () => {
    expect(ramDamageTo(10_000, 1e6, 1e6)).toBe(RAM_DAMAGE_MAX);
    expect(ramDamageTo(10_000, 8, 1e9)).toBeLessThanOrEqual(RAM_DAMAGE_MAX);
  });
});

describe('aggregateRamming', () => {
  it('one contact ⇒ one pair with that force', () => {
    const out = aggregateRamming([mk('a', 'b', 1000)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.force).toBe(1000);
    expect(out[0]).toMatchObject({ aId: 'a', bId: 'b' });
  });

  it('N same-pair sub-events (compound hull) ⇒ ONE damage, from the MAX normal speed — never multiplied', () => {
    const subs = [
      mk('a', 'b', 400, { impactSpeed: headOn, normalSpeed: 900, aMass: 8, bMass: 8 }),
      mk('a', 'b', 500, { impactSpeed: headOn, normalSpeed: headOn, aMass: 8, bMass: 8 }),
      mk('b', 'a', 300, { impactSpeed: headOn, normalSpeed: 400, aMass: 8, bMass: 8 }),
    ];
    const out = aggregateRamming(subs);
    expect(out).toHaveLength(1);
    expect(out[0]!.force).toBe(1200);
    expect(out[0]!.normalSpeed).toBe(headOn);
    expect(out[0]!.damageA).toBeCloseTo(ramDamageTo(headOn, 8, 8), 9);
    expect(out[0]!.damageB).toBeCloseTo(ramDamageTo(headOn, 8, 8), 9);
  });

  it('equal-mass pair: BOTH sides damaged, equally', () => {
    const out = aggregateRamming([mk('a', 'b', 5000, { impactSpeed: headOn, normalSpeed: headOn, aMass: 8, bMass: 8 })]);
    expect(out[0]!.damageA).toBeGreaterThan(0);
    expect(out[0]!.damageA).toBe(out[0]!.damageB);
  });

  it('the lighter side takes more', () => {
    const out = aggregateRamming([mk('light', 'heavy', 5000, { normalSpeed: 600, aMass: 8, bMass: 400 })]);
    expect(out[0]!.damageA).toBeGreaterThan(out[0]!.damageB);
    expect(out[0]!.damageB).toBeGreaterThan(0);
  });

  it('a glancing contact (small normalSpeed, big impactSpeed) deals far less than head-on', () => {
    const scrape = aggregateRamming([mk('a', 'b', 5000, { impactSpeed: headOn, normalSpeed: glancing(20), aMass: 8, bMass: 8 })]);
    const hit = aggregateRamming([mk('a', 'b', 5000, { impactSpeed: headOn, normalSpeed: headOn, aMass: 8, bMass: 8 })]);
    expect(scrape[0]!.damageA).toBeLessThan(0.15 * hit[0]!.damageA);
  });

  it('collapses the unordered pair: (a,b) and (b,a) sub-events are one pair', () => {
    const out = aggregateRamming([mk('a', 'b', 500), mk('b', 'a', 700)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.force).toBe(1200);
  });

  it('keeps distinct pairs separate', () => {
    const out = aggregateRamming([mk('a', 'b', 500), mk('c', 'd', 900)]);
    expect(out.map((p) => p.force).sort((x, y) => x - y)).toEqual([500, 900]);
  });

  it('representative (ids + post-velocities) is the max-single-force sub-event', () => {
    const out = aggregateRamming([
      mk('a', 'b', 200, { v: [9, 9, 9, 9] }),
      mk('a', 'b', 800, { v: [1, 2, 3, 4] }),
      mk('a', 'b', 100, { v: [7, 7, 7, 7] }),
    ]);
    expect(out[0]!.force).toBe(1100);
    expect(out[0]!.vA).toEqual({ x: 1, y: 2 });
    expect(out[0]!.vB).toEqual({ x: 3, y: 4 });
  });

  it('a slow bump deals NO damage', () => {
    const out = aggregateRamming([mk('a', 'b', 20 * FORCE_PER_UNIT_SPEED, { impactSpeed: 20, normalSpeed: 20, aMass: 8, bMass: 5000 })]);
    expect(out[0]!.damageA).toBe(0);
    expect(out[0]!.damageB).toBe(0);
  });

  it('falls back normalSpeed → impactSpeed → force-derived speed (legacy/replay)', () => {
    const noNormal = aggregateRamming([mk('a', 'b', 1, { impactSpeed: 300, aMass: 8, bMass: 8 })]);
    expect(noNormal[0]!.normalSpeed).toBe(300);
    const forceOnly = aggregateRamming([mk('a', 'b', 300 * FORCE_PER_UNIT_SPEED, { aMass: 8, bMass: 8 })]);
    expect(forceOnly[0]!.impactSpeed).toBeCloseTo(300, 9);
    expect(forceOnly[0]!.damageA).toBeCloseTo(ramDamageTo(300, 8, 8), 9);
  });

  it('absent masses ⇒ no damage (safe legacy fallback)', () => {
    const out = aggregateRamming([mk('a', 'b', 5000, { impactSpeed: 10_000, normalSpeed: 10_000 })]);
    expect(out[0]!.damageA).toBe(0);
    expect(out[0]!.damageB).toBe(0);
  });

  it('results are independent of input order (determinism)', () => {
    const x = mk('a', 'b', 500, { normalSpeed: 700, aMass: 8, bMass: 30 });
    const y = mk('a', 'b', 400, { normalSpeed: 900, aMass: 8, bMass: 30 });
    const z = mk('c', 'd', 900);
    const norm = (ps: ReturnType<typeof aggregateRamming>) =>
      ps.map((p) => `${[p.aId, p.bId].sort().join(',')}:${p.force}:${p.normalSpeed}:${p.damageA.toFixed(4)}:${p.damageB.toFixed(4)}`).sort();
    expect(norm(aggregateRamming([x, z, y]))).toEqual(norm(aggregateRamming([y, x, z])));
  });

  it('empty input ⇒ no pairs', () => {
    expect(aggregateRamming([])).toEqual([]);
  });
});
