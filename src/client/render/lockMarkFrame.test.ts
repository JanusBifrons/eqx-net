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
  threatDiamondHalf, threatPointerRadius, hullHalfBeam,
  THREAT_PIN_HALF_PX, THREAT_TIP_PX,
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

/**
 * Showcase review (2026-11-12, `capital-guns-fighter`), owner: "the lock icon
 * needs adjusting I think, it's weird and misplaced. As in the diamond." The
 * threat diamond on the battleship locking the player was a ~290 px square
 * framing a random slice of its stern, and the threat ring's red arc + caret
 * round the player's heavy cruiser lay across the battleship's deck. Owner's
 * choice: on a capital, a small (~14 px) red diamond pinned on the keel point
 * nearest the player; and keep the arc and caret off a hull inside the ring.
 */
describe('threat marks on a capital', () => {
  const bs = getShipKind('battleship');
  const ca = getShipKind('heavy-cruiser');
  const fighter = getShipKind('fighter');

  it('a capped (capital) threat gets a small constant-size pin, at every zoom', () => {
    for (const px of [1, 4, 20]) {
      const f = lockMarkFrame(0, 0, 0, bs.radius, 900, -400, px, out());
      expect(f.capped).toBe(true);
      const screenAcross = (threatDiamondHalf(f, px) * 2) / px;
      expect(screenAcross).toBeCloseTo(THREAT_PIN_HALF_PX * 2, 6);
      expect(screenAcross).toBeLessThanOrEqual(16);
    }
  });

  it("a fighter threat keeps today's hull-framing diamond (1.2x the frame)", () => {
    for (const zoom of [0.15, 1, 3]) {
      const f = lockMarkFrame(40, 70, 0.7, fighter.radius, 900, -400, 1 / zoom, out());
      expect(threatDiamondHalf(f, 1 / zoom)).toBe(f.half * 1.2);
    }
  });

  it("a capital's half beam comes from its hull, a fighter's from its radius", () => {
    expect(hullHalfBeam(bs)).toBeGreaterThan(0);
    expect(hullHalfBeam(bs)).toBeLessThan(bs.radius * 0.3);
    expect(hullHalfBeam(fighter)).toBe(fighter.radius);
  });

  // The clip: the heavy cruiser (player) alongside the battleship's quarter,
  // its hull edge well inside the cruiser's capped threat ring.
  const px = 4;
  const R = threatRingRadius(ca.radius, px);
  const hb = hullHalfBeam(bs);
  const ringAt = (ox: number, oy: number): number => threatPointerRadius(R, ox, oy, 0, 0, 0, bs.radius, hb, px);

  it('pulls the arc and caret inside the gap when the hull is closer than the ring', () => {
    const edge = 100 * px; // hull edge 100 px off the player; the ring is 220 px
    const r = ringAt(hb + edge, -1000);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeLessThan(R);
    // The caret tip (r + tip) stays clear of the hull edge.
    expect(r + THREAT_TIP_PX * px).toBeLessThan(edge);
  });

  it('hides them when there is no room between the ship and the hull', () => {
    expect(ringAt(hb + 10 * px, -1000)).toBe(0);
  });

  it('measures to the hull, not its centre: abeam of the stern counts', () => {
    // Far aft of the battleship's centre, but beside its stern.
    expect(ringAt(hb + 100 * px, -bs.radius * 0.8)).toBeLessThan(R);
  });

  it('leaves the ring alone when the hull is beyond it, and for fighters at fighting range', () => {
    expect(ringAt(hb + R + 200 * px, 0)).toBe(R);
    const fr = threatRingRadius(fighter.radius, 1);
    expect(threatPointerRadius(fr, 0, 0, 300, 0, 0.3, fighter.radius, hullHalfBeam(fighter), 1)).toBe(fr);
  });
});
