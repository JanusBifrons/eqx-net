/**
 * Capitals have no shield; every other ship's shield is a bubble round its
 * whole hull (owner 2026-11-16: "capital ships never have shields"). The hit
 * shape follows the kind's shield pool: a kind with `shieldMax` 0 is always hit
 * on its hull, whatever `shieldUp` a caller passes.
 */
import { describe, expect, it } from 'vitest';
import { SHIP_KINDS_LIST, getShipKind } from '../../shared-types/shipKinds.js';
import { shipCollisionParts } from '../geometry/shipHullDecomp.js';
import { shipAimRadius, shipBubbleRadius, shipHullDistance, shipRayHit, shipSweepHit } from './shipHitShape.js';

const CAPITALS = SHIP_KINDS_LIST.filter((k) => k.sizeClass === 'capital');
const NON_CAPITALS = SHIP_KINDS_LIST.filter((k) => k.sizeClass !== 'capital');
// Engineering-only test hulls (the `el` L-shape) are built to be bigger than
// their bubble on purpose (collider probes); they never fly in a sector.
const FLOWN_NON_CAPITALS = NON_CAPITALS.filter((k) => k.engineeringOnly !== true);

describe('capitals have no shield (owner 2026-11-16)', () => {
  it('there are capital kinds to check', () => {
    expect(CAPITALS.length).toBeGreaterThan(0);
  });

  it.each(CAPITALS.map((k) => [k.id]))('%s has shieldMax 0 and no regen', (id) => {
    const k = getShipKind(id);
    expect(k.shieldMax).toBe(0);
    expect(k.shieldRegenRate).toBe(0);
  });

  it('every non-capital kind has a shield', () => {
    for (const k of NON_CAPITALS) expect(k.shieldMax, k.id).toBeGreaterThan(0);
  });
});

describe('a non-capital shield bubble covers its whole hull', () => {
  it.each(FLOWN_NON_CAPITALS.map((k) => [k.id]))('%s: every hull vertex is inside the bubble', (id) => {
    const r = shipBubbleRadius(id);
    for (const part of shipCollisionParts(id)) {
      for (const v of part) expect(Math.hypot(v.x, v.y), `${id} vertex (${v.x}, ${v.y})`).toBeLessThanOrEqual(r + 1e-6);
    }
  });
});

describe('a shieldless kind is always hit on its hull', () => {
  it.each(CAPITALS.map((k) => [k.id]))('%s: shieldUp=true gives the same hit shape as shieldUp=false', (id) => {
    const k = getShipKind(id);
    // A heavy-beam-wide ray beside the hull, inside the bubble circle: a
    // bubble would catch it, the hull does not.
    const x = k.radius * 0.4;
    const hw = 2;
    const up = shipRayHit(id, true, x, -k.radius * 2, 0, 1, k.radius * 4, 0, 0, 0, hw);
    const down = shipRayHit(id, false, x, -k.radius * 2, 0, 1, k.radius * 4, 0, 0, 0, hw);
    expect(up).toBe(down);
    expect(up).toBeNull();
    // Down the centreline it lands on the hull, at the hull's distance.
    const upC = shipRayHit(id, true, 0, -k.radius * 2, 0, 1, k.radius * 4, 0, 0, 0, hw);
    const downC = shipRayHit(id, false, 0, -k.radius * 2, 0, 1, k.radius * 4, 0, 0, 0, hw);
    expect(upC).not.toBeNull();
    expect(upC).toBe(downC);
    expect(shipSweepHit(id, true, x, -k.radius * 2, 0, k.radius * 4, 2, 0, 0, 0))
      .toEqual(shipSweepHit(id, false, x, -k.radius * 2, 0, k.radius * 4, 2, 0, 0, 0));
    expect(shipHullDistance(id, true, k.radius * 3, 0, 0, 0, 0)).toBe(shipHullDistance(id, false, k.radius * 3, 0, 0, 0, 0));
    expect(shipAimRadius(id, true)).toBe(k.radius);
  });

  it('a shielded kind still uses its bubble while the shield is up', () => {
    const r = shipBubbleRadius('fighter');
    expect(shipRayHit('fighter', true, 0, -100, 0, 1, 200, 0, 0, 0)).toBeCloseTo(100 - r, 6);
  });
});
