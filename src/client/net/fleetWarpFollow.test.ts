import { describe, expect, it } from 'vitest';
import {
  FLEET_ARRIVAL_GIVE_UP_MS, FLEET_ARRIVAL_SETTLE_MS, arrivalNeedsGlide, commandArrivalWatch, isCommanderFleetFollow, stepFleetArrival, transitStartsLocalTrip,
  type FleetArrivalWatch,
} from './fleetWarpFollow';

describe('fleetWarpFollow — the commander follows their fleet (RTS fleet warp S7/S8)', () => {
  it('a transit_ready with ship ids in Command view skips the local trip; a pilot transit does not', () => {
    expect(isCommanderFleetFollow(['a'], 'spectator')).toBe(true);
    expect(isCommanderFleetFollow(undefined, 'spectator')).toBe(false);
    expect(isCommanderFleetFollow(['a'], 'pilot')).toBe(false);
    expect(transitStartsLocalTrip('pilot')).toBe(true);
    expect(transitStartsLocalTrip('spectator')).toBe(false);
  });

  it('waits until the ships are in the mirror, then fires once with ids + centroid', () => {
    const w: FleetArrivalWatch = { ids: ['a', 'b'], armedAtMs: 0, firstSeenAtMs: null };
    const ships = new Map<string, { x: number; y: number }>();
    expect(stepFleetArrival(w, ships, 100)).toBeNull();
    ships.set('a', { x: 0, y: 0 });
    expect(stepFleetArrival(w, ships, 200)).toBeNull(); // b not yet, settle window
    ships.set('b', { x: 100, y: 50 });
    expect(stepFleetArrival(w, ships, 300)).toEqual({ ids: ['a', 'b'], x: 50, y: 25, select: true });
  });

  it('after the settle window, fires with the ships that did arrive', () => {
    const w: FleetArrivalWatch = { ids: ['a', 'b'], armedAtMs: 0, firstSeenAtMs: null };
    const ships = new Map([['a', { x: 10, y: 20 }]]);
    expect(stepFleetArrival(w, ships, 500)).toBeNull();
    expect(stepFleetArrival(w, ships, 500 + FLEET_ARRIVAL_SETTLE_MS)).toEqual({ ids: ['a'], x: 10, y: 20, select: true });
  });

  it('gives up when nothing arrives', () => {
    const w: FleetArrivalWatch = { ids: ['a'], armedAtMs: 0, firstSeenAtMs: null };
    expect(stepFleetArrival(w, new Map(), FLEET_ARRIVAL_GIVE_UP_MS + 1)).toBe('drop');
  });

  it('a command-view join frames its hull only after the settle window, no re-select', () => {
    const w = commandArrivalWatch('hull', 0);
    // At the flip the hull carries the pre-arrival local pose (a re-join glides in from (0, 0)).
    const ships = new Map([['hull', { x: -600, y: 500 }]]);
    expect(stepFleetArrival(w, ships, 0)).toBeNull();
    ships.set('hull', { x: -2040, y: 1800 }); // the snapshot pose lands
    expect(stepFleetArrival(w, ships, FLEET_ARRIVAL_SETTLE_MS - 1)).toBeNull();
    expect(stepFleetArrival(w, ships, FLEET_ARRIVAL_SETTLE_MS)).toEqual({ ids: ['hull'], x: -2040, y: 1800, select: false });
  });

  it('glides to a joined hull only when it is off the middle of the view; a fleet arrival always', () => {
    const join = { ids: ['h'], x: 0, y: 0, select: false };
    expect(arrivalNeedsGlide(join, 10, -10, 1000)).toBe(false);
    expect(arrivalNeedsGlide(join, -1500, 1300, 1000)).toBe(true);
    expect(arrivalNeedsGlide({ ...join, select: true }, 0, 0, 1000)).toBe(true);
  });
});
