/**
 * The mining skiff (hull C, "Manta scoop") builds its physics collider through
 * the same path every ship uses: `shipShapeToPolygon` (scaled, math-up) →
 * poly-decomp convex parts → fan triangles → Rapier `triangle` colliders
 * (`PhysicsWorld.setHullExposed`). Locks that the outline splits cleanly, the
 * mounts sit on it, and a real Rapier world spawns and steps the hull.
 */
import { describe, it, expect } from 'vitest';
import { PhysicsWorld } from '../physics/World.js';
import { getShipKind } from '../../shared-types/shipKinds.js';
import { shipCollisionParts, shipCollisionTriangles, shipShapeToPolygon, signedArea } from './shipHullDecomp.js';
import type { Vec2 } from '../swarm/asteroidShape.js';

const ID = 'mining-skiff';

/** Every corner turns left: convex and CCW. */
function convexCcw(p: readonly Vec2[]): boolean {
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!, b = p[(i + 1) % p.length]!, c = p[(i + 2) % p.length]!;
    if ((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) < -1e-9) return false;
  }
  return true;
}

/** Point inside (or on) a CCW convex polygon. */
function insideCcw(p: readonly Vec2[], x: number, y: number): boolean {
  for (let i = 0; i < p.length; i++) {
    const a = p[i]!, b = p[(i + 1) % p.length]!;
    if ((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) < -1e-9) return false;
  }
  return true;
}

describe('mining skiff collider (hull C)', () => {
  const kind = getShipKind(ID);

  it('the outline splits into convex CCW parts whose area adds up to the hull', () => {
    const poly = shipShapeToPolygon(kind);
    const whole = Math.abs(signedArea(poly));
    const parts = shipCollisionParts(ID);
    expect(parts.length).toBeGreaterThan(0);
    // Not the default-kind fallback: the parts cover the skiff's own outline.
    let sum = 0;
    for (const part of parts) {
      expect(part.length).toBeGreaterThanOrEqual(3);
      expect(convexCcw(part)).toBe(true);
      sum += signedArea(part);
    }
    expect(Math.abs(sum - whole)).toBeLessThanOrEqual(whole * 1e-6);
    const tris = shipCollisionTriangles(ID);
    expect(tris.length).toBeGreaterThan(0);
    for (const t of tris) expect(signedArea(t)).toBeGreaterThan(0);
  });

  it('every mount sits inside the collider outline (same frame: math-up, scaled)', () => {
    const parts = shipCollisionParts(ID);
    for (const m of kind.mounts ?? []) {
      const on = parts.some((p) => insideCcw(p, m.localX, m.localY));
      expect(on, `${m.id} at (${m.localX.toFixed(1)}, ${m.localY.toFixed(1)})`).toBe(true);
    }
  });

  it('a Rapier world spawns the skiff, exposes its hull triangles and steps', async () => {
    const pw = await PhysicsWorld.create();
    pw.spawnShip('s', 0, 0, ID);
    pw.setHullExposed('s', true, kind);
    pw.setHullExposed('s', false, kind);
    pw.setHullExposed('s', true, kind);
    for (let t = 0; t < 30; t++) {
      pw.applyInput('s', { thrust: true, boost: false, turnLeft: false, turnRight: false });
      pw.tick(1 / 60);
    }
    const st = pw.getShipState('s')!;
    expect(Number.isFinite(st.x) && Number.isFinite(st.y)).toBe(true);
    expect(Math.hypot(st.vx, st.vy)).toBeGreaterThan(0);
  });
});
