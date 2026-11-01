import { describe, expect, it } from 'vitest';
import { addPacked, emptyHold, extractRequested, holdBestTier, holdWeight, isHoldEmpty, mergeInto, packedCount, packedWeightOf, takePacked, transferInto, transferUpTo } from './hold.js';
import { legacyHoldCredits, parseHoldJson, type Hold } from '../../shared-types/goods.js';
import { legacyBlueprintItem } from '../../shared-types/items.js';
import { rollKillBounty, rollLoot } from '../../shared-types/lootTables.js';

function h(goods: Hold['goods'], blueprints: string[] = []): Hold {
  return { goods: { ...goods }, blueprints: blueprints.map(legacyBlueprintItem) };
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
    expect(dst.blueprints.map((b) => b.product)).toEqual(['module:bp-1']);
    expect(src.goods.salvage).toBe(5);
  });

  it('W2 — packed items weigh, move whole when they fit, and come back by best quality', () => {
    const src = h({});
    addPacked(src, 'structure:smelter', 30);
    addPacked(src, 'structure:smelter', 80);
    addPacked(src, 'hull:gunship', 50);
    const sw = packedWeightOf('structure:smelter');
    expect(holdWeight(src)).toBe(2 * sw + packedWeightOf('hull:gunship'));
    expect(isHoldEmpty(src)).toBe(false);
    // Room for exactly the two structures: the hull stays behind.
    const dst = emptyHold();
    transferInto(dst, src, 2 * sw);
    expect(packedCount(dst, 'structure:smelter')).toBe(2);
    expect(packedCount(src, 'hull:gunship')).toBe(1);
    expect(takePacked(dst, 'structure:smelter')!.quality).toBe(80);
    expect(takePacked(dst, 'structure:smelter')!.quality).toBe(30);
    expect(takePacked(dst, 'structure:smelter')).toBeNull();
    expect(dst.packed).toBeUndefined();
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

describe('extractRequested (C1 cargo transfer)', () => {
  function stocked(): Hold {
    const h: Hold = { goods: { alloy: 10, ice: 4 }, blueprints: [legacyBlueprintItem('a'), legacyBlueprintItem('b')] };
    addPacked(h, 'structure:smelter', 60);
    addPacked(h, 'structure:smelter', 90);
    return h;
  }

  it('takes exactly what was asked, clamped to what is there', () => {
    const src = stocked();
    const [bpA, bpB] = src.blueprints.map((b) => b.uid);
    const out = extractRequested(src, { goods: { alloy: 3, ice: 99, fuel: 5 }, blueprints: [bpB!, 'missing'], packed: ['structure:smelter'] });
    expect(out.goods).toEqual({ alloy: 3, ice: 4 });
    expect(out.blueprints.map((b) => b.uid)).toEqual([bpB]);
    expect(out.packed).toEqual([{ product: 'structure:smelter', quality: 90 }]);
    expect(src.goods).toEqual({ alloy: 7 });
    expect(src.blueprints.map((b) => b.uid)).toEqual([bpA]);
    expect(packedCount(src, 'structure:smelter')).toBe(1);
  });

  it('conserves value through a capacity-limited move (leftover goes back)', () => {
    const src = stocked();
    const before = holdWeight(src);
    const picked = extractRequested(src, { goods: { alloy: 10 } });
    const dst = emptyHold();
    transferInto(dst, picked, 6); // alloy weighs 2: room for only 3 of the 10
    mergeInto(src, picked);
    expect(holdWeight(dst) + holdWeight(src)).toBeCloseTo(before, 9);
    expect((dst.goods.alloy ?? 0) + (src.goods.alloy ?? 0)).toBe(10);
  });

  it('ignores zero, negative and fractional junk counts safely', () => {
    const src = stocked();
    const out = extractRequested(src, { goods: { alloy: 0, ice: -2 } });
    expect(isHoldEmpty(out)).toBe(true);
    expect(extractRequested(src, { goods: { alloy: 2.9 } }).goods).toEqual({ alloy: 2 });
  });
});
