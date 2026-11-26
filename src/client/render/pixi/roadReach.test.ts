/**
 * Junction sign boards — the junction cache (`roadJoins.ts`) and the road
 * walk (`roadReach.ts`) on small hand-built decks: a straight, a Y junction,
 * a plate building beside the road and a building beyond a bend.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { axialToPixelInto, HEX_DIRS } from '../../../core/hex/hex.js';
import { DECK_HEX_SIZE, deckHexCentreInto } from '../../../core/hex/plates.js';
import { rhombusCentroidInto } from '../../../core/hex/deckSnap.js';
import type { StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import { JUNCTIONS, hexKey, resetRoadJoins, syncRoadJoins } from './roadJoins.js';
import { JOIN_HEX_DIR, armReach, isSignPlaceKind, siteHexes, walkJunctionArms, type SignSite } from './roadReach.js';

type Hex = readonly [number, number];
const roadSet = (hexes: readonly Hex[]): Set<number> => new Set(hexes.map(([q, r]) => hexKey(q, r)));
const site = (kind: string, [q, r]: Hex): SignSite => ({ kind, ...deckHexCentreInto(q, r, { x: 0, y: 0 }) });

/** A Y junction at (0,0): arms east (dir 0), 120° (dir 2) and 240° (dir 4). */
const Y_ROADS: readonly Hex[] = [[0, 0], [1, 0], [2, 0], [3, 0], [-1, 1], [-2, 2], [0, -1], [0, -2]];

describe('junction sign road walk', () => {
  it('join bit i is the HEX_DIRS neighbour at game angle 60°·i', () => {
    for (let i = 0; i < 6; i++) {
      const d = HEX_DIRS[JOIN_HEX_DIR[i]!]!;
      const p = axialToPixelInto(d.q, d.r, DECK_HEX_SIZE, { x: 0, y: 0 });
      expect(Math.round((Math.atan2(p.y, p.x) * 180) / Math.PI + 360) % 360).toBe(60 * i);
    }
  });

  it('a straight road: steps count out along it, nothing comes back through the start', () => {
    const roads = roadSet([[0, 0], [1, 0], [2, 0], [3, 0], [-1, 0]]);
    const east = armReach(0, 0, 0, roads);
    expect([...east.values()].sort()).toEqual([1, 2, 3]);
    expect(east.has(hexKey(-1, 0))).toBe(false);
    expect(armReach(0, 0, 1, roads).size).toBe(0);
  });

  it('a Y junction lists the nearest two distinct places per arm, nearest first', () => {
    const sites: SignSite[] = [
      site('refinery', [3, -1]), // beside (2,0) and (3,0): 2 steps east
      { kind: 'hydroponics', ...rhombusCentroidInto(...xy(1, 1), 0, { x: 0, y: 0 }) }, // small slot beside (1,0): 1 step
      site('refinery', [3, 1]), // a second refinery: the sign names a kind once
      site('fabricator', [4, -1]), // 3 steps: past the two-place cap
      site('smelter', [-2, 1]), // beside (-1,1): 1 step down the 120° arm
      site('road', [5, 5]), site('shield_pylon', [-1, -1]), // never places
    ];
    const arms = walkJunctionArms(0, 0, roadSet(Y_ROADS), sites);
    expect(arms.map((a) => a.dir)).toEqual([0, 2, 4]);
    expect(arms[0]!.places.map((p) => [p.kind, p.steps])).toEqual([['hydroponics', 1], ['refinery', 2]]);
    expect(arms[1]!.places.map((p) => p.kind)).toEqual(['smelter']);
    expect(arms[2]!.places).toEqual([]);
    expect(arms[0]!.places[1]!.name).toBe('Refinery');
    expect(typeof arms[0]!.places[1]!.color).toBe('number');
  });

  it('a plate building beside the road counts its whole plate, not its middle hex', () => {
    const roads = roadSet([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
    const tp = site('teleporter_large', [3, -2]); // plate (1,-1): middle (3,-2), ring reaches (2,-1), (3,-1)
    expect(siteHexes(tp.kind, tp.x, tp.y)).toHaveLength(7);
    const arms = walkJunctionArms(0, 0, roads, [tp]);
    expect(arms[0]!.places.map((p) => [p.kind, p.steps])).toEqual([['teleporter_large', 1]]);
    // The same spot as a one-hex building is not beside the road.
    expect(walkJunctionArms(0, 0, roads, [site('smelter', [3, -2])])[0]!.places).toEqual([]);
  });

  it('a building beyond a bend is found down the arm it bends from', () => {
    const roads = roadSet([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [2, 3], [-1, 1], [0, -1]]);
    const arms = walkJunctionArms(0, 0, roads, [site('refinery', [3, 3])]);
    expect(arms.find((a) => a.dir === 0)!.places.map((p) => [p.kind, p.steps])).toEqual([['refinery', 5]]);
  });

  it('places: not roads, gates, pylons, connectors, cargo or weapons', () => {
    for (const k of ['road', 'shield_gate', 'shield_airlock', 'shield_pylon', 'connector', 'cargo_bay', 'turret', 'nonsense']) expect(isSignPlaceKind(k)).toBe(false);
    for (const k of ['refinery', 'smelter', 'teleporter_large', 'shipyard']) expect(isSignPlaceKind(k)).toBe(true);
  });

  describe('junction cache', () => {
    beforeEach(() => resetRoadJoins());
    it('is filled by the road-join rebuild: only 3+ joins, centre, mask and road hexes', () => {
      const structures = new Map<number, StructureRenderState>();
      const swarm = new Map<number, SwarmRenderState>();
      Y_ROADS.forEach(([q, r], i) => {
        const p = deckHexCentreInto(q, r, { x: 0, y: 0 });
        structures.set(i + 1, { mirror: false } as unknown as StructureRenderState);
        swarm.set(i + 1, { x: p.x, y: p.y, angle: Math.PI / 6, shipKind: 'road' } as unknown as SwarmRenderState);
      });
      const epoch = JUNCTIONS.epoch;
      syncRoadJoins(structures, swarm);
      expect(JUNCTIONS.epoch).toBeGreaterThan(epoch);
      expect(JUNCTIONS.count).toBe(1);
      expect([JUNCTIONS.q[0], JUNCTIONS.r[0], JUNCTIONS.mask[0]]).toEqual([0, 0, 0b10101]);
      expect([JUNCTIONS.x[0], JUNCTIONS.y[0]]).toEqual([0, 0]);
      expect(JUNCTIONS.roadHexes).toEqual(roadSet(Y_ROADS));
      // A straight has no junction.
      structures.delete(6); structures.delete(7); structures.delete(8); structures.delete(5); structures.delete(4);
      syncRoadJoins(structures, swarm);
      expect(JUNCTIONS.count).toBe(0);
    });
  });
});

function xy(q: number, r: number): [number, number] {
  const p = deckHexCentreInto(q, r, { x: 0, y: 0 });
  return [p.x, p.y];
}
