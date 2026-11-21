/**
 * Smoke test 2026-11-21 (phone): a long thin line ran from far off-screen to
 * the left foot of every locked sector's padlock shackle. The shackle was
 * `moveTo(arc start)` + `arc()`: Pixi v8's `arc()` pushes its own start point,
 * so the stroke polygon began with two identical points, `buildLine` divided
 * the first segment's normal by a zero length, and the GPU got NaN vertices
 * (a phone GPU draws them at the Graphics' local origin). Tested on the real
 * tessellated geometry Pixi uploads.
 */
import { describe, it, expect } from 'vitest';
import { Graphics } from 'pixi.js';
import type { SectorControl } from '../../../shared-types/galaxySnapshot.js';
import { drawFlipRing, drawSectorControl, hexVertices } from './galaxyHexDraw';
import { strokeVertices } from '../strokeVertices.testutil';

const LOCKED: SectorControl = {
  holderShare: 60, challenger: null, challengerShare: 0, trend: 0, threat: 2, flippedAtMs: null, locked: true,
};

describe('galaxy hex arcs tessellate cleanly (no stray line to the origin)', () => {
  it('locked padlock after threat brackets: every vertex finite and near the sector', () => {
    const g = new Graphics();
    g.circle(500, 500, 4).fill({ color: 0xffffff });
    drawSectorControl(g, hexVertices(40), 40, 500, 500, LOCKED, 'p1');
    const v = strokeVertices(g);
    expect(v.length).toBeGreaterThan(0);
    for (const n of v) expect(Number.isFinite(n)).toBe(true);
    for (const n of v) expect(Math.abs(n - 500)).toBeLessThan(60);
  });

  it('flip ring dashes: every vertex finite and on the ring', () => {
    const g = new Graphics();
    drawFlipRing(g, 500, 500, 30, 0xffffff);
    const v = strokeVertices(g);
    expect(v.length).toBeGreaterThan(0);
    for (const n of v) expect(Number.isFinite(n)).toBe(true);
    for (const n of v) expect(Math.abs(n - 500)).toBeLessThan(40);
  });
});
