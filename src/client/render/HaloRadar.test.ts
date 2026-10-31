/**
 * Radar unit locks. The ring-radius `projectArrow` tests were retired with the
 * ring projection (plan sparkling-wondering-rose — distance is now size +
 * opacity on an edge track; geometry locks live in `halo/edgeRadar.test.ts`).
 * The contact → category map and the wedge grouping remain.
 */
import { describe, it, expect } from 'vitest';
import {
  wedgeIndex,
  partitionAndGroupCandidates,
  type Candidate,
} from './halo/wedgeGrouping';
import { radarCategoryForSwarm } from './halo/arrowGraphics';

describe('radarCategoryForSwarm — contact → radar category', () => {
  it('maps every pose-core kind to its category (visibility is a preference, not this map)', () => {
    expect(radarCategoryForSwarm(0, false)).toBe('asteroid');
    expect(radarCategoryForSwarm(2, false)).toBe('structure');
    expect(radarCategoryForSwarm(3, false)).toBe('scrap');
  });
  it('classifies a drone by hostility to the local player', () => {
    expect(radarCategoryForSwarm(1, true)).toBe('hostile');
    expect(radarCategoryForSwarm(1, false)).toBe('neutral');
  });
  it('never shows an unknown kind', () => {
    expect(radarCategoryForSwarm(7, false)).toBeNull();
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
      mk('east2', 4500, 50, 0xff0000),
      mk('north', 0, 4000, 0x00ff00),
      mk('north2', -50, 4500, 0x00ff00),
    ];
    const result = partitionAndGroupCandidates(local, candidates, 2500, 8000, 24);
    expect(result.map((c) => c.key).sort()).toEqual(['wedge:12', 'wedge:18']);
  });

  it('a wedge holding a SINGLE contact emits the contact itself, not a group', () => {
    const result = partitionAndGroupCandidates(local, [mk('lone', 4000, 0, 0xff0000)], 2500, 8000, 24);
    expect(result.map((c) => c.key)).toEqual(['lone']);
    expect(result[0]!.grouped).not.toBe(true);
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
    const c2: Candidate = { key: 'p2', x: 5500, y: 520, color: 0, dist: 4500 };
    const result = partitionAndGroupCandidates(localOffset, [c, c2], 2500, 8000, 24);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe('wedge:12'); // east from the player's frame
  });
});
