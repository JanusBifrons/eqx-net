/**
 * Ship livery: every capital wears two deck sigils under the shipping default
 * ('b8'). Every capital, no sampling: each hull's deck decides whether two
 * sigils fit. Its own file (a capital forge at 6x is ~2 s, the slowest lock),
 * so vitest runs it on its own worker. Split from fields.livery.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { getShipKind } from '../../../shared-types/shipKinds.js';
import { sizeClassOf } from '../../../shared-types/shipScale/tuning.js';
import { turretCoverOf } from './bake.js';
import { shipTurrets } from './turretLayout.js';
import { CAPITALS, forged, ppuFor } from './liveryTestKit.js';

describe("capital sigils under the default 'b8'", () => {
  const TEAM = 0x4fd0e8;
  const isCap = (id: string): boolean => sizeClassOf(getShipKind(id)) === 'capital';
  const ppuS = (id: string): number => (isCap(id) ? ppuFor(id) * 6 : ppuFor(id));
  const ringsOf = (id: string): Array<{ x: number; y: number; r: number }> => shipTurrets(id).map((t) => ({ x: t.px, y: t.py, r: t.ring }));

  for (const treatment of ['b8'] as const) {
    it.each(CAPITALS)(`%s: two deck sigils under '${treatment}'`, (id) => {
      const f = forged(id, { ppu: ppuS(id), livery: { treatment, team: TEAM, sigil: 0x1a2b3c }, rings: ringsOf(id), turretCover: turretCoverOf(id) });
      expect((f.sigils ?? []).map((m) => m.kind)).toEqual(['sigil', 'sigil']);
    });
  }
});
