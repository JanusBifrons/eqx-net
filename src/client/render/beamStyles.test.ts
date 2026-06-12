import { describe, it, expect } from 'vitest';
import { MINING_BEAM_STYLE, REMOTE_BEAM_STYLE } from './beamStyles.js';

/**
 * WS-4 Phase 4 follow-up — lock the deliberate visual distinction between the
 * Miner's drill beam and the combat laser beam. Phase 4's whole point is that
 * the mining beam routes into a DEDICATED pool so it LOOKS distinct; if a
 * refactor accidentally equalised the styles (e.g. copy-pasting the combat
 * tint), the E2E (which only asserts a beam is drawn) would still pass while
 * the beam became indistinguishable from a combat laser. This is the regression
 * lock for "looks distinct".
 */
describe('beam styles — mining vs combat distinction (WS-4 Phase 4)', () => {
  it('the mining beam is visually DISTINCT from the combat beam', () => {
    expect(MINING_BEAM_STYLE.tint).not.toBe(REMOTE_BEAM_STYLE.tint);
    // Fatter so the drill reads as a sustained tool-beam, not a shot.
    expect(MINING_BEAM_STYLE.width).toBeGreaterThan(REMOTE_BEAM_STYLE.width);
  });

  it('both styles are well-formed (warm amber, sane width/alpha)', () => {
    for (const s of [MINING_BEAM_STYLE, REMOTE_BEAM_STYLE]) {
      expect(s.tint).toBeGreaterThan(0);
      expect(s.width).toBeGreaterThan(0);
      expect(s.alpha).toBeGreaterThan(0);
      expect(s.alpha).toBeLessThanOrEqual(1);
    }
  });
});
