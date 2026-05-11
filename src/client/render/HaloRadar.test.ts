import { describe, it, expect } from 'vitest';
import {
  projectArrow,
  clamp,
  lerp,
  wedgeIndex,
  partitionAndGroupCandidates,
  type HaloProjectionParams,
  type Candidate,
} from './HaloRadar';

const baseParams: HaloProjectionParams = {
  // Phase E — radii are in screen pixels now (not world units). The
  // projection returns bearing + screen-pixel radius; the renderer composes
  // arrow.x/y from the player's screen position + cos/sin offsets.
  innerRadiusPx: 100,
  outerRadiusPx: 300,
  distMin: 200,
  distMax: 1000,
  scaleNear: 1.5,
  scaleFar: 0.5,
  visiblePadding: 0,
  // Bounds expressed in Pixi space (y-flipped). The local ship is at world
  // origin so its Pixi position is (0, 0); the visible square spans ±50 on
  // both axes — POIs further than 50 from origin are off-screen.
  visibleLeft: -50,
  visibleRight: 50,
  visibleTop: -50,
  visibleBottom: 50,
};

describe('HaloRadar projectArrow', () => {
  it('hides arrow when POI is on-screen', () => {
    const proj = projectArrow({ x: 0, y: 0 }, { x: 10, y: 10 }, baseParams);
    expect(proj.hidden).toBe(true);
  });

  it('hides arrow when POI sits exactly on the player (degenerate)', () => {
    const proj = projectArrow({ x: 0, y: 0 }, { x: 0, y: 0 }, baseParams);
    expect(proj.hidden).toBe(true);
  });

  it('returns innerRadiusPx + scaleNear for a near-distance POI', () => {
    // POI exactly at distMin world units east — bearing 0, radius lerps to
    // innerRadiusPx (100 px), scale to scaleNear (1.5).
    const proj = projectArrow({ x: 0, y: 0 }, { x: 200, y: 0 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.theta).toBeCloseTo(0);
    expect(proj.radiusPx).toBeCloseTo(100);
    expect(proj.scale).toBeCloseTo(1.5);
  });

  it('returns outerRadiusPx + scaleFar for a far-distance POI', () => {
    // POI well past distMax — clamps to t=1.
    const proj = projectArrow({ x: 0, y: 0 }, { x: 5000, y: 0 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.theta).toBeCloseTo(0);
    expect(proj.radiusPx).toBeCloseTo(300);
    expect(proj.scale).toBeCloseTo(0.5);
  });

  it('exponential curve compresses mid-band distance toward outer ring', () => {
    // Phase L — exp-saturation curve. The linear midpoint of the band
    // (arithmetic mean = 600 u for distMin=200/distMax=1000) is already
    // ~92 % of the way to outer. inner=100, outer=300 → radius lands
    // around 285. The user explicitly wanted this: most entities should
    // sit near the outer ring, only the very-close-to-distMin ones drop
    // toward inner.
    const proj = projectArrow({ x: 0, y: 0 }, { x: 600, y: 0 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.radiusPx).toBeGreaterThan(275);
    expect(proj.radiusPx).toBeLessThan(295);
  });

  it('only entities very close to distMin land near the inner ring', () => {
    // dist = 205 (just 5 u past distMin=200) — normalized ≈ 0.006 of the
    // band. With the exp-saturation curve and k=5, t ≈ 0.030 and the
    // arrow sits at radius ≈ 106 (innerRadiusPx = 100). This is the
    // "inner is reserved for super-close" contract the user asked for.
    const proj = projectArrow({ x: 0, y: 0 }, { x: 205, y: 0 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.radiusPx).toBeLessThan(115);
  });

  it('produces +π/2 bearing for a north-bearing POI (world y up)', () => {
    // World north = +y → theta = +π/2. The y-flip to screen space is the
    // renderer's job; this function returns world bearing. The radius is
    // covered by the curve-specific tests below.
    const proj = projectArrow({ x: 0, y: 0 }, { x: 0, y: 600 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.theta).toBeCloseTo(Math.PI / 2);
  });

  it('produces opposite-sign bearings for north vs south POIs', () => {
    const north = projectArrow({ x: 0, y: 0 }, { x: 0, y: 600 }, baseParams);
    const south = projectArrow({ x: 0, y: 0 }, { x: 0, y: -600 }, baseParams);
    expect(north.theta).toBeCloseTo(Math.PI / 2);
    expect(south.theta).toBeCloseTo(-Math.PI / 2);
  });

  it('respects visibility padding', () => {
    // POI at world (210, 0) — Pixi (210, 0). Outside visibleRight = 50.
    // dist = 210 ≥ distMin = 200 so the near-cutoff doesn't fire and the
    // padded vs unpadded behaviour isolates to the visibility test.
    const offScreen = projectArrow({ x: 0, y: 0 }, { x: 210, y: 0 }, baseParams);
    expect(offScreen.hidden).toBe(false);

    const padded = projectArrow(
      { x: 0, y: 0 },
      { x: 210, y: 0 },
      { ...baseParams, visiblePadding: 200 },
    );
    expect(padded.hidden).toBe(true);
  });

  it('hides when POI is closer than distMin (near cutoff)', () => {
    // POI at world (60, 0) — only just off-screen (visible square ±50,
    // padding 0). dist = 60, below distMin = 200. Phase H reads this as
    // "off-screen but too close to bother indicating" and hides the
    // arrow rather than pinning it at innerRadius.
    const proj = projectArrow({ x: 0, y: 0 }, { x: 60, y: 0 }, baseParams);
    expect(proj.hidden).toBe(true);
  });

  it('starts the lerp exactly at distMin (innerRadiusPx + scaleNear)', () => {
    // POI exactly at distMin world units east — bearing 0, radius at
    // innerRadiusPx, scale at scaleNear. Same case as the near-distance
    // test above but stated as a lerp-boundary invariant.
    const proj = projectArrow({ x: 0, y: 0 }, { x: 200, y: 0 }, baseParams);
    expect(proj.hidden).toBe(false);
    expect(proj.radiusPx).toBeCloseTo(100);
    expect(proj.scale).toBeCloseTo(1.5);
  });

  it('returns bearing relative to the player, not the world origin', () => {
    // Player at (1000, 500); POI 600 east of player. Asserts the
    // bearing math is player-relative (not world-relative). Radius is
    // covered by curve-specific tests.
    const proj = projectArrow({ x: 1000, y: 500 }, { x: 1600, y: 500 }, {
      ...baseParams,
      visibleLeft: 950,
      visibleRight: 1050,
      visibleTop: -550,
      visibleBottom: -450,
    });
    expect(proj.hidden).toBe(false);
    expect(proj.theta).toBeCloseTo(0); // east bearing in world space
  });
});

describe('HaloRadar math primitives', () => {
  it('clamp respects the bounds', () => {
    expect(clamp(0.5, 0, 1)).toBe(0.5);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(2, 0, 1)).toBe(1);
  });

  it('lerp interpolates linearly', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });
});

describe('HaloRadar wedgeIndex', () => {
  // 24 wedges total: wedge 0 starts at theta = -π (west) and wraps east at
  // theta = +π. Each wedge covers 2π/24 ≈ 0.2618 rad.
  it('east-bearing POI lands in the middle wedge', () => {
    // theta = atan2(0, 1) = 0 → t = 0.5 → floor(0.5 * 24) = 12.
    expect(wedgeIndex(1, 0)).toBe(12);
  });
  it('north-bearing POI lands at three-quarters round', () => {
    // theta = atan2(1, 0) = π/2 → t = 0.75 → floor(0.75 * 24) = 18.
    expect(wedgeIndex(0, 1)).toBe(18);
  });
  it('south-bearing POI lands at one-quarter round', () => {
    // theta = atan2(-1, 0) = -π/2 → t = 0.25 → floor(0.25 * 24) = 6.
    expect(wedgeIndex(0, -1)).toBe(6);
  });
  it('west-bearing POI lands in the last wedge (π-edge clamp)', () => {
    // theta = atan2(0, -1) = π → t = 1.0 → floor(24) = 24, clamps to 23.
    expect(wedgeIndex(-1, 0)).toBe(23);
  });
  it('two POIs on the same side of a wedge edge share a wedge', () => {
    // atan2(±5, 100) straddles the east-zero boundary (theta = 0, which is
    // exactly the edge between wedge 11 and wedge 12). Two POIs *on the
    // same side* of an interior wedge boundary, however, must share a
    // wedge — pick bearings clearly inside wedge 12 (theta > 0).
    expect(wedgeIndex(100, 5)).toBe(wedgeIndex(100, 20));
  });
  it('respects custom wedge counts', () => {
    expect(wedgeIndex(1, 0, 4)).toBe(2);   // 4-quadrant → east = quadrant 2
    expect(wedgeIndex(0, 1, 4)).toBe(3);   // north = quadrant 3
  });
});

describe('HaloRadar partitionAndGroupCandidates', () => {
  const local = { x: 0, y: 0 };

  function mk(key: string, x: number, y: number, color: number): Candidate {
    return { key, x, y, color, dist: Math.hypot(x, y) };
  }

  it('keeps near-band singletons unmerged', () => {
    const candidates: Candidate[] = [
      mk('a', 100, 0, 0x111111),
      mk('b', 0, 1500, 0x222222),
    ];
    const result = partitionAndGroupCandidates(local, candidates, 2500, 8000, 24);
    expect(result.map((c) => c.key).sort()).toEqual(['a', 'b']);
  });

  it('drops candidates past max distance', () => {
    const candidates: Candidate[] = [
      mk('near', 500, 0, 0x111111),
      mk('far',  9000, 0, 0x222222),
    ];
    const result = partitionAndGroupCandidates(local, candidates, 2500, 8000, 24);
    expect(result.map((c) => c.key)).toEqual(['near']);
  });

  it('collapses multi-member wedges to the closest representative with wedge key', () => {
    // Three drones east of the player at varying distance, all in the same
    // wedge (east bearing). Two are in the grouping band; the closest of
    // the two represents the wedge.
    const candidates: Candidate[] = [
      mk('east-far',     7000, 0, 0xff0000),
      mk('east-closer',  4000, 0, 0x00ff00),
      mk('east-closest', 3000, 0, 0x0000ff),
    ];
    const result = partitionAndGroupCandidates(local, candidates, 2500, 8000, 24);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('wedge:12'); // east-bearing wedge
    expect(result[0]!.x).toBe(3000);
    expect(result[0]!.color).toBe(0x0000ff); // inherits closest entity's colour
  });

  it('groups across separate wedges independently', () => {
    const candidates: Candidate[] = [
      mk('east',  4000, 0, 0xff0000),
      mk('north', 0, 4000, 0x00ff00),
    ];
    const result = partitionAndGroupCandidates(local, candidates, 2500, 8000, 24);
    expect(result.map((c) => c.key).sort()).toEqual(['wedge:12', 'wedge:18']);
  });

  it('mixes near singletons + far wedge representatives in one frame', () => {
    const candidates: Candidate[] = [
      mk('near-singleton', 1000, 0, 0xffffff),    // 1000 < 2500 — passes through
      mk('far-east-a',     3000, 100, 0xaaaaaa),  // wedge 12
      mk('far-east-b',     4000, 0, 0xbbbbbb),    // wedge 12 — dropped (a is closer)
    ];
    const result = partitionAndGroupCandidates(local, candidates, 2500, 8000, 24);
    const keys = result.map((c) => c.key).sort();
    expect(keys).toEqual(['near-singleton', 'wedge:12']);
    const wedge = result.find((c) => c.key === 'wedge:12');
    expect(wedge!.x).toBe(3000);
  });

  it('orbits the player position when computing wedges', () => {
    // Player at (1000, 500); far POI 4000u east of player.
    const localOffset = { x: 1000, y: 500 };
    const c: Candidate = { key: 'p', x: 5000, y: 500, color: 0, dist: 4000 };
    const result = partitionAndGroupCandidates(localOffset, [c], 2500, 8000, 24);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('wedge:12'); // east from the player's frame
  });
});
