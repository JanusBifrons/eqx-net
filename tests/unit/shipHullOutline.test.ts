import { describe, it, expect } from 'vitest';
import {
  shipHullOutline,
  shipShapeScale,
  shipPrimaryColor,
} from '../../src/core/geometry/shipHullOutline.js';
import { SHIP_KINDS, type ShipKind } from '../../src/shared-types/shipKinds.js';

/**
 * The seam (`shipHullOutline` / `shipShapeScale` / `shipPrimaryColor`) reads
 * the three shape facets every consumer needs, narrowing over the
 * `ShipShape` discriminated union so polygon kinds behave byte-identically to
 * the pre-union `.points` / `.scale` / `.color` reads (composite-ships Phase 0).
 *
 * Fixtures: a polygon kind (the shipped fighter) + a hand-built composite kind
 * whose `hull` equals the polygon's `points`, so the seam can be exercised over
 * both union variants without a composite kind existing in the catalogue.
 */

const POLY_KIND = SHIP_KINDS.fighter;

const COMPOSITE_HULL: [number, number][] = [
  [0, -10],
  [10, 10],
  [-10, 10],
];

// Minimal composite ShipKind — clone the fighter's stats and swap the shape.
const COMPOSITE_KIND: ShipKind = {
  ...POLY_KIND,
  shape: {
    kind: 'composite',
    scale: 2,
    hull: COMPOSITE_HULL,
    parts: [
      { points: COMPOSITE_HULL, color: 0x123456, offsetX: 0, offsetY: 0 },
      { points: COMPOSITE_HULL, color: 0xabcdef, offsetX: 5, offsetY: 0 },
    ],
  },
};

describe('shipHullOutline', () => {
  it('returns shape.points for a polygon kind', () => {
    expect(POLY_KIND.shape.kind).toBe('polygon');
    // The shipped fighter is a polygon; the seam returns its exact points.
    const expected =
      POLY_KIND.shape.kind === 'polygon' ? POLY_KIND.shape.points : [];
    expect(shipHullOutline(POLY_KIND)).toBe(expected);
  });

  it('returns shape.hull for a composite kind', () => {
    expect(shipHullOutline(COMPOSITE_KIND)).toBe(COMPOSITE_HULL);
  });
});

describe('shipShapeScale', () => {
  it('returns the polygon scale', () => {
    expect(shipShapeScale(POLY_KIND)).toBe(POLY_KIND.shape.scale);
  });

  it('returns the composite scale', () => {
    expect(shipShapeScale(COMPOSITE_KIND)).toBe(2);
  });
});

describe('shipPrimaryColor', () => {
  it('returns shape.color for a polygon kind', () => {
    const expected =
      POLY_KIND.shape.kind === 'polygon' ? POLY_KIND.shape.color : -1;
    expect(shipPrimaryColor(POLY_KIND)).toBe(expected);
  });

  it('returns the first part color for a composite kind', () => {
    expect(shipPrimaryColor(COMPOSITE_KIND)).toBe(0x123456);
  });
});
