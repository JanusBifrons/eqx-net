/**
 * The vaporise look (fracture v11: a cut kill left no piece). The ship's
 * normal death explosion plays its vaporise variant: the profile's
 * `fx.vaporiseBlastScale` / `vaporiseSeconds` / `vaporiseTint`, picked by
 * `deathBlastFor` when the death was vaporised, and never replaced by a
 * wreck break-up (there is no wreck).
 */
import { describe, it, expect } from 'vitest';
import { deathBlastFor, hullDeathBlastReplaced, type DeathBlast } from './wreckArt.js';
import { DESTRUCTION_PROFILES } from '../../../shared-types/shipScale/destruction.js';

const SUB = DESTRUCTION_PROFILES.subcap.fx;
const blank = (): DeathBlast => ({ scale: 0, linger: 0, vaporise: false, tint: 0, seconds: 0 });

describe('deathBlastFor: the vaporise variant', () => {
  it('a vaporised sub-cap gets the vaporise blast (scale, length, tint)', () => {
    const out = deathBlastFor(true, false, 'fighter', blank(), true);
    expect(out.vaporise).toBe(true);
    expect(out.scale).toBe(SUB.vaporiseBlastScale);
    expect(out.seconds).toBe(SUB.vaporiseSeconds);
    expect(out.tint).toBe(SUB.vaporiseTint);
    // Short: a flash and a puff, not a fireball and smoke.
    expect(out.seconds).toBeGreaterThanOrEqual(0.5);
    expect(out.seconds).toBeLessThanOrEqual(0.8);
  });

  it('vaporised is picked even if the room flag were off (the server only sends it with wrecks on)', () => {
    expect(deathBlastFor(false, false, 'fighter', blank(), true).vaporise).toBe(true);
  });

  it('a normal death keeps the normal blast, the out reused (no stale vaporise)', () => {
    const out = blank();
    deathBlastFor(true, false, 'fighter', out, true);
    deathBlastFor(true, false, 'fighter', out);
    expect(out.vaporise).toBe(false);
    expect(out.scale).toBe(SUB.deathBlastScale);
    expect(out.linger).toBe(SUB.deathBlastLinger);
    deathBlastFor(false, false, 'fighter', out, false);
    expect(out).toMatchObject({ scale: 1, linger: 1, vaporise: false });
  });

  it('an unknown kind vaporised still flashes, with the sub-cap look', () => {
    const out = deathBlastFor(true, false, null, blank(), true);
    expect(out.vaporise).toBe(true);
    expect(out.tint).toBe(SUB.vaporiseTint);
  });

  it('a vaporised capital is never left to a wreck break-up (there is none)', () => {
    expect(hullDeathBlastReplaced(true, true, 'battleship')).toBe(true);
    expect(hullDeathBlastReplaced(true, true, 'battleship', true)).toBe(false);
  });

  it('the tint is a hot violet-white (blue and red high, green lower)', () => {
    const t = SUB.vaporiseTint;
    const r = (t >> 16) & 255, g = (t >> 8) & 255, b = t & 255;
    expect(b).toBeGreaterThanOrEqual(0xe0);
    expect(r).toBeGreaterThanOrEqual(0xb0);
    expect(g).toBeLessThan(b);
  });
});
