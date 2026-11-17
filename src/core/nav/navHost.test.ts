import { describe, it, expect } from 'vitest';
import { NavHost } from './navHost.js';
import { CoarseFieldMap } from './coarseField.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import type { ChunkOpts } from '../terrain/fieldLayout.js';

const opts = (seed: string): ChunkOpts => ({
  seed, battleshipLength: getShipKind('battleship').radius * 2, fighterLength: getShipKind('fighter').radius * 2,
});

describe('NavHost (nav worker commands)', () => {
  it('ADD_FIELD builds the same coarse layer as building it directly, per world', () => {
    let t = 0;
    const host = new NavHost(() => (t += 5));
    const reply = host.handle({ type: 'ADD_FIELD', worldId: 7, opts: opts('look') });
    const direct = new CoarseFieldMap();
    direct.build(opts('look'));
    expect(reply).toEqual({
      type: 'FIELD_BUILT', worldId: 7, cols: direct.cols, rows: direct.rows,
      bytes: direct.room.byteLength * 3, ms: 5,
    });
    expect(host.coarse(7)!.room).toEqual(direct.room);
    host.handle({ type: 'ADD_FIELD', worldId: 8, opts: opts('far-zoom') });
    expect(host.fieldCount).toBe(2);
    expect(host.coarse(8)!.room).not.toEqual(direct.room);
  });

  it('REMOVE_FIELD frees a world and replies nothing', () => {
    const host = new NavHost(() => 0);
    host.handle({ type: 'ADD_FIELD', worldId: 1, opts: opts('look') });
    expect(host.handle({ type: 'REMOVE_FIELD', worldId: 1 })).toBeNull();
    expect(host.coarse(1)).toBeUndefined();
    expect(host.fieldCount).toBe(0);
  });
});
