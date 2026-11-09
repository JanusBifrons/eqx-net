/**
 * Geometry-property tests for the HAVOK composite ship kind (composite-ships
 * Phase 1, Step F). Asserts the Equinox port produced a coherent silhouette:
 *  - the cockpit BODY's forward-most point is at min-y (nose points -y, the
 *    Pixi-up forward convention)
 *  - the left/right wing parts are mirror-symmetric about x=0
 *  - the catalogue `radius` matches the bounding circle of all part points
 *    (post shape.scale)
 *  - the kind parses against ShipKindSchema and is a composite with 23 parts
 *    (7 component silhouettes + 16 detail shapes) and a non-degenerate hull.
 */
import { describe, it, expect } from 'vitest';
import { HAVOK } from '../../src/shared-types/shipKinds/composite/havok.js';
import { ShipKindSchema, type ShipCompositeShape, type ShipPart } from '../../src/shared-types/shipKinds.js';

function compositeShape(): ShipCompositeShape {
  expect(HAVOK.shape.kind).toBe('composite');
  if (HAVOK.shape.kind !== 'composite') throw new Error('not composite');
  return HAVOK.shape;
}

function partByRole(shape: ShipCompositeShape, role: string): ShipPart {
  const p = shape.parts.find((x) => x.role === role);
  expect(p, `part with role '${role}'`).toBeDefined();
  return p!;
}

describe('HAVOK composite kind', () => {
  it('parses against ShipKindSchema', () => {
    expect(() => ShipKindSchema.parse(HAVOK)).not.toThrow();
  });

  it('is a composite with 23 parts (7 silhouettes + 16 detail shapes) and a hull', () => {
    const shape = compositeShape();
    expect(shape.parts).toHaveLength(23);
    expect(shape.hull.length).toBeGreaterThanOrEqual(3);
    // The iconic green cockpit dome is present and non-scrappable.
    const dome = partByRole(shape, 'cockpit-dome');
    expect(dome.color).toBe(0x33dd55);
    expect(dome.canScrap).toBe(false);
    // The dome is an 8-point ellipse (the scale(1.75,1) skew).
    expect(dome.points).toHaveLength(8);
  });

  it('cockpit body nose is at -y on the centreline (nose points -y)', () => {
    const shape = compositeShape();
    const cockpit = partByRole(shape, 'cockpit');
    // The cockpit body's forward-most point (its nose) sits on the centreline
    // (x ≈ 0) at a negative y — the Pixi-up forward convention. (The flanking
    // pads extend marginally further forward off-centre, which is expected for
    // the Equinox silhouette, so we assert the cockpit nose's *direction*, not
    // that it owns the global min-y.)
    const nose = cockpit.points.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(nose[0]).toBeCloseTo(0, 6);
    expect(nose[1]).toBeLessThan(0);
    // It is the forward-most point ON the centreline across the whole ship.
    let centrelineMinY = Infinity;
    for (const part of shape.parts) {
      for (const [x, y] of part.points) {
        if (Math.abs(x) < 1e-6) centrelineMinY = Math.min(centrelineMinY, y);
      }
    }
    expect(nose[1]).toBeCloseTo(centrelineMinY, 6);
  });

  it('left/right wings are mirror-symmetric about x=0', () => {
    const shape = compositeShape();
    const left = partByRole(shape, 'wing-l');
    const right = partByRole(shape, 'wing-r');
    expect(left.points).toHaveLength(right.points.length);
    // For every [x,y] in the left wing there is a [-x,y] in the right wing.
    for (const [lx, ly] of left.points) {
      const match = right.points.some(
        ([rx, ry]) => Math.abs(rx - -lx) < 1e-6 && Math.abs(ry - ly) < 1e-6,
      );
      expect(match, `mirror of [${lx},${ly}] in right wing`).toBe(true);
    }
  });

  it('rear wings are also mirror-symmetric about x=0', () => {
    const shape = compositeShape();
    const left = partByRole(shape, 'rear-wing-l');
    const right = partByRole(shape, 'rear-wing-r');
    for (const [lx, ly] of left.points) {
      const match = right.points.some(
        ([rx, ry]) => Math.abs(rx - -lx) < 1e-6 && Math.abs(ry - ly) < 1e-6,
      );
      expect(match, `mirror of [${lx},${ly}] in right rear wing`).toBe(true);
    }
  });

  it('catalogue radius matches the bounding circle of all part points (post-scale)', () => {
    const shape = compositeShape();
    let maxMag = 0;
    for (const part of shape.parts) {
      for (const [x, y] of part.points) {
        maxMag = Math.max(maxMag, Math.hypot(x, y));
      }
    }
    const boundingRadius = maxMag * shape.scale;
    expect(HAVOK.radius).toBe(Math.round(boundingRadius));
    // The chosen scale targets a ~20 u bounding radius.
    expect(boundingRadius).toBeGreaterThan(18);
    expect(boundingRadius).toBeLessThan(22);
  });

  it('carries the legacy single forward mount + primary slot', () => {
    expect(HAVOK.mounts).toHaveLength(1);
    expect(HAVOK.mounts![0]!.id).toBe('forward');
    expect(HAVOK.slots).toHaveLength(1);
    expect(HAVOK.slots![0]!.id).toBe('primary');
  });

  it('is engineeringOnly (kept out of the random ambient spawn pool)', () => {
    expect(HAVOK.engineeringOnly).toBe(true);
  });
});
