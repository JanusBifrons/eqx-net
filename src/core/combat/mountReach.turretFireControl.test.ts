import { describe, expect, it } from 'vitest';
import { SHIP_KINDS } from '../../shared-types/shipKinds.js';
import { hasTurretFireControl } from './mountReach.js';

describe('hasTurretFireControl', () => {
  it('a small ship with a mining mount aims its turrets', () => {
    const skiff = SHIP_KINDS['mining-skiff'];
    expect(skiff.sizeClass).not.toBe('capital');
    expect(hasTurretFireControl(skiff)).toBe(true);
    // Cached per kind: the same answer on a second call.
    expect(hasTurretFireControl(skiff)).toBe(true);
  });

  it('capitals keep turret fire control; fighters and the frigate keep the hull aim', () => {
    expect(hasTurretFireControl(SHIP_KINDS.barge)).toBe(true);
    expect(hasTurretFireControl(SHIP_KINDS.battleship)).toBe(true);
    expect(hasTurretFireControl(SHIP_KINDS.fighter)).toBe(false);
    expect(hasTurretFireControl(SHIP_KINDS['missile-frigate'])).toBe(false);
  });
});
