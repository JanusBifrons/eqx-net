import { describe, it, expect } from 'vitest';
import { searchView, clampRequest, REVEAL_MS } from './lootSearch.js';
import type { Hold } from '../../shared-types/goods.js';

// salvage (tier 0, 0.5 s), alloy (tier 1, 1 s), core (tier 2, 2 s), one blueprint (2 s).
const pod = (): Hold => ({ goods: { salvage: 4, alloy: 2, core: 1 }, blueprints: [{ uid: 'bp-1' } as Hold['blueprints'][number]] });

describe('loot window search (cargo-pods slice 12)', () => {
  it('reveals stacks one by one in grid order, each after its rarity time', () => {
    expect(REVEAL_MS).toEqual([500, 1000, 2000]);
    const at0 = searchView(pod(), 0);
    expect(at0.revealed.goods).toEqual({});
    expect(at0.hidden).toBe(4);
    expect(at0.nextInMs).toBe(500);

    const at500 = searchView(pod(), 500);
    expect(at500.revealed.goods).toEqual({ salvage: 4 });
    expect(at500.hidden).toBe(3);
    expect(at500.nextInMs).toBe(1000);

    const at1600 = searchView(pod(), 1600);
    expect(at1600.revealed.goods).toEqual({ salvage: 4, alloy: 2 });
    expect(at1600.nextInMs).toBe(1900); // core due at 3500

    const all = searchView(pod(), 5500);
    expect(all.revealed.goods).toEqual({ salvage: 4, alloy: 2, core: 1 });
    expect(all.revealed.blueprints.map((b) => b.uid)).toEqual(['bp-1']);
    expect(all.hidden).toBe(0);
    expect(all.nextInMs).toBe(0);
  });

  it('a stack taken out never hides one already found', () => {
    const h = pod();
    const before = searchView(h, 1500);
    delete h.goods.salvage;
    const after = searchView(h, 1500);
    for (const id of Object.keys(before.revealed.goods)) {
      if (id !== 'salvage') expect(after.revealed.goods).toHaveProperty(id);
    }
  });

  it('clampRequest only lets found stacks be taken', () => {
    const seen = searchView(pod(), 500).revealed;
    expect(clampRequest(seen, { goods: { salvage: 9, core: 1 }, blueprints: ['bp-1'] })).toEqual({ goods: { salvage: 4 } });
  });

  it('clampRequest keeps a found rock chunk by its uid (takePacked matches a chunk only by uid)', () => {
    const h: Hold = { goods: {}, blueprints: [], packed: [{ product: 'chunk:rock', quality: 0, uid: 'rc-1', weight: 400, ore: {} }] };
    expect(clampRequest(h, { goods: {}, packed: ['rc-1'] })).toEqual({ goods: {}, packed: ['rc-1'] });
  });
});
