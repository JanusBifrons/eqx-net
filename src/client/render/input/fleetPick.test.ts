/**
 * RTS slice 14b — the pure map-pick state for patrol / escort / retreat.
 */
import { describe, it, expect } from 'vitest';
import {
  FLEET_PICK_ROUTE_MAX,
  createFleetPickState,
  decidePickTap,
  pickAddPoint,
  pickCanFinish,
  pickFinishPatrol,
  pickStart,
} from './fleetPick.js';

describe('fleetPick state', () => {
  it('a patrol pick collects points; Done needs 2; finishing returns the route and clears', () => {
    const s = createFleetPickState();
    pickStart(s, 'patrol');
    expect(pickCanFinish(s)).toBe(false);
    expect(pickFinishPatrol(s)).toBeNull();
    pickAddPoint(s, 10, 20);
    expect(pickCanFinish(s)).toBe(false);
    pickAddPoint(s, -5, 7.5);
    expect(pickCanFinish(s)).toBe(true);
    expect(pickFinishPatrol(s)).toEqual({ kind: 'patrol', route: [[10, 20], [-5, 7.5]] });
    expect(s.kind).toBeNull();
    expect(s.count).toBe(0);
  });

  it(`caps the route at ${FLEET_PICK_ROUTE_MAX} points`, () => {
    const s = createFleetPickState();
    pickStart(s, 'patrol');
    for (let i = 0; i < FLEET_PICK_ROUTE_MAX; i++) expect(pickAddPoint(s, i, i)).toBe(true);
    expect(pickAddPoint(s, 99, 99)).toBe(false);
    expect(s.count).toBe(FLEET_PICK_ROUTE_MAX);
    const r = pickFinishPatrol(s);
    expect(r?.kind === 'patrol' && r.route.length).toBe(FLEET_PICK_ROUTE_MAX);
  });

  it('starting again (or cancelling) drops the points; non-patrol picks take no points', () => {
    const s = createFleetPickState();
    pickStart(s, 'patrol');
    pickAddPoint(s, 1, 1);
    pickStart(s, 'patrol');
    expect(s.count).toBe(0);
    pickStart(s, 'escort');
    expect(pickAddPoint(s, 1, 1)).toBe(false);
    expect(pickCanFinish(s)).toBe(false);
    pickStart(s, null);
    expect(s.kind).toBeNull();
  });
});

describe('decidePickTap', () => {
  it('patrol adds a point until the cap', () => {
    expect(decidePickTap('patrol', null, false, 0)).toBe('addPoint');
    expect(decidePickTap('patrol', 'own', false, 3)).toBe('addPoint');
    expect(decidePickTap('patrol', null, false, FLEET_PICK_ROUTE_MAX)).toBe('ignore');
  });

  it('retreat takes the tap point, whatever is under it', () => {
    expect(decidePickTap('retreat', null, false, 0)).toBe('retreatHere');
    expect(decidePickTap('retreat', 'own', true, 0)).toBe('retreatHere');
  });

  it('escort takes only an own ship that is not being commanded', () => {
    expect(decidePickTap('escort', 'hull-2', false, 0)).toBe('escortShip');
    expect(decidePickTap('escort', 'hull-1', true, 0), 'a ship cannot escort itself').toBe('ignore');
    expect(decidePickTap('escort', null, false, 0), 'empty space does nothing').toBe('ignore');
  });

  it('nothing happens when no pick is on', () => {
    expect(decidePickTap(null, 'own', false, 0)).toBe('ignore');
  });
});
