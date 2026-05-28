/**
 * `LaserGlow` unit tests — plan M6 failing-test deliverable.
 *
 * Locks:
 *  - filter is attached ONCE at construct (high tier default)
 *  - applyQuality mutates filter params in place (no destroy/recreate)
 *  - 'medium' → both filters attached at reduced quality
 *  - 'low' → only LIVE filter attached (remote dropped first)
 *  - 'minimal' → both filters DETACHED (raw Graphics beams remain)
 *  - filter instance identity preserved across all tier transitions
 */

import { describe, expect, it, vi } from 'vitest';
import { LaserGlow, type GlowLike, type LaserGlowBeams, type LaserGlowFactories } from './LaserGlow';

function makeStubGfx(): Record<string, unknown> {
  return { filters: null };
}

function makeStubFilter(): GlowLike {
  return { outerStrength: 0, innerStrength: 0, quality: 0, color: 0 } as unknown as GlowLike;
}

function makeFactories(): LaserGlowFactories {
  return {
    makeGlowFilter: vi.fn((colour: number) => {
      const f = makeStubFilter();
      f.color = colour;
      return f;
    }),
  };
}

function makeBeams(): LaserGlowBeams {
  return {
    liveBeamGfx: makeStubGfx() as never,
    remoteBeamGfx: makeStubGfx() as never,
  };
}

describe('LaserGlow — construct', () => {
  it('attaches both filters at construct (default high tier)', () => {
    const beams = makeBeams();
    const glow = new LaserGlow(beams, makeFactories());
    expect(glow.isLiveAttached()).toBe(true);
    expect(glow.isRemoteAttached()).toBe(true);
    expect(glow.getCurrentLevel()).toBe('high');
  });

  it('sets per-tier params on each filter at construct', () => {
    const beams = makeBeams();
    const glow = new LaserGlow(beams, makeFactories());
    expect(glow.getLiveFilter().outerStrength).toBe(2);
    expect(glow.getLiveFilter().innerStrength).toBe(1);
    expect(glow.getLiveFilter().quality).toBe(0.2);
    expect(glow.getRemoteFilter().outerStrength).toBe(2);
  });
});

describe('LaserGlow — applyQuality dial', () => {
  it('"medium" lowers params but keeps both filters attached', () => {
    const beams = makeBeams();
    const glow = new LaserGlow(beams, makeFactories());
    glow.applyQuality('medium');
    expect(glow.isLiveAttached()).toBe(true);
    expect(glow.isRemoteAttached()).toBe(true);
    expect(glow.getLiveFilter().quality).toBe(0.1);
    expect(glow.getRemoteFilter().quality).toBe(0.1);
  });

  it('"low" detaches remote filter only', () => {
    const beams = makeBeams();
    const glow = new LaserGlow(beams, makeFactories());
    glow.applyQuality('low');
    expect(glow.isLiveAttached()).toBe(true);
    expect(glow.isRemoteAttached()).toBe(false);
  });

  it('"minimal" detaches both filters', () => {
    const beams = makeBeams();
    const glow = new LaserGlow(beams, makeFactories());
    glow.applyQuality('minimal');
    expect(glow.isLiveAttached()).toBe(false);
    expect(glow.isRemoteAttached()).toBe(false);
  });

  it('filter instance identity preserved across all tier transitions', () => {
    const beams = makeBeams();
    const glow = new LaserGlow(beams, makeFactories());
    const live = glow.getLiveFilter();
    const remote = glow.getRemoteFilter();
    for (const tier of ['high', 'medium', 'low', 'minimal', 'low', 'medium', 'high'] as const) {
      glow.applyQuality(tier);
    }
    expect(glow.getLiveFilter()).toBe(live);
    expect(glow.getRemoteFilter()).toBe(remote);
  });

  it('re-applying the same tier is idempotent (no re-attach churn)', () => {
    const beams = makeBeams();
    const glow = new LaserGlow(beams, makeFactories());
    glow.applyQuality('high'); // same as construct
    glow.applyQuality('high');
    expect(glow.isLiveAttached()).toBe(true);
    // Only one of each filter in the filters array, never duplicated.
    expect((beams.liveBeamGfx.filters as unknown[]).length).toBe(1);
    expect((beams.remoteBeamGfx.filters as unknown[]).length).toBe(1);
  });
});

describe('LaserGlow — tier round-trip', () => {
  it('high → minimal → high re-attaches with the high-tier params', () => {
    const beams = makeBeams();
    const glow = new LaserGlow(beams, makeFactories());
    glow.applyQuality('minimal');
    expect(glow.isLiveAttached()).toBe(false);
    glow.applyQuality('high');
    expect(glow.isLiveAttached()).toBe(true);
    expect(glow.getLiveFilter().outerStrength).toBe(2);
  });
});
