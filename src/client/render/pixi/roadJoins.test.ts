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
import { ROAD_ARM_LEN, ROAD_HALF_W, ROAD_DASH_PERIOD, roadOverlayPlan } from './structureStyleC.transport.road.js';

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

  it('one join: a straight through it (a dead end, never a junction)', () => {
    // A join along the own straight is just the straight.
    expect(deriveRoadArms([piece(1, C), piece(2, beyond(2))], [], new Map()).get(1)).toBe(ROAD_STRAIGHT_MASK);
    // A join off it: that arm and the opposite edge, whatever the turn.
    for (const rot of [30, 90, 150]) {
      const m = deriveRoadArms([piece(1, C, rot), piece(2, beyond(0))], [], new Map()).get(1)!;
      expect(m).toBe((1 << localArmSlot(0, rot, false)) | (1 << localArmSlot(3, rot, false)));
      expect(armCount(m)).toBe(2);
      expect(roadOverlayPlan(m).junction).toBe(false);
    }
    // A gate seam counts as the one join too.
    expect(deriveRoadArms([piece(1, C)], [seam(1)], new Map()).get(1)).toBe((1 << localArmSlot(1, 30, false)) | (1 << localArmSlot(4, 30, false)));
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

describe('road centre dashes', () => {
  const MASKS = [ROAD_STRAIGHT_MASK, 0b000011, 0b000101, 0b010101, 0b000111, 0b001011, 0b111111];
  /** Per arm, its dash intervals along the arm (t0, t1), in order. */
  function intervals(mask: number): number[][][] {
    const plan = roadOverlayPlan(mask);
    return plan.slots.map((j) => {
      const a = ((30 + 60 * j) * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a);
      const out: number[][] = [];
      for (let i = 0; i < plan.dashes.length; i += 4) {
        const t0 = plan.dashes[i]! * ux + plan.dashes[i + 1]! * uy, t1 = plan.dashes[i + 2]! * ux + plan.dashes[i + 3]! * uy;
        const lat = Math.abs(-plan.dashes[i + 2]! * uy + plan.dashes[i + 3]! * ux);
        if (lat < 1e-6 && t1 > 1e-6) out.push([t0, t1]);
      }
      return out.sort((p, q) => p[0]! - q[0]!);
    });
  }

  it('the dash repeat fits the arm a whole number of times', () => {
    const n = ROAD_ARM_LEN / ROAD_DASH_PERIOD;
    expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9);
  });

  it('every arm ends in a half dash at the seam (the neighbour completes it: no seam gap)', () => {
    for (const mask of MASKS) for (const arm of intervals(mask)) {
      const last = arm[arm.length - 1]!;
      expect(last[1]).toBeCloseTo(ROAD_ARM_LEN, 6);
      expect(last[1]! - last[0]!).toBeCloseTo(30, 6);
    }
  });

  it('every arm starts with the same half dash at the centre (equal prongs; gaps even)', () => {
    for (const mask of MASKS) for (const arm of intervals(mask)) {
      expect(arm[0]![0]).toBeCloseTo(0, 6);
      expect(arm[0]![1]).toBeCloseTo(30, 6);
      for (let i = 1; i < arm.length; i++) expect(arm[i]![0]! - arm[i - 1]![1]!).toBeCloseTo(ROAD_DASH_PERIOD - 60, 6);
    }
  });
});
