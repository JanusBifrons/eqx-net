import { describe, expect, it } from 'vitest';
import { eliteName, isEliteId, rollEliteLoot, ELITE_ID_PREFIX } from '../../shared-types/elites.js';
import { isDirectorBotId } from './directorBotIds.js';

/** Deterministic LCG in [0, 1). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

describe('elites (P4a)', () => {
  it('names are two words and deterministic per seed', () => {
    const a = eliteName(seeded(7));
    expect(a).toBe(eliteName(seeded(7)));
    expect(a.split(' ')).toHaveLength(2);
  });

  it('always drops at least one Robot Core and 200 credits', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const h = rollEliteLoot('gunship', seeded(seed));
      expect(h.goods.core ?? 0).toBeGreaterThanOrEqual(1);
      expect(h.credits).toBeGreaterThanOrEqual(200);
    }
  });

  it('elite ids are NPC ids (never mistaken for players)', () => {
    const id = `${ELITE_ID_PREFIX}0`;
    expect(isEliteId(id)).toBe(true);
    expect(isDirectorBotId(id)).toBe(true);
  });
});
