/**
 * Roads line up by themselves (owner 2026-11-27): a player's road takes its
 * turn from its neighbours (`roadJoinBits` → `roadAutoTurnDeg`), not from
 * Rotate. The carriageway (local y) runs along game angle rot ± 90°.
 */
import { describe, it, expect } from 'vitest';
import { DECK_ROAD_KIND, ROAD_DEFAULT_TURN_DEG, ROAD_GATE_SHIFT, roadAutoTurnDeg, roadJoinBits } from './deckGateRoad.js';
import { snapPlacementToDeck, type RoadJoinsAt } from './deckPlacement.js';
import { DECK_FENCE_GATE_KIND } from './deckLinks.js';
import { deckHexCentreInto, DECK_HEX_FLAT } from '../hex/plates.js';
import { DECK_HEX_INRADIUS } from '../hex/deckCorners.js';
import type { DeckSnap } from '../hex/deckSnap.js';

const Q = 2, R = 1;
const C = deckHexCentreInto(Q, R, { x: 0, y: 0 });
const at = (i: number, d: number): [number, number] => [C.x + d * Math.cos((i * Math.PI) / 3), C.y + d * Math.sin((i * Math.PI) / 3)];
/** Does the carriageway at turn `rot` run through edge `i` (game angle 60°·i)? */
const runsThrough = (rot: number, i: number): boolean => ((((rot - 90 - 60 * i) % 180) + 180) % 180) === 0;

describe('roadJoinBits: one structure, one hex', () => {
  it('a road in each neighbouring hex sets that edge bit; the same hex, far hexes and other kinds set nothing', () => {
    for (let i = 0; i < 6; i++) {
      const [x, y] = at(i, DECK_HEX_FLAT);
      expect(roadJoinBits(Q, R, DECK_ROAD_KIND, x, y)).toBe(1 << i);
      expect(roadJoinBits(Q, R, 'reactor', x, y)).toBe(0);
    }
    expect(roadJoinBits(Q, R, DECK_ROAD_KIND, C.x, C.y)).toBe(0);
    const [fx, fy] = at(0, 2 * DECK_HEX_FLAT);
    expect(roadJoinBits(Q, R, DECK_ROAD_KIND, fx, fy)).toBe(0);
  });

  it('a shield gate on one of the hex seams sets that edge gate bit', () => {
    for (let i = 0; i < 6; i++) {
      const [x, y] = at(i, DECK_HEX_INRADIUS);
      expect(roadJoinBits(Q, R, DECK_FENCE_GATE_KIND, x, y)).toBe(1 << (ROAD_GATE_SHIFT + i));
    }
    expect(roadJoinBits(Q, R, DECK_FENCE_GATE_KIND, C.x, C.y)).toBe(0);
  });
});

describe('roadAutoTurnDeg', () => {
  it('a lone road takes the default turn (a 30° + 60°·k step)', () => {
    expect(roadAutoTurnDeg(0)).toBe(ROAD_DEFAULT_TURN_DEG);
    expect(((ROAD_DEFAULT_TURN_DEG % 60) + 60) % 60).toBe(30);
  });

  it('continues a road in any neighbouring hex', () => {
    for (let i = 0; i < 6; i++) {
      const rot = roadAutoTurnDeg(1 << i);
      expect(runsThrough(rot, i), `edge ${i} → ${rot}`).toBe(true);
      expect(((rot % 60) + 60) % 60).toBe(30);
    }
  });

  it('meets a gate on one of its seams', () => {
    for (let i = 0; i < 6; i++) expect(runsThrough(roadAutoTurnDeg(1 << (ROAD_GATE_SHIFT + i)), i)).toBe(true);
  });

  it('a road beside it beats a gate; the axis with roads on both sides wins', () => {
    expect(runsThrough(roadAutoTurnDeg((1 << 1) | (1 << (ROAD_GATE_SHIFT + 0))), 1)).toBe(true);
    // Roads across edges 2 and 5 (one line) plus a single road on edge 0: the line wins.
    expect(runsThrough(roadAutoTurnDeg((1 << 0) | (1 << 2) | (1 << 5)), 2)).toBe(true);
  });
});

describe('snapPlacementToDeck: a player road turns itself', () => {
  const out: DeckSnap = { x: 0, y: 0, q: 0, r: 0, rhombus: -1, slot: 'hex', rot: -1 };
  it('ignores the player turn and lines up with the neighbour the joins report', () => {
    const [nx, ny] = at(1, DECK_HEX_FLAT);
    const joinsAt: RoadJoinsAt = (q, r) => roadJoinBits(q, r, DECK_ROAD_KIND, nx, ny);
    for (const playerRot of [0, 90, 150, 270]) {
      snapPlacementToDeck(DECK_ROAD_KIND, C.x + 30, C.y - 20, out, playerRot, joinsAt);
      expect([out.x, out.y]).toEqual([C.x, C.y]);
      expect(runsThrough(out.rot, 1), `player ${playerRot}`).toBe(true);
    }
    snapPlacementToDeck(DECK_ROAD_KIND, C.x, C.y, out, 270, () => 0);
    expect(out.rot).toBe(ROAD_DEFAULT_TURN_DEG);
  });

  it('without joins (generated bases) the given turn still snaps', () => {
    snapPlacementToDeck(DECK_ROAD_KIND, C.x, C.y, out, 270);
    expect(out.rot).toBe(270);
  });
});
