import { describe, expect, it } from 'vitest';
import { emptyHold, holdBestTier, holdWeight, isHoldEmpty, mergeInto, transferInto, transferUpTo } from './hold.js';
import { legacyHoldCredits, parseHoldJson, type Hold } from '../../shared-types/goods.js';
import { rollKillBounty, rollLoot } from '../../shared-types/lootTables.js';

function h(goods: Hold['goods'], blueprints: string[] = []): Hold {
  return { goods: { ...goods }, blueprints: [...blueprints] };
}

/** Total units of value across two holds — must be invariant under transfer. */
function total(a: Hold, b: Hold): string {
  const sum: Record<string, number> = {};
  for (const x of [a, b]) for (const [k, v] of Object.entries(x.goods)) sum[k] = (sum[k] ?? 0) + (v ?? 0);
  const sorted = Object.keys(sum).sort().map((k) => `${k}:${sum[k]}`).join(',');
  return `${sorted}|bp=${a.blueprints.length + b.blueprints.length}`;
}

describe('hold arithmetic (P1a-1)', () => {
  it('weight counts goods only; blueprints are weightless', () => {
    expect(holdWeight(h({ salvage: 10, alloy: 2 }, ['bp-1']))).toBe(10 + 4);
  });

  it('transfer CONSERVES value exactly (nothing copied, nothing lost)', () => {
    const dst = h({ salvage: 5 });
    const src = h({ salvage: 30, alloy: 4, core: 1 }, ['bp-x']);
    const before = total(dst, src);
    transferInto(dst, src, 25);
    expect(total(dst, src)).toBe(before);
  });

  it('respects capacity, moving the highest tier first', () => {
    const dst = emptyHold();
    const src = h({ salvage: 10, core: 2 });
    const r = transferInto(dst, src, 12); // core = 5 each → 2 cores (10) + 2 salvage
    expect(dst.goods.core).toBe(2);
    expect(dst.goods.salvage).toBe(2);
    expect(src.goods.salvage).toBe(8);
    expect(r.srcEmptied).toBe(false);
    expect(holdWeight(dst)).toBeLessThanOrEqual(12);
  });

  it('a full hold still takes blueprints (weightless)', () => {
    const dst = h({ salvage: 50 });
    const src = h({ salvage: 5 }, ['bp-1']);
    transferInto(dst, src, 50);
    expect(dst.blueprints).toEqual(['bp-1']);
    expect(src.goods.salvage).toBe(5);
  });

  it('transferUpTo bounds a single step', () => {
    const dst = emptyHold();
    const src = h({ salvage: 100 });
    transferUpTo(dst, src, 1000, 7);
    expect(dst.goods.salvage).toBe(7);
  });

  it('mergeInto empties the source', () => {
    const dst = h({ alloy: 1 });
    const src = h({ alloy: 3, salvage: 9 });
    mergeInto(dst, src);
    expect(isHoldEmpty(src)).toBe(true);
    expect(dst.goods.alloy).toBe(4);
  });

  it('best tier: blueprint/core gold, alloy blue, salvage grey', () => {
    expect(holdBestTier(h({ salvage: 1 }))).toBe(0);
    expect(holdBestTier(h({ alloy: 1 }))).toBe(1);
    expect(holdBestTier(h({ core: 1 }))).toBe(2);
    expect(holdBestTier(h({}, ['bp']))).toBe(2);
  });

  it('parseHoldJson is defensive: corrupt / negative / unknown ⇒ empty', () => {
    expect(parseHoldJson('not json')).toEqual(emptyHold());
    expect(parseHoldJson('{"goods":{"salvage":-3},"credits":0,"blueprints":[]}')).toEqual(emptyHold());
    expect(parseHoldJson('{"goods":{"salvage":3},"credits":2,"blueprints":[]}').goods.salvage).toBe(3);
  });

  it('economy v2 W1 — a pre-wallet row keeps its goods; its credits are readable once for migration, never parsed into the hold', () => {
    const json = '{"goods":{"alloy":4},"credits":250,"blueprints":[]}';
    const held = parseHoldJson(json);
    expect(held).toEqual({ goods: { alloy: 4 }, blueprints: [] });
    expect('credits' in held).toBe(false);
    expect(legacyHoldCredits(json)).toBe(250);
    expect(legacyHoldCredits('{"goods":{},"blueprints":[]}')).toBe(0);
    expect(legacyHoldCredits('garbage')).toBe(0);
  });

  it('rollLoot is deterministic for a seeded rng and never negative', () => {
    let s = 1;
    const rng = () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
    const a = rollLoot('robot-square', rng);
    expect('credits' in a).toBe(false);
    expect(a.goods.salvage).toBeGreaterThanOrEqual(4);
    // Credits are the separate kill BOUNTY (paid to the killer's wallet).
    const b = rollKillBounty('robot-square', rng);
    expect(b).toBeGreaterThanOrEqual(8);
    expect(b).toBeLessThanOrEqual(20);
    s = 1;
    expect(rollLoot('robot-square', rng)).toEqual(a);
  });
});
