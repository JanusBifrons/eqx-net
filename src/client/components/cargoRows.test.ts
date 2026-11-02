import { describe, expect, it } from 'vitest';
import { cargoRows } from './cargoRows';
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
