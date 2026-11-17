import { describe, it, expect } from 'vitest';
import { GALAXY_SECTORS } from '@core/galaxy/galaxy';
import type { SectorControl, SectorLiveState } from '../../../shared-types/galaxySnapshot.js';
import {
  GalaxyMotion,
  easeInOut,
  splitFraction,
  isNewFighting,
  flareAt,
  hotPulseAlpha,
  flipRingAfterWipe,
  nebulaDrift,
  clipPolyAtX,
  SPLIT_EASE_MS,
  FLIP_WIPE_MS,
  FLARE_MS,
  SPLIT_MIN_SIDE,
  HOT_PULSE_PERIOD_MS,
  type HexLook,
} from './galaxyMapMotion';
import { hexFlat } from './galaxyHexDraw';
import { FLIP_RING_MS } from './galaxyTerritories';
import { NEUTRAL_OWNER } from './sectorOwnership';

function control(over: Partial<SectorControl> = {}): SectorControl {
  return { holderShare: 60, challenger: null, challengerShare: 0, trend: 0, threat: 0, flippedAtMs: null, locked: false, ...over };
}

const KEY = GALAXY_SECTORS[0]!.key;
const IDX = 0;

function feed(owner: string | null, c?: SectorControl, recentCombat = false): Map<string, SectorLiveState> {
  const st = {
    key: KEY, players: 0, enemies: 0, neutrals: 0, structures: 0,
    owner: owner === null ? null : { factionId: owner, contested: false },
    ...(c ? { control: c } : {}),
    ...(recentCombat ? { recentCombat: { shipsDestroyed: 1, structuresDestroyed: 0, lastEventMs: 0 } } : {}),
  } as unknown as SectorLiveState;
  return new Map([[KEY, st]]);
}

function look(m: GalaxyMotion, holder: string, now: number): HexLook {
  const out: HexLook = { left: '', right: null, frac: 1, wiping: false };
  m.look(IDX, holder, now, out);
  return out;
}

describe('easing', () => {
  it('runs 0 → 1, clamped, symmetric', () => {
    expect(easeInOut(-1)).toBe(0);
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(0.5)).toBeCloseTo(0.5);
    expect(easeInOut(1)).toBe(1);
    expect(easeInOut(2)).toBe(1);
    expect(easeInOut(0.25) + easeInOut(0.75)).toBeCloseTo(1);
  });
});

describe('split fraction (where the split line sits)', () => {
  it('is a whole hex with no challenger', () => {
    expect(splitFraction(control(), 'traders')).toBe(1);
    expect(splitFraction(undefined, 'traders')).toBe(1);
  });
  it('follows the holder share against the challenger', () => {
    expect(splitFraction(control({ holderShare: 60, challenger: 'robots', challengerShare: 40 }), 'traders')).toBeCloseTo(0.6);
    expect(splitFraction(control({ holderShare: 50, challenger: 'robots', challengerShare: 50 }), 'traders')).toBeCloseTo(0.5);
  });
  it('keeps a sliver of each side', () => {
    expect(splitFraction(control({ holderShare: 99, challenger: 'robots', challengerShare: 1 }), 'traders')).toBe(1 - SPLIT_MIN_SIDE);
    expect(splitFraction(control({ holderShare: 1, challenger: 'robots', challengerShare: 99 }), 'traders')).toBe(SPLIT_MIN_SIDE);
  });
  it("nobody's ground: grey side is what the leader has not taken", () => {
    expect(splitFraction(control({ holderShare: 0, challenger: 'robots', challengerShare: 45 }), NEUTRAL_OWNER)).toBeCloseTo(0.55);
    // Under the unowned split threshold: no split at all.
    expect(splitFraction(control({ holderShare: 0, challenger: 'robots', challengerShare: 30 }), NEUTRAL_OWNER)).toBe(1);
  });
});

describe('fighting flare, hot pulse, flip ring, drift', () => {
  it('flares only on new fighting, never on the first poll', () => {
    expect(isNewFighting(-1, false, 3, true)).toBe(false);
    expect(isNewFighting(1, false, 2, false)).toBe(true);
    expect(isNewFighting(2, false, 2, false)).toBe(false);
    expect(isNewFighting(2, true, 1, true)).toBe(false);
    expect(isNewFighting(0, false, 0, true)).toBe(true);
  });
  it('flare grows and fades, then is gone', () => {
    const o = { radius: 0, alpha: 0 };
    flareAt(0, o);
    expect(o.alpha).toBe(1);
    const r0 = o.radius;
    flareAt(FLARE_MS / 2, o);
    expect(o.radius).toBeGreaterThan(r0);
    expect(o.alpha).toBeCloseTo(0.5);
    flareAt(FLARE_MS, o);
    expect(o.alpha).toBe(0);
  });
  it('hot pulse breathes slowly; steady under reduced motion', () => {
    const lo = hotPulseAlpha(0, false);
    const hi = hotPulseAlpha(HOT_PULSE_PERIOD_MS / 2, false);
    expect(hi).toBeGreaterThan(lo + 0.3);
    expect(hotPulseAlpha(0, true)).toBe(hotPulseAlpha(HOT_PULSE_PERIOD_MS / 2, true));
  });
  it('flip ring waits for the wipe, then fades as before', () => {
    expect(flipRingAfterWipe(0)).toBe(0);
    expect(flipRingAfterWipe(FLIP_WIPE_MS - 1)).toBe(0);
    expect(flipRingAfterWipe(FLIP_WIPE_MS)).toBeGreaterThan(0.9);
    expect(flipRingAfterWipe(FLIP_RING_MS)).toBe(0);
  });
  it('nebula drift is small and stops under reduced motion', () => {
    const o = { dx: 0, dy: 0, scale: 1, alpha: 1 };
    for (let t = 0; t < 600_000; t += 7_000) {
      nebulaDrift(t, false, o);
      expect(Math.abs(o.dx)).toBeLessThanOrEqual(22);
      expect(Math.abs(o.dy)).toBeLessThanOrEqual(16);
      expect(Math.abs(o.scale - 1)).toBeLessThanOrEqual(0.03);
    }
    nebulaDrift(123_456, true, o);
    expect(o).toEqual({ dx: 0, dy: 0, scale: 1, alpha: 1 });
  });
});

describe('clipPolyAtX', () => {
  const flat = hexFlat(64);
  const area = (p: number[]): number => {
    let a = 0;
    for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      a += p[i]! * p[j + 1]! - p[j]! * p[i + 1]!;
    }
    return Math.abs(a) / 2;
  };
  it('the two halves add up to the hex, and the middle cut splits it evenly', () => {
    const l: number[] = [], r: number[] = [];
    clipPolyAtX(flat, 0, l, r);
    expect(area(l)).toBeCloseTo(area(flat) / 2, 3);
    expect(area(r)).toBeCloseTo(area(flat) / 2, 3);
    clipPolyAtX(flat, 20, l, r);
    expect(area(l) + area(r)).toBeCloseTo(area(flat), 3);
    expect(area(l)).toBeGreaterThan(area(r));
  });
  it('reuses the output buffers', () => {
    const l: number[] = [1, 2, 3], r: number[] = [];
    clipPolyAtX(flat, -10, l, r);
    for (let k = 0; k < l.length; k += 2) expect(l[k]!).toBeLessThanOrEqual(-10 + 1e-9);
  });
});

describe('GalaxyMotion (per-sector tween state)', () => {
  it('the first poll animates nothing', () => {
    const m = new GalaxyMotion(false);
    m.onFeed(feed('traders', control({ holderShare: 60, challenger: 'robots', challengerShare: 40, threat: 3 }), true), 0);
    expect(m.isAnimating(IDX, 0)).toBe(false);
    expect(m.flareAge(IDX, 0)).toBe(-1);
    expect(look(m, 'traders', 0).frac).toBeCloseTo(0.6);
    expect(m.isHot(IDX)).toBe(true);
  });

  it('a split line eases to its new share over SPLIT_EASE_MS', () => {
    const m = new GalaxyMotion(false);
    m.onFeed(feed('traders', control({ holderShare: 60, challenger: 'robots', challengerShare: 40 })), 0);
    m.onFeed(feed('traders', control({ holderShare: 40, challenger: 'robots', challengerShare: 60 })), 10_000);
    expect(look(m, 'traders', 10_000).frac).toBeCloseTo(0.6);
    const mid = look(m, 'traders', 10_000 + SPLIT_EASE_MS / 2).frac;
    expect(mid).toBeCloseTo(0.5);
    expect(m.isAnimating(IDX, 10_000 + SPLIT_EASE_MS / 2)).toBe(true);
    expect(look(m, 'traders', 10_000 + SPLIT_EASE_MS).frac).toBeCloseTo(0.4);
    expect(m.settle(IDX, 10_000 + SPLIT_EASE_MS)).toBe(true);
    expect(m.anyActive()).toBe(false);
  });

  it('a challenger sliding in starts from a whole hex; leaving slides it out', () => {
    const m = new GalaxyMotion(false);
    m.onFeed(feed('traders', control()), 0);
    m.onFeed(feed('traders', control({ holderShare: 60, challenger: 'robots', challengerShare: 40 })), 10_000);
    const start = look(m, 'traders', 10_001);
    expect(start.right).toBe('robots');
    expect(start.frac).toBeGreaterThan(0.99);
    m.settle(IDX, 20_000);
    m.onFeed(feed('traders', control()), 20_000);
    const leaving = look(m, 'traders', 20_000 + SPLIT_EASE_MS / 2);
    expect(leaving.right).toBe('robots');
    expect(leaving.frac).toBeCloseTo(0.8);
    expect(look(m, 'traders', 20_000 + SPLIT_EASE_MS).right).toBeNull();
  });

  it('a flip wipes the new owner across, then eases into the split', () => {
    const m = new GalaxyMotion(false);
    m.onFeed(feed('traders', control()), 0);
    m.onFeed(feed('robots', control({ holderShare: 55, challenger: 'traders', challengerShare: 45 })), 10_000);
    const w0 = look(m, 'robots', 10_000);
    expect(w0.wiping).toBe(true);
    expect(w0.left).toBe('robots');
    expect(w0.right).toBe('traders');
    expect(w0.frac).toBe(0);
    expect(look(m, 'robots', 10_000 + FLIP_WIPE_MS / 2).frac).toBeCloseTo(0.5);
    const after = look(m, 'robots', 10_000 + FLIP_WIPE_MS);
    expect(after.wiping).toBe(false);
    expect(after.frac).toBeGreaterThan(0.99);
    expect(look(m, 'robots', 10_000 + FLIP_WIPE_MS + SPLIT_EASE_MS).frac).toBeCloseTo(0.55);
  });

  it('new fighting flares; reduced motion snaps and never flares', () => {
    const m = new GalaxyMotion(false);
    m.onFeed(feed('traders', control({ threat: 0 })), 0);
    m.onFeed(feed('traders', control({ threat: 2 })), 10_000);
    expect(m.flareAge(IDX, 10_100)).toBe(100);
    expect(m.flareAge(IDX, 10_000 + FLARE_MS)).toBe(-1);

    const rm = new GalaxyMotion(true);
    rm.onFeed(feed('traders', control({ holderShare: 60, challenger: 'robots', challengerShare: 40 })), 0);
    rm.onFeed(feed('robots', control({ holderShare: 40, challenger: 'traders', challengerShare: 60, threat: 3 }), true), 10_000);
    expect(rm.isAnimating(IDX, 10_000)).toBe(false);
    expect(rm.flareAge(IDX, 10_000)).toBe(-1);
    expect(look(rm, 'robots', 10_000).frac).toBe(SPLIT_MIN_SIDE + 0.22);
    expect(rm.anyActive()).toBe(false);
  });
});
