import { describe, it, expect } from 'vitest';
import {
  HEAVY_BEAM_COLOR, HEAVY_BEAM_STYLE, MINING_BEAM_STYLE, REMOTE_BEAM_FADE_MS, REMOTE_BEAM_STYLE,
  findMount, remoteBeamStyleForMount, remoteBeamTtlMs,
} from './beamStyles.js';
import { getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../shared-types/shipKinds.js';

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

  it('the combat beam TAPERS toward the tip; the mining drill stays solid (P3.13)', () => {
    // Combat beams fade to nothing at the end of their range (gradient texture);
    // the mining beam is a sustained solid connection to the asteroid.
    expect(REMOTE_BEAM_STYLE.taper).toBe(true);
    expect(MINING_BEAM_STYLE.taper).toBeFalsy();
  });
});

describe('beam styles — capital heavy beam (plan beam-slices §8)', () => {
  const mounts = [
    { id: 'forward', weaponId: 'hitscan' },
    { id: 'main-0', weaponId: 'heavy_beam' },
  ] as const;

  it('a heavy_beam mount resolves to the heavy style', () => {
    expect(remoteBeamStyleForMount(findMount(mounts, 'main-0'))).toBe(HEAVY_BEAM_STYLE);
  });

  it('a fighter hitscan mount keeps the old (pool) style', () => {
    expect(remoteBeamStyleForMount(findMount(mounts, 'forward'))).toBeNull();
    // A real fighter's beam mount, looked up by kind as the renderer does.
    const fighter = getShipKind('fighter');
    // The fighter's nose beam ('laser' = the fighter hitscan beam).
    const beam = fighter.mounts?.find((m) => m.weaponId === 'laser' || m.weaponId === 'hitscan');
    expect(beam).toBeDefined();
    expect(remoteBeamStyleForMount(findMount(fighter.mounts, beam!.id))).toBeNull();
    // Unknown mount id (a pre-2c server omits it) → the old style too.
    expect(remoteBeamStyleForMount(findMount(mounts, 'nope'))).toBeNull();
    expect(remoteBeamStyleForMount(findMount(mounts, undefined))).toBeNull();
  });

  it('reads as a thick capital beam in its own colour', () => {
    expect(HEAVY_BEAM_STYLE.width).toBeGreaterThanOrEqual(REMOTE_BEAM_STYLE.width * 4);
    expect(HEAVY_BEAM_STYLE.glowScale ?? 1).toBeGreaterThan(1);
    expect(HEAVY_BEAM_STYLE.taper).toBe(true);
    expect(HEAVY_BEAM_STYLE.tint).toBe(HEAVY_BEAM_COLOR);
    for (const c of [REMOTE_BEAM_STYLE.tint, MINING_BEAM_STYLE.tint, 0x6fd0ff]) expect(HEAVY_BEAM_COLOR).not.toBe(c);
  });

  it('holds full brightness across the whole fire interval (a burn, not a strobe)', () => {
    const cooldownMs = (getWeapon('heavy_beam').cooldownTicks * 1000) / 60;
    // The next shot must land before the fade window starts, with margin.
    expect(remoteBeamTtlMs(true, true) - REMOTE_BEAM_FADE_MS).toBeGreaterThan(cooldownMs + 50);
    // Fighter TTLs are unchanged.
    expect(remoteBeamTtlMs(true, false)).toBe(250);
    expect(remoteBeamTtlMs(false, false)).toBe(400);
  });
});
