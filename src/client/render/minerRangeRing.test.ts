import { describe, it, expect } from 'vitest';
import { minerRangeForKind } from './minerRangeRing.js';
import { getStructureKind, MINER } from '../../shared-types/structureKinds.js';

/**
 * WS-4 Phase 5 (R2.16) — the miner range-ring radius must be the miner kind's
 * `miningRange`, never hardcoded. This is the "ring radius === miningRange"
 * lock the sub-plan asks for; the renderer's `buildMinerRangeRingGfx` is fed
 * from this helper, so locking the helper locks the drawn radius's SOURCE.
 */
describe('minerRangeForKind (WS-4 Phase 5 / R2.16)', () => {
  it('returns the miner kind miningRange (the ring radius source)', () => {
    expect(minerRangeForKind('miner')).toBe(getStructureKind('miner').miningRange);
    expect(minerRangeForKind('miner')).toBe(MINER.miningRange);
    // Canonical value today (will track structureKinds.ts; bump here if retuned).
    expect(minerRangeForKind('miner')).toBe(800);
  });

  it('is undefined for kinds without a mining range (no ring drawn)', () => {
    // Only the Miner declares miningRange; every other kind omits it.
    for (const id of ['capital', 'connector', 'solar', 'turret', 'battery', 'shield_pylon']) {
      expect(minerRangeForKind(id)).toBeUndefined();
    }
  });

  it('is undefined for unknown / nullish ids (getStructureKind falls back to Capital, which has no range)', () => {
    expect(minerRangeForKind('not_a_real_kind')).toBeUndefined();
    expect(minerRangeForKind(undefined)).toBeUndefined();
  });
});
