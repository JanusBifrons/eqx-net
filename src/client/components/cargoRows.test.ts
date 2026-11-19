import { describe, expect, it } from 'vitest';
import { cargoRows, rowHold } from './cargoRows';
import type { Hold } from '../../shared-types/goods';

describe('cargoRows (C1 cargo panel)', () => {
  it('lists goods, packed items and blueprints by name with one/all requests', () => {
    const hold: Hold = {
      goods: { alloy: 20, minerals: 5 },
      blueprints: [{ uid: 'bp-1', product: 'structure:smelter', kind: 'bpc', runs: 3, material: 0, output: 0, research: 0 }],
      packed: [{ product: 'structure:smelter', quality: 50 }, { product: 'structure:smelter', quality: 70 }],
    };
    const rows = cargoRows(hold);
    expect(rows.map((r) => r.key)).toEqual(['g:minerals', 'g:alloy', 'p:structure:smelter', 'b:bp-1']);
    const alloy = rows.find((r) => r.key === 'g:alloy')!;
    expect(alloy.label).toBe('Alloy');
    expect(alloy.count).toBe(20);
    expect(alloy.one).toEqual({ goods: { alloy: 1 } });
    expect(alloy.all).toEqual({ goods: { alloy: 20 } });
    const packed = rows.find((r) => r.key === 'p:structure:smelter')!;
    expect(packed.label).toBe('Smelter (packed)');
    expect(packed.all).toEqual({ packed: ['structure:smelter', 'structure:smelter'] });
    const bp = rows.find((r) => r.key === 'b:bp-1')!;
    expect(bp.label).toBe('Smelter blueprint (3 runs)');
    expect(bp.label).not.toContain('bp-1'); // names only, never ids
  });

  it('is empty for a missing or empty hold', () => {
    expect(cargoRows(null)).toEqual([]);
    expect(cargoRows({ goods: {}, blueprints: [] })).toEqual([]);
  });
});

describe('cargoRows: rock chunks', () => {
  it('each chunk is its own tile, named "Rock chunk", moved by its uid, never its ore', () => {
    const hold: Hold = {
      goods: {}, blueprints: [],
      packed: [
        { product: 'chunk:rock', quality: 0, uid: 'rc-1', weight: 250 },
        { product: 'chunk:rock', quality: 0, uid: 'rc-2', weight: 1000 },
      ],
    };
    const rows = cargoRows(hold);
    expect(rows.map((r) => r.key)).toEqual(['u:rc-1', 'u:rc-2']);
    expect(rows[1]!.label).toBe('Rock chunk');
    expect(rows[1]!.count).toBe(1);
    expect(rows[1]!.one).toEqual({ packed: ['rc-2'] });
    expect(rowHold(hold, rows[1]!).packed).toEqual([hold.packed![1]]);
  });
});
