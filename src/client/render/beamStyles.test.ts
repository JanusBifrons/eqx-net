import { describe, it, expect } from 'vitest';
import {
  HEAVY_BEAM_COLOR, HEAVY_BEAM_STYLE, MINING_BEAM_STYLE, REMOTE_BEAM_FADE_MS, REMOTE_BEAM_STYLE,
  findMount, remoteBeamStyleForMount, MINING_LASER_STYLE, isSustainedBeamMount, isHeavyBeamMount, remoteBeamTtlMs, remoteBeamSolidLen, HEAVY_BEAM_MISS_FADE_FRAC,
  liveBeamLine, LIVE_BEAM_DRAW_START,
} from './beamStyles.js';
import { HEAVY_BEAM_WIDTH, MINING_LASER_WIDTH, getWeapon } from '../../core/combat/WeaponCatalogue.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipShotMuzzle } from '../../core/combat/muzzle.js';

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
    expect(HEAVY_BEAM_STYLE.tint).toBe(HEAVY_BEAM_COLOR);
    for (const c of [REMOTE_BEAM_STYLE.tint, MINING_BEAM_STYLE.tint, 0x6fd0ff]) expect(HEAVY_BEAM_COLOR).not.toBe(c);
  });

  // Filmed review 2026-11-15: the heavy beam tapered to ~3–5 px and dimmed
  // over its last third, right where it met the cruiser, so it looked weak
  // at the impact. A capital beam stays full width and bright to its hit.
  it('does not taper: full width and brightness to its hit point; a short fade only past a miss', () => {
    expect(HEAVY_BEAM_STYLE.taper).toBeFalsy();
    expect(remoteBeamSolidLen(HEAVY_BEAM_STYLE, 3000, true)).toBe(3000);
    const miss = remoteBeamSolidLen(HEAVY_BEAM_STYLE, 3000, false)!;
    expect(miss).toBeCloseTo(3000 * (1 - HEAVY_BEAM_MISS_FADE_FRAC), 6);
    expect(HEAVY_BEAM_MISS_FADE_FRAC).toBeGreaterThan(0);
    expect(HEAVY_BEAM_MISS_FADE_FRAC, 'a SHORT fade').toBeLessThanOrEqual(0.25);
    // Fighter beams: no solid length, the pool's own gradient taper as before.
    expect(remoteBeamSolidLen(null, 300, true)).toBeUndefined();
    expect(remoteBeamSolidLen(null, 300, false)).toBeUndefined();
    expect(REMOTE_BEAM_STYLE.taper).toBe(true);
  });

  it('is drawn as wide as the strip its slice erases (owner: the slice was too thin for the beam)', () => {
    expect(HEAVY_BEAM_STYLE.width).toBe(HEAVY_BEAM_WIDTH);
    expect(getWeapon('heavy_beam').killCut).toEqual({ kind: 'slice', width: HEAVY_BEAM_WIDTH });
    expect(HEAVY_BEAM_STYLE.minScreenPx).toBe(12);
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

describe('beam styles — mining laser (plan partitioned-chasing-lark PR 7)', () => {
  const mounts = [{ id: 'mine-0', weaponId: 'mining_laser' }, { id: 'main-0', weaponId: 'heavy_beam' }] as const;

  it('a mining_laser mount draws in the Miner beam colours at its cut width, solid to the hit', () => {
    const s = remoteBeamStyleForMount(findMount(mounts, 'mine-0'));
    expect(s).toBe(MINING_LASER_STYLE);
    expect(s!.tint).toBe(MINING_BEAM_STYLE.tint);
    expect(s!.alpha).toBe(MINING_BEAM_STYLE.alpha);
    expect(s!.width).toBe(MINING_LASER_WIDTH);
    expect(getWeapon('mining_laser').killCut).toEqual({ kind: 'slice', width: s!.width });
    expect(s!.taper).toBe(false);
    expect(remoteBeamSolidLen(s, 100, true)).toBe(100);
  });

  it('holds like the heavy beam (no strobe at the 10-tick cadence); fighter beams do not', () => {
    expect(isSustainedBeamMount(findMount(mounts, 'mine-0'))).toBe(true);
    expect(isSustainedBeamMount(findMount(mounts, 'main-0'))).toBe(true);
    expect(isSustainedBeamMount({ weaponId: 'hitscan' })).toBe(false);
    expect(isHeavyBeamMount(findMount(mounts, 'mine-0'))).toBe(false);
  });
});

/**
 * The pilot's OWN beam must END where its ray stopped (take 9, 2026-11-15: a
 * lance battlecruiser's heavy beams on a wreck piece ended ~425 u short of
 * the hull, "on a circle around it"). `updateLiveBeam` casts from the barrel
 * tip (`shipShotMuzzle`, 445 u on the lance's main turrets) and stores the
 * distance FROM THERE; the renderer added it to pivot + 20 u.
 */
describe('liveBeamLine — the drawn end is the ray hit point', () => {
  const kind = getShipKind('battlecruiser-lance');
  const mount = kind.mounts!.find((m) => m.weaponId === 'heavy_beam')!;
  const muzzleD = shipShotMuzzle(kind, mount);

  it('ends at pivot + muzzle + dist along the fire direction', () => {
    const angle = 0.7;
    const fx = -Math.sin(angle), fy = Math.cos(angle);
    const dist = 3000;
    const out = liveBeamLine(100, -50, angle, muzzleD, dist, { fromX: 0, fromY: 0, toX: 0, toY: 0 });
    // Where the ray (cast from the barrel tip) stopped.
    const hitX = 100 + fx * (muzzleD + dist), hitY = -50 + fy * (muzzleD + dist);
    expect(muzzleD).toBeGreaterThan(400);
    expect(out.toX).toBeCloseTo(hitX, 6);
    expect(out.toY).toBeCloseTo(hitY, 6);
    // The drawn start is unchanged (pivot + LIVE_BEAM_DRAW_START along the barrel).
    expect(out.fromX).toBeCloseTo(100 + fx * LIVE_BEAM_DRAW_START, 6);
    expect(out.fromY).toBeCloseTo(-50 + fy * LIVE_BEAM_DRAW_START, 6);
  });

  it('never draws backwards for a barrel shorter than the draw start', () => {
    const out = liveBeamLine(0, 0, 0, 5, 0, { fromX: 0, fromY: 0, toX: 0, toY: 0 });
    expect(out.toY).toBeCloseTo(out.fromY, 6);
  });
});
