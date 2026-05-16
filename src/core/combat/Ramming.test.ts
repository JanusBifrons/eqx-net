import { describe, it, expect } from 'vitest';
import {
  aggregateRamming,
  RAM_FORCE_FLOOR,
  RAM_DAMAGE_SCALE,
  RAM_DAMAGE_MAX,
} from './Ramming.js';
import type { Contact } from '../physics/contactDrain.js';

function mk(aId: string, bId: string, force: number, vax = 1, vay = 2, vbx = 3, vby = 4): Contact {
  return { aId, bId, vAxPost: vax, vAyPost: vay, vBxPost: vbx, vByPost: vby, forceMagnitude: force };
}

describe('aggregateRamming', () => {
  it('one contact ⇒ one pair with that force', () => {
    const out = aggregateRamming([mk('a', 'b', 1000)]);
    expect(out).toHaveLength(1);
    expect(out[0]!.force).toBe(1000);
    expect(out[0]).toMatchObject({ aId: 'a', bId: 'b' });
  });

  it('SUMS N same-pair sub-events (the compound-collider case) — never multiplies', () => {
    // A hull polygon = N triangle colliders ⇒ one ram emits N sub-events
    // sharing {a,b}. Damage must come from the SUM, applied once.
    const out = aggregateRamming([
      mk('a', 'b', 400),
      mk('a', 'b', 500),
      mk('a', 'b', 300),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.force).toBe(1200);
    // NOT 3 separate pairs, NOT 3x damage.
    const expected = Math.min(RAM_DAMAGE_MAX, (1200 - RAM_FORCE_FLOOR) * RAM_DAMAGE_SCALE);
    expect(out[0]!.damage).toBeCloseTo(expected, 9);
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

  it('damage curve: below floor ⇒ 0, scaled above, capped at RAM_DAMAGE_MAX', () => {
    expect(aggregateRamming([mk('a', 'b', RAM_FORCE_FLOOR - 1)])[0]!.damage).toBe(0);
    expect(aggregateRamming([mk('a', 'b', RAM_FORCE_FLOOR)])[0]!.damage).toBe(0);
    const mid = RAM_FORCE_FLOOR + 1000;
    expect(aggregateRamming([mk('a', 'b', mid)])[0]!.damage).toBeCloseTo(1000 * RAM_DAMAGE_SCALE, 9);
    // Force huge ⇒ clamps at the per-pair-per-tick cap.
    expect(aggregateRamming([mk('a', 'b', 10_000_000)])[0]!.damage).toBe(RAM_DAMAGE_MAX);
  });

  it('sub-floor splitting is rescued by aggregation', () => {
    // 3 sub-events of 150 N each are INDIVIDUALLY below the 300 floor, but
    // their sum (450) clears it — the bug this aggregation exists to fix.
    const split = aggregateRamming([mk('a', 'b', 150), mk('a', 'b', 150), mk('a', 'b', 150)]);
    expect(split[0]!.force).toBe(450);
    expect(split[0]!.damage).toBeCloseTo((450 - RAM_FORCE_FLOOR) * RAM_DAMAGE_SCALE, 9);
    expect(split[0]!.damage).toBeGreaterThan(0);
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
