import { describe, it, expect } from 'vitest';
import { structureRenderVerts } from './spriteBuilders.js';
import { structureHullPoints, STRUCTURE_SIDES } from '../../../shared-types/structureKinds.js';

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

  it('the TRIANGLE turret apex flips Y sign — NOT a no-op (the upside-down bug)', () => {
    expect(STRUCTURE_SIDES.turret).toBe(3); // odd ⇒ NOT Y-flip-invariant
    // Collider apex is at game (0, -r); the render must put it at (0, +r) so the
    // drawn silhouette coincides with the collider under pixiY=-gameY. Before the
    // fix the render used (0, -r) too ⇒ mirrored ⇒ upside down.
    const apex = structureRenderVerts('turret', 80)[0]!;
    expect(apex.x).toBeCloseTo(0, 6);
    expect(apex.y).toBeCloseTo(80, 6);
  });

  it('the PENTAGON miner apex flips Y sign too (same odd-sided bug)', () => {
    expect(STRUCTURE_SIDES.miner).toBe(5);
    expect(structureRenderVerts('miner', 80)[0]!.y).toBeCloseTo(80, 6);
  });

  it('even-sided structures keep every vertex on the radius circle (flip is a shape no-op)', () => {
    for (const id of ['capital', 'connector', 'solar'] as const) {
      const r = structureRenderVerts(id, 80);
      expect(r.length).toBe(STRUCTURE_SIDES[id]);
      for (const p of r) expect(Math.hypot(p.x, p.y)).toBeCloseTo(80, 6);
    }
  });

  it('does not mutate the shared collider source (fresh array each call)', () => {
    const colliderBefore = structureHullPoints('turret', 80)[0]!.y;
    structureRenderVerts('turret', 80);
    expect(structureHullPoints('turret', 80)[0]!.y).toBeCloseTo(colliderBefore, 6); // still -80
  });
});
