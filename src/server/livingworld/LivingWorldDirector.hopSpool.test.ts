import { describe, it, expect } from 'vitest';
import { hopSpoolMs } from './LivingWorldDirector.js';

// The 2026-06-19 playtest "the attack came out of nowhere — 2.5 s warning, then
// they spawned on top of me" fix. A WAVE's FINAL approach into its target sector
// must spool LONG (≈ the player's 30 s warp) so the attack telegraphs with a real
// incoming countdown; everything else stays fast so a multi-hop wave still
// converges (a uniform long spool was the pre-2026-06-18 minutes-long-never-
// arriving bug).
describe('hopSpoolMs — wave final approach telegraphs, everything else is fast', () => {
  const FAST = 2500;
  const APPROACH = 30_000;

  it('a WAVE on its FINAL approach gets the long telegraph spool', () => {
    expect(hopSpoolMs(true, true, FAST, APPROACH)).toBe(APPROACH);
  });

  it('a WAVE on an INTERMEDIATE hop stays fast (so it still converges)', () => {
    expect(hopSpoolMs(true, false, FAST, APPROACH)).toBe(FAST);
  });

  it('a ROAMING squad (never a wave) is always fast, even on its final hop', () => {
    expect(hopSpoolMs(false, true, FAST, APPROACH)).toBe(FAST);
    expect(hopSpoolMs(false, false, FAST, APPROACH)).toBe(FAST);
  });
});
