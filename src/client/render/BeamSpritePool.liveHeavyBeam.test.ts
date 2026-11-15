/**
 * A pilot flying a lance battlecruiser, zoomed out on a whole wreck, saw its
 * heavy beams as faint cyan dotted lines running out past the target, not
 * solid violet beams. The pilot's OWN shots never reach the remote pool
 * (`laser_fired` from the local shooter is dropped: they are `liveBeams`), and
 * the live pool drew every mount with the fighter look: a 2 u white core in
 * the container `LaserGlow` haloes cyan, tapering to the weapon's max range.
 * At capital zoom that core is a fraction of a px, so it rasterises as dots.
 *
 * Locks: the pilot's heavy-beam mount draws in the live pool exactly like a
 * remote heavy beam: the violet cross-section, unfiltered `styledContainer`,
 * at least `HEAVY_BEAM_MIN_SCREEN_PX` on screen, solid to its hit; the
 * fighter beam keeps its look.
 */
import { describe, it, expect } from 'vitest';
import { BeamSpritePool, crossSectionTextures, type BeamView } from './BeamSpritePool';
import {
  HEAVY_BEAM_CROSS_SECTION, HEAVY_BEAM_MIN_SCREEN_PX, HEAVY_BEAM_MISS_FADE_FRAC, LIVE_BEAM_STYLE, findMount, liveBeamLook,
} from './beamStyles';
import { getShipKind } from '../../shared-types/shipKinds';

const lanceMain = findMount(getShipKind('battlecruiser-lance').mounts, 'main-1')!;
const fighterGun = getShipKind('fighter').mounts![0]!;

/** A live slot as PixiRenderer's live loop fills it. */
function liveSlot(mount: { weaponId: string }, len: number, solidDist: number, hit: boolean): BeamView {
  const v: BeamView = { fromX: 0, fromY: 0, toX: len, toY: 0 };
  liveBeamLook(mount, len, solidDist, hit, v);
  return v;
}

describe('live beam pool — the pilot\'s own heavy beam', () => {
  it('fixture: main-1 of the lance battlecruiser is a heavy beam', () => {
    expect(lanceMain.weaponId).toBe('heavy_beam');
  });

  it('a hit draws a solid violet core, unfiltered, >= the min screen px at far zoom', () => {
    const pool = new BeamSpritePool(LIVE_BEAM_STYLE);
    const camScale = 0.04; // whole-wreck capital zoom: 2 u = 0.08 px
    pool.setBeams([liveSlot(lanceMain, 8000, 8000, true)], 1, camScale);
    const c = pool.coreAt(0)!;
    expect(c.texture).toBe(crossSectionTextures(HEAVY_BEAM_CROSS_SECTION).solid);
    expect(c.tint).toBe(0xffffff); // untinted: the violet is in the texture
    expect(c.parent).toBe(pool.styledContainer); // not under LaserGlow's cyan
    expect(c.width * camScale).toBeGreaterThanOrEqual(HEAVY_BEAM_MIN_SCREEN_PX - 1e-9);
    // Continuous: one solid core to the hit, no fade tail.
    expect(pool.solidLenAt(0)).toBeCloseTo(8000, 6);
    expect(pool.fadeTailAt(0)?.visible ?? false).toBe(false);
  });

  it('a miss is solid to its last HEAVY_BEAM_MISS_FADE_FRAC, like a remote heavy beam', () => {
    const pool = new BeamSpritePool(LIVE_BEAM_STYLE);
    pool.setBeams([liveSlot(lanceMain, 20_000, 1500, false)], 1, 0.04);
    expect(pool.solidLenAt(0)).toBeCloseTo(20_000 * (1 - HEAVY_BEAM_MISS_FADE_FRAC), 6);
  });

  it('the fighter beam keeps the live look (white core in the glow-filtered container)', () => {
    const pool = new BeamSpritePool(LIVE_BEAM_STYLE);
    pool.setBeams([liveSlot(fighterGun, 600, 300, false)], 1, 0.04);
    const c = pool.coreAt(0)!;
    expect(c.parent).toBe(pool.container);
    expect(c.tint).toBe(LIVE_BEAM_STYLE.tint);
    expect(c.width).toBe(LIVE_BEAM_STYLE.width);
    expect(pool.solidLenAt(0)).toBeCloseTo(300, 6);
  });
});
