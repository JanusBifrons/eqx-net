/**
 * Galaxy map 0c — the picker lists one sigil per emblem a player can SEE, and
 * leaves out every look someone else already wears.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EMBLEM_TEXELS, SAME_EMBLEM_TEXELS, distinctSigils, lookChoices, lookKey } from './sigilChoices.js';
import { sigilCoverage, sigilDesign } from './sigil.js';
import { PLAYER_LIVERY, packLook, setFactionLooks, teamSigilOf } from '../../../shared-types/factions.js';

const P = '6a7e0000-0000-4000-8000-0000000000a1';
const Q = '6a7e0000-0000-4000-8000-0000000000b2';
const R = '6a7e0000-0000-4000-8000-0000000000c3';

/** Rasterised independently of the module (the test does not trust its helper). */
function bitmap(packed: number): Uint8Array {
  const n = EMBLEM_TEXELS, d = sigilDesign(packed), out = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) out[y * n + x] = sigilCoverage(d, ((x + 0.5) / n) * 2 - 1, 1 - ((y + 0.5) / n) * 2, 2 / n) >= 0.5 ? 1 : 0;
  }
  return out;
}

function differing(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

afterEach(() => setFactionLooks([]));

describe('distinctSigils', () => {
  it('no two listed sigils in a colour render identically (real generator, every slot)', () => {
    for (let slot = 0; slot < PLAYER_LIVERY.length; slot++) {
      const list = distinctSigils(slot);
      expect(list.length).toBeGreaterThan(40);
      const maps = list.map((s) => bitmap(packLook(slot, s)));
      for (let i = 0; i < maps.length; i++) {
        for (let j = i + 1; j < maps.length; j++) {
          expect(differing(maps[i]!, maps[j]!), `slot ${slot}: sigils ${list[i]} and ${list[j]}`).toBeGreaterThan(SAME_EMBLEM_TEXELS);
        }
      }
    }
  });

  it('every sigil number draws one of the listed emblems', () => {
    const keys = new Set(distinctSigils(5).map((s) => lookKey(packLook(5, s))));
    for (let s = 0; s < 4096; s += 37) expect(keys.has(lookKey(packLook(5, s)))).toBe(true);
  });
});

describe('lookChoices', () => {
  it('leaves out claimed looks and known players’ default looks, keeps and marks my own', () => {
    setFactionLooks([{ factionId: Q, colorSlot: 3, sigil: distinctSigils(3)[4]! }]);

    const r = teamSigilOf(R);
    const inSlot = (slot: number) => lookChoices(slot, P, [Q, R]).map((c) => lookKey(packLook(c.colorSlot, c.sigil)));
    expect(inSlot(3)).not.toContain(lookKey(packLook(3, distinctSigils(3)[4]!)));
    expect(inSlot(r >>> 12)).not.toContain(lookKey(r));
    const mine = teamSigilOf(P);
    const current = lookChoices(mine >>> 12, P, [Q, R]).filter((c) => c.current);
    expect(current).toHaveLength(1);
    expect(lookKey(packLook(current[0]!.colorSlot, current[0]!.sigil))).toBe(lookKey(mine));
  });

  it('a look the same emblem as a taken one, under another sigil number, is taken too', () => {
    const slot = 7;
    const rep = distinctSigils(slot)[2]!;
    // Find another sigil number drawing the same emblem as `rep`.
    let twin = -1;
    for (let s = rep + 1; s < 4096 && twin < 0; s++) if (lookKey(packLook(slot, s)) === lookKey(packLook(slot, rep))) twin = s;
    expect(twin).toBeGreaterThan(rep);
    setFactionLooks([{ factionId: Q, colorSlot: slot, sigil: twin }]);
    const sigils = lookChoices(slot, P, []).map((c) => c.sigil);
    expect(sigils).not.toContain(rep);
  });
});
