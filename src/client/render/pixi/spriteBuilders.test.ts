import { describe, it, expect } from 'vitest';
import { structureRenderVerts, formatResources } from './spriteBuilders.js';
import { buildStructureVisual } from './structureVisuals.js';
import { structureHullPoints, STRUCTURE_KINDS_LIST } from '../../../shared-types/structureKinds.js';

describe('formatResources (WS-9/R2.12 capital readout)', () => {
  it('is short-form so a 2,000,000-cap bank reads legibly', () => {
    expect(formatResources(0)).toBe('0');
    expect(formatResources(999)).toBe('999');
    expect(formatResources(12_345)).toBe('12.3k');
    expect(formatResources(2_300_000)).toBe('2.3M');
    expect(formatResources(1_000)).toBe('1.0k');
  });
});

/**
 * R2.13 (WS-7) — the structure SILHOUETTE must match its COLLIDER. The collider
 * consumes `structureHullPoints` in GAME space (Y-up); the renderer must apply
 * the standard `pixiY = -gameY` flip via `structureRenderVerts`. Drawing the
 * collider points directly rendered the ODD-sided turret (3) + miner (5)
 * upside-down vs their colliders ("the collision box is right but the turret
 * appears upside down"). Even-sided structures are Y-flip-invariant.
 */
describe('structureRenderVerts (R2.13 — render matches collider)', () => {
  it('is exactly the pixiY=-gameY flip of the collider hull points', () => {
    const collider = structureHullPoints('turret', 80);
    const render = structureRenderVerts('turret', 80);
    expect(render.length).toBe(collider.length);
    for (let i = 0; i < render.length; i++) {
      expect(render[i]!.x).toBeCloseTo(collider[i]!.x, 6);
      expect(render[i]!.y).toBeCloseTo(-collider[i]!.y, 6);
    }
  });

  it('phase V: the drawn structure covers exactly its collider box (render == collision)', () => {
    // Structures are footprint rectangles now (plan soft-leaping-truffle v2).
    // The R2.13 class of bug (drawn shape mirrored vs collider) cannot recur for
    // a rectangle, but the draw plan must still fill the collider's box: lock
    // that every kind's plan stays inside the footprint and spans it.
    for (const k of STRUCTURE_KINDS_LIST) {
      const plan = buildStructureVisual(k.id, { accent: k.color });
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const r of plan.rects) {
        minX = Math.min(minX, r.x); maxX = Math.max(maxX, r.x + r.w);
        minY = Math.min(minY, r.y); maxY = Math.max(maxY, r.y + r.h);
      }
      const hw = k.footprint.w / 2, hh = k.footprint.h / 2;
      expect(minX, k.id).toBeGreaterThanOrEqual(-hw - 0.5);
      expect(maxX, k.id).toBeLessThanOrEqual(hw + 0.5);
      expect(minY, k.id).toBeGreaterThanOrEqual(-hh - 0.5);
      expect(maxY, k.id).toBeLessThanOrEqual(hh + 0.5);
      // Spans the box (within the rim/inset slack of the plan).
      expect(maxX - minX, k.id).toBeGreaterThanOrEqual(k.footprint.w * 0.9);
      expect(maxY - minY, k.id).toBeGreaterThanOrEqual(k.footprint.h * 0.9);
    }
  });

  it('does not mutate the shared collider source (fresh array each call)', () => {
    const colliderBefore = structureHullPoints('turret', 80)[0]!.y;
    structureRenderVerts('turret', 80);
    expect(structureHullPoints('turret', 80)[0]!.y).toBeCloseTo(colliderBefore, 6); // still -80
  });
});
