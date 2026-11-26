/**
 * Base platforms slice 31 — road joins: arms toward neighbouring road hexes
 * and gate seams, the lone tile's own straight, 3+ arms = junction, and the
 * world → local arm slot mapping the overlay draws in.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { deckHexCentreInto } from '../../../core/hex/plates.js';
import { DECK_HEX_INRADIUS } from '../../../core/hex/deckCorners.js';
import type { StructureRenderState, SwarmRenderState } from '../../../core/contracts/IRenderer.js';
import {
  ROAD_STRAIGHT_MASK, armCount, deriveRoadArms, localArmSlot, resetRoadJoins, roadArmsOf, roadWorldJoins, syncRoadJoins,
  type RoadPiece,
} from './roadJoins.js';
import { ROAD_ARM_LEN, ROAD_HALF_W, roadOverlayPlan } from './structureStyleC.transport.road.js';

const C = deckHexCentreInto(3, 1, { x: 0, y: 0 });
/** The centre of the hex beyond world edge `i` of C (game angle 60°·i). */
const beyond = (i: number): { x: number; y: number } => {
  const a = (i * Math.PI) / 3;
  return { x: C.x + 2 * DECK_HEX_INRADIUS * Math.cos(a), y: C.y + 2 * DECK_HEX_INRADIUS * Math.sin(a) };
};
const seam = (i: number): { x: number; y: number } => {
  const a = (i * Math.PI) / 3;
  return { x: C.x + DECK_HEX_INRADIUS * Math.cos(a), y: C.y + DECK_HEX_INRADIUS * Math.sin(a) };
};
const piece = (id: number, p: { x: number; y: number }, rotDeg = 30, mirror = false): RoadPiece => ({ id, ...p, rotDeg, mirror });

describe('road joins (derived)', () => {
  it('the lone straight at turn 30° runs along world edges 2 and 5 (edge-mid to edge-mid)', () => {
    expect(localArmSlot(2, 30, false)).toBe(4);
    expect(localArmSlot(5, 30, false)).toBe(1);
    expect(ROAD_STRAIGHT_MASK).toBe((1 << 1) | (1 << 4));
    // Every snapped turn maps the six world edges onto the six local slots.
    for (const rot of [30, 90, 150, 210, 270, 330]) for (const m of [false, true]) {
      const slots = new Set([0, 1, 2, 3, 4, 5].map((i) => localArmSlot(i, rot, m)));
      expect(slots.size).toBe(6);
    }
  });

  it('a lone road keeps its own straight', () => {
    const out = deriveRoadArms([piece(1, C)], [], new Map());
    expect(out.get(1)).toBe(ROAD_STRAIGHT_MASK);
    // Turned 90°: still its own straight in its own frame.
    expect(deriveRoadArms([piece(1, C, 90)], [], new Map()).get(1)).toBe(ROAD_STRAIGHT_MASK);
  });

  it('joins neighbouring road hexes, never a hex two away', () => {
    const roads = [piece(1, C), piece(2, beyond(0)), piece(3, beyond(1)), piece(4, { x: C.x - 4 * DECK_HEX_INRADIUS, y: C.y })];
    const w = roadWorldJoins(roads, []);
    expect(w.get(1)).toBe(0b000011);
    expect(w.get(2)! & (1 << 3)).not.toBe(0); // the neighbour joins back
    expect(w.get(4)).toBe(0);
    // Two joins: a bend (no own straight, no junction).
    const local = deriveRoadArms(roads, [], new Map()).get(1)!;
    expect(armCount(local)).toBe(2);
    expect(local).toBe((1 << localArmSlot(0, 30, false)) | (1 << localArmSlot(1, 30, false)));
  });

  it('one join adds the own straight (an end tile shows its turn)', () => {
    // A join along the straight is just the straight.
    expect(deriveRoadArms([piece(1, C), piece(2, beyond(2))], [], new Map()).get(1)).toBe(ROAD_STRAIGHT_MASK);
    // A join off the straight's line: straight + that arm = 3 arms (junction).
    const m = deriveRoadArms([piece(1, C), piece(2, beyond(0))], [], new Map()).get(1)!;
    expect(m & ROAD_STRAIGHT_MASK).toBe(ROAD_STRAIGHT_MASK);
    expect(armCount(m)).toBe(3);
  });

  it('a shield gate on a seam is an arm for the road beside it', () => {
    const w = roadWorldJoins([piece(1, C), piece(2, beyond(3))], [seam(0), seam(3)]);
    expect(w.get(1)).toBe((1 << 0) | (1 << 3));
    // The gate on edge 3 of C is edge 0 of the hex beyond it.
    expect(w.get(2)! & 1).toBe(1);
    // A gate nowhere near a seam midpoint is ignored.
    expect(roadWorldJoins([piece(1, C)], [{ x: C.x + 100, y: C.y }]).get(1)).toBe(0);
  });

  it('three or more joins make a junction', () => {
    const roads = [piece(1, C), piece(2, beyond(0)), piece(3, beyond(2)), piece(4, beyond(4))];
    const m = deriveRoadArms(roads, [], new Map()).get(1)!;
    expect(armCount(m)).toBe(3);
    expect(roadOverlayPlan(m).junction).toBe(true);
    expect(roadOverlayPlan(ROAD_STRAIGHT_MASK).junction).toBe(false);
  });

  describe('live table', () => {
    beforeEach(() => resetRoadJoins());
    it('rebuilds from the mirror rows when a road is added', () => {
      const structures = new Map<number, StructureRenderState>();
      const swarm = new Map<number, SwarmRenderState>();
      const add = (id: number, p: { x: number; y: number }, kind: string, deg = 30): void => {
        structures.set(id, { mirror: false } as unknown as StructureRenderState);
        swarm.set(id, { x: p.x, y: p.y, angle: (deg * Math.PI) / 180, shipKind: kind } as unknown as SwarmRenderState);
      };
      add(1, C, 'road');
      syncRoadJoins(structures, swarm);
      expect(roadArmsOf(1)).toBe(ROAD_STRAIGHT_MASK);
      add(2, beyond(0), 'road');
      add(3, beyond(1), 'road');
      syncRoadJoins(structures, swarm);
      expect(armCount(roadArmsOf(1))).toBe(2);
      expect(roadArmsOf(undefined)).toBe(ROAD_STRAIGHT_MASK);
    });
  });
});

describe('road overlay plan', () => {
  it('arms reach the seam; edge lines end on it; lamps sit off every carriageway', () => {
    for (const mask of [ROAD_STRAIGHT_MASK, 0b000011, 0b000101, 0b010101, 0b111111]) {
      const plan = roadOverlayPlan(mask);
      for (const line of plan.edges) {
        const n = line.length;
        expect(Math.hypot(line[0]!, line[1]!)).toBeGreaterThan(ROAD_ARM_LEN - 1);
        expect(Math.hypot(line[n - 2]!, line[n - 1]!)).toBeGreaterThan(ROAD_ARM_LEN - 1);
      }
      expect(plan.edges.length).toBe(plan.slots.length);
      for (let i = 0; i < plan.lamps.length; i += 2) {
        const x = plan.lamps[i]!, y = plan.lamps[i + 1]!;
        for (const j of plan.slots) {
          const a = ((30 + 60 * j) * Math.PI) / 180;
          const along = x * Math.cos(a) + y * Math.sin(a), lat = Math.abs(-x * Math.sin(a) + y * Math.cos(a));
          expect(along > 0 && along < ROAD_ARM_LEN && lat < ROAD_HALF_W).toBe(false);
        }
      }
      expect(plan.lamps.length).toBeGreaterThan(0);
      expect(plan.dashes.length).toBeGreaterThan(0);
    }
  });
});
