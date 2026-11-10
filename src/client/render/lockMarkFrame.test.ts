/**
 * Showcase review (2026-11-10, `capital-guns-fighter`, frames f013/f018/f022):
 * "from 12 s to the end two bright red pulsing lines run across the screen at
 * ±45°, nowhere near the fighter. The left one cuts across the battleship's
 * stern deck." They were the corners of the fire-control threat diamond drawn
 * round the battleship locking the player, sized from its hull radius, so it
 * was about two screens wide. A lock mark on a capital must stay a mark: a
 * sane on-screen size, sitting on the ship. Fighter marks are unchanged.
 */
import { describe, expect, it } from 'vitest';
import { getShipKind } from '@shared-types/shipKinds';
import {
  LOCK_KEEL_FRAC, LOCK_MARK_MAX_SCREEN_HALF, LOCK_MIN_HALF, LOCK_PAD,
  lockMarkFrame, threatRingRadius, type LockMarkFrame,
} from './lockMarkFrame';

const out = (): LockMarkFrame => ({ x: 0, y: 0, half: 0, capped: false });
/** Normal play zoom (1 world unit = 1 px); `px` = world units per pixel. */
const NORMAL_PX = 1;
/** The threat diamond is drawn at 1.2x the frame half. */
const DIAMOND = 1.2;

describe('lockMarkFrame', () => {
  const bs = getShipKind('battleship');
  const fighter = getShipKind('fighter');

  it('the battleship really is far bigger than the screen at normal zoom (the bug precondition)', () => {
    expect(bs.radius).toBeGreaterThan(LOCK_MARK_MAX_SCREEN_HALF * 3);
  });

  it('keeps a battleship lock mark within a sane on-screen size', () => {
    // Battleship heading +Y (angle 0), the fighter alongside its stern quarter.
    const f = lockMarkFrame(0, 0, 0, bs.radius, 1100, -bs.radius * 0.5, NORMAL_PX, out());
    expect(f.capped).toBe(true);
    const screenHalf = (f.half * DIAMOND) / NORMAL_PX;
    expect(screenHalf).toBeLessThanOrEqual(LOCK_MARK_MAX_SCREEN_HALF * DIAMOND);
    // Old formula, for contrast: the diamond spanned more than a 1920 px screen.
    expect(Math.max(LOCK_MIN_HALF, bs.radius + LOCK_PAD) * DIAMOND * 2).toBeGreaterThan(screenHalf * 2 * 3);
  });

  it('moves a capped mark onto the hull keel, at the point nearest the viewer', () => {
    const viewerY = -bs.radius * 0.5;
    const f = lockMarkFrame(0, 0, 0, bs.radius, 1100, viewerY, NORMAL_PX, out());
    // On the keel line (x = 0 for a ship heading +Y) and abreast of the viewer.
    expect(f.x).toBeCloseTo(0, 6);
    expect(f.y).toBeCloseTo(viewerY, 6);
    expect(Math.hypot(f.x, f.y)).toBeLessThanOrEqual(bs.radius * LOCK_KEEL_FRAC + 1e-6);
  });

  it('never slides the mark off the end of the hull, whatever the heading', () => {
    const a = 1.1;
    const f = lockMarkFrame(500, -300, a, bs.radius, 500 - Math.sin(a) * 1e6, -300 + Math.cos(a) * 1e6, NORMAL_PX, out());
    expect(Math.hypot(f.x - 500, f.y + 300)).toBeCloseTo(bs.radius * LOCK_KEEL_FRAC, 3);
  });

  it('leaves fighter marks unchanged at every zoom (0.15 to 3)', () => {
    for (const zoom of [0.15, 0.5, 1, 2, 3]) {
      const f = lockMarkFrame(40, 70, 0.7, fighter.radius, 900, -400, 1 / zoom, out());
      expect(f.capped).toBe(false);
      expect(f.x).toBe(40);
      expect(f.y).toBe(70);
      expect(f.half).toBe(Math.max(LOCK_MIN_HALF, fighter.radius + LOCK_PAD));
    }
  });

  it('a capital zoomed far out (fits on screen) keeps the hull-sized, centred mark', () => {
    const px = (bs.radius + LOCK_PAD) / LOCK_MARK_MAX_SCREEN_HALF + 0.01;
    const f = lockMarkFrame(0, 0, 0, bs.radius, 5000, 0, px, out());
    expect(f.capped).toBe(false);
    expect(f.half).toBe(bs.radius + LOCK_PAD);
  });
});

describe('threatRingRadius', () => {
  it('is unchanged for a fighter at every zoom', () => {
    const r = getShipKind('fighter').radius;
    for (const zoom of [0.15, 1, 3]) {
      const px = 1 / zoom;
      expect(threatRingRadius(r, px)).toBe(r * 1.9 + 10 * px);
    }
  });

  it('stays on screen round a capital at normal zoom', () => {
    expect(threatRingRadius(getShipKind('battleship').radius, NORMAL_PX)).toBeLessThanOrEqual(220);
  });
});
