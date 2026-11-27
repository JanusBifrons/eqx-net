import { describe, expect, it } from 'vitest';
import { BASE_PILOT_HULL_KINDS_LIST } from '../../shared-types/shipKinds.js';
import type { NewHullOrigin, NewHullResult } from './features/hullHandOff.js';
import { baseFleetHulls, fleetGridLayout, fleetLaneHeight, seedOwnedFleet, starterPlateCentre, type FleetSeedHost, type FleetSlot } from './sandboxFleet.js';

const ANCHOR = { x: -1000, y: 0 };
const extentOf = new Map(baseFleetHulls().map((h) => [h.kind, h.extent]));

function overlaps(a: FleetSlot, b: FleetSlot): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < extentOf.get(a.kind)! + extentOf.get(b.kind)!;
}

describe('fleetGridLayout', () => {
  const slots = fleetGridLayout(baseFleetHulls(), ANCHOR.x, ANCHOR.y, 0);

  it('places one of every base pilot hull', () => {
    expect(slots.map((s) => s.kind).sort()).toEqual(BASE_PILOT_HULL_KINDS_LIST.map((k) => k.id).sort());
  });

  it('no two hulls overlap, and none touches a capital spawning on the anchor', () => {
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) expect(overlaps(slots[i]!, slots[j]!)).toBe(false);
    }
    const biggest = Math.max(...extentOf.values());
    for (const s of slots) expect(Math.hypot(s.x - ANCHOR.x, s.y - ANCHOR.y)).toBeGreaterThanOrEqual(biggest + extentOf.get(s.kind)!);
  });

  it('two pilots\' lanes never overlap', () => {
    const lane1 = fleetGridLayout(baseFleetHulls(), ANCHOR.x, ANCHOR.y, 1);
    for (const a of slots) for (const b of lane1) expect(overlaps(a, b)).toBe(false);
  });

  it('groups by size: sub-capitals in one row, capitals in the next', () => {
    const capital = new Set(baseFleetHulls().filter((h) => h.capital).map((h) => h.kind));
    const ys = (cap: boolean) => new Set(slots.filter((s) => capital.has(s.kind) === cap).map((s) => s.y));
    expect(ys(false).size).toBe(1);
    expect(ys(true).size).toBe(1);
  });
});

/** A fake room: the ships map + a launch that parks a live owned hull. */
function fakeRoom(ownedFleet = true) {
  const ships = new Map<string, { playerId: string; kind: string; alive: boolean }>();
  const launched: Array<{ playerId: string; kind: string; o: NewHullOrigin }> = [];
  const plates: Array<{ playerId: string; x: number; y: number }> = [];
  let n = 0;
  const host: FleetSeedHost = {
    ownedFleet, defaultSpawnX: ANCHOR.x, defaultSpawnY: ANCHOR.y,
    shipsMap: ships,
    launchFleetHull(playerId, kind, o): NewHullResult {
      const shipId = `s${n++}`;
      ships.set(shipId, { playerId, kind, alive: true });
      launched.push({ playerId, kind, o });
      return { ok: true, shipId, live: true };
    },
    seedStarterPlate(playerId, x, y) { plates.push({ playerId, x, y }); },
  };
  return { host, ships, launched, plates };
}

describe('seedOwnedFleet', () => {
  const total = BASE_PILOT_HULL_KINDS_LIST.length;

  it('lays each pilot a starter plate east of their lane: lane 0 on the origin plate', () => {
    expect(starterPlateCentre(ANCHOR.x, ANCHOR.y, 0, fleetLaneHeight(baseFleetHulls()))).toEqual({ x: 0, y: 0 });
    const { host, plates } = fakeRoom();
    seedOwnedFleet(host, 'p1', 0, 0);
    seedOwnedFleet(host, 'p2', 0, 0);
    expect(plates.map((p) => p.playerId)).toEqual(['p1', 'p2']);
    expect(plates[0]).toMatchObject({ x: 0, y: 0 });
    expect(plates[1]!.y).toBeLessThan(-fleetLaneHeight(baseFleetHulls()) / 2);
  });

  it('option off: no plate', () => {
    const { host, plates } = fakeRoom(false);
    seedOwnedFleet(host, 'p1', 0, 0);
    expect(plates).toEqual([]);
  });

  it('join: one parked owned hull per base kind; the flown kind counts as had', () => {
    const { host, ships, launched } = fakeRoom();
    ships.set('flown', { playerId: 'p1', kind: 'fighter', alive: true });
    expect(seedOwnedFleet(host, 'p1', 0, 0)).toBe(total - 1);
    expect(launched.every((l) => l.playerId === 'p1' && l.kind !== 'fighter')).toBe(true);
    expect(new Set(launched.map((l) => l.kind)).size).toBe(total - 1);
  });

  it('re-join: no duplicates; a destroyed hull is replaced in its own slot', () => {
    const { host, ships, launched } = fakeRoom();
    seedOwnedFleet(host, 'p1', 0, 0);
    expect(seedOwnedFleet(host, 'p1', 0, 0)).toBe(0);
    const [id, lost] = [...ships].find(([, s]) => s.kind === 'battleship')!;
    const slot = launched.find((l) => l.kind === 'battleship')!.o;
    lost.alive = false;
    ships.delete(id);
    expect(seedOwnedFleet(host, 'p1', 0, 0)).toBe(1);
    expect(launched.at(-1)).toMatchObject({ kind: 'battleship', o: { parkX: slot.parkX, parkY: slot.parkY } });
  });

  it('a second pilot gets their own lane; another pilot\'s hulls never count', () => {
    const { host, launched } = fakeRoom();
    seedOwnedFleet(host, 'p1', 0, 0);
    expect(seedOwnedFleet(host, 'p2', 0, 0)).toBe(total);
    const p1 = launched.filter((l) => l.playerId === 'p1');
    const p2 = launched.filter((l) => l.playerId === 'p2');
    for (const a of p1) for (const b of p2) {
      expect(Math.hypot(a.o.parkX - b.o.parkX, a.o.parkY - b.o.parkY)).toBeGreaterThanOrEqual(extentOf.get(a.kind)! + extentOf.get(b.kind)!);
    }
  });

  it('does nothing without the room option', () => {
    const { host, launched } = fakeRoom(false);
    expect(seedOwnedFleet(host, 'p1', 0, 0)).toBe(0);
    expect(launched).toHaveLength(0);
  });
});
