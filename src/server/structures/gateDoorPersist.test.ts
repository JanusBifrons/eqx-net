/**
 * Solid doors slice 12 (docs/plans/door-power.md): a gate door's position
 * survives a save/load. The saved structure record carries optional
 * `doorPos` / `doorClip`; missing means shut, so old saves load unchanged. A
 * restored door starts frozen where it was (target shut) and the normal gate
 * logic drives it from there.
 */
import { describe, expect, it } from 'vitest';
import type { Logger } from 'pino';
import { GateController, type GateShipBuffer } from './GateController.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';
import { SectorPersistence } from '../rooms/SectorPersistence.js';
import type { SectorSnapshotPayload, SectorSnapshotStructure } from '../rooms/SectorSnapshot.js';
import {
  AIRLOCK_OPEN_A,
  AIRLOCK_OPEN_B,
  newAirlockState,
  newGateState,
  newOccupancy,
  parseSavedDoor,
  savedDoorOf,
  stepAirlock,
  type SavedDoor,
} from '../../core/structures/gateLogic.js';
import { doorPosAt } from '../../core/structures/doorMotion.js';
import { DOOR_POS_MAX, DOOR_POWER_LEVELS, DOOR_TRAVEL_S, DOOR_TRAVEL_TICKS } from '../../core/structures/gateGeometry.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';

const noopLogger = { info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
/** GateController's interim game tick for a wall time (slice 7). */
const tickAt = (ms: number): number => Math.floor((ms * DOOR_TRAVEL_TICKS) / (DOOR_TRAVEL_S * 1000));

function rec(id: string, kind: StructureKindId): StructureRecord {
  return {
    id, owner: 'p1', kind, subtypeIndex: 0, x: 0, y: 0, radius: 100,
    isConstructed: true, constructionProgress: 1, constructionCost: 1,
    isDeconstructing: false, minerals: 0, storedPower: 0, level: 1,
  };
}

function controller(registry: StructureRegistry, ships: Array<{ id: string; x: number; y: number }>): GateController {
  // Slice 8 hooks: the game tick follows the ms passed to update(); full supply.
  let cur = 0;
  const gc = new GateController({
    registry,
    serverTick: () => tickAt(cur),
    supplyFrac: () => 1,
    setActive: () => undefined,
    post: () => undefined,
    collectShips: (out: GateShipBuffer) => {
      for (const s of ships) {
        const i = out.count++;
        out.playerIds[i] = s.id;
        out.xs[i] = s.x;
        out.ys[i] = s.y;
        out.radii[i] = 14;
      }
    },
    relationOf: (playerId, owner) => (playerId === owner ? 'self' : 'neutral'),
  });
  const step = gc.update.bind(gc);
  gc.update = (ms: number): boolean => { cur = ms; return step(ms); };
  return gc;
}

/** Persist through the real SectorPersistence, then hydrate the row back. */
function saveAndLoad(registry: StructureRegistry, gates: GateController): SectorSnapshotStructure[] {
  let row: { snapshot: string; created_at: number } | undefined;
  let restored: SectorSnapshotStructure[] = [];
  const p = new SectorPersistence({
    sectorKey: () => 'galaxy-sol',
    sabF32: new Float32Array(64),
    swarmRegistry: { all: () => [], has: () => false },
    swarmHealth: new Map(),
    structures: () => registry.all(),
    gateDoorOf: (id) => gates.savedDoor(id),
    restoreStructures: (rows) => { restored = [...rows]; },
    scrapEntities: () => [],
    restoreScrap: () => undefined,
    lingeringHulls: () => [],
    restoreLingeringHulls: () => undefined,
    saveRow: (_k: string, payload: SectorSnapshotPayload) => { row = { snapshot: JSON.stringify(payload), created_at: Date.now() }; },
    loadRow: () => row,
    logger: noopLogger,
  });
  p.persist();
  p.hydrate();
  return restored;
}

/** What SectorSnapshotRestore does with a row's door fields. */
function restoreInto(registry: StructureRegistry, r: SectorSnapshotStructure): StructureRecord {
  const fresh = rec(r.entityId, r.kind as StructureKindId);
  const door = parseSavedDoor(r.doorPos, r.doorClip);
  if (door) fresh.doorRestore = door;
  registry.add(fresh);
  return fresh;
}

describe('gate door persistence (door-power slice 12)', () => {
  it('a half-open gate saves its position and loads frozen there until the logic drives it', () => {
    const ships = [{ id: 'p1', x: 0, y: -200 }];
    const registry = new StructureRegistry();
    registry.add(rec('g', 'shield_gate'));
    const gates = controller(registry, ships);
    gates.update(0); // starts opening at full power
    gates.update(1500); // half the 3 s travel
    const half = tickAt(1500) * DOOR_POWER_LEVELS;
    expect(half).toBeGreaterThan(0);
    expect(half).toBeLessThan(DOOR_POS_MAX);
    expect(gates.savedDoor('g')).toEqual({ pos: half, clip: 'door' });

    const rows = saveAndLoad(registry, gates);
    expect(rows[0]).toMatchObject({ doorPos: half, doorClip: 'door' });

    // A fresh server: the gate state starts frozen at the saved position.
    const reg2 = new StructureRegistry();
    const restored = restoreInto(reg2, rows[0]!);
    expect(restored.doorRestore).toEqual({ pos: half, clip: 'door' });
    const later = 90_000;
    const g2 = controller(reg2, []); // nobody near: the target is shut
    g2.update(later);
    expect(restored.doorRestore).toBeUndefined(); // consumed once
    expect(g2.savedDoor('g')).toEqual({ pos: half, clip: 'door' }); // no jump on load
    // The normal logic then drives it shut at full power.
    g2.update(later + 500);
    const shutting = g2.savedDoor('g')!.pos;
    expect(shutting).toBe(half - (tickAt(later + 500) - tickAt(later)) * DOOR_POWER_LEVELS);
    g2.update(later + 3000);
    expect(g2.savedDoor('g')).toBeUndefined(); // shut
  });

  it('a restored door is frozen (level 0) whatever the tick, target shut', () => {
    const s = newGateState(0, { pos: 1234, clip: 'door' });
    expect(s.open).toBe(false);
    expect(s.door.seg.dir).toBe(-1);
    for (const t of [0, 10, 100_000]) expect(doorPosAt(s.door.seg, t)).toBe(1234);
  });

  it('an old record without the door fields loads shut', () => {
    expect(parseSavedDoor(undefined, undefined)).toBeUndefined();
    const registry = new StructureRegistry();
    const old = { entityId: 'g', owner: 'p1', kind: 'shield_gate', x: 0, y: 0, health: 1, isConstructed: true, constructionProgress: 1, minerals: 0, storedPower: 0 };
    const r = restoreInto(registry, old);
    expect(r.doorRestore).toBeUndefined();
    const gates = controller(registry, []);
    gates.update(5000);
    expect(gates.savedDoor('g')).toBeUndefined();
    // A shut gate writes no door fields.
    const rows = saveAndLoad(registry, gates);
    expect(rows[0]!.doorPos).toBeUndefined();
    expect(rows[0]!.doorClip).toBeUndefined();
  });

  it('a malformed door field reads as shut and an out-of-range position is clamped', () => {
    expect(parseSavedDoor('900', 'door')).toBeUndefined();
    expect(parseSavedDoor(900, 'hatch')).toBeUndefined();
    expect(parseSavedDoor(Number.NaN, 'door')).toBeUndefined();
    expect(parseSavedDoor(0, 'door')).toBeUndefined();
    expect(parseSavedDoor(99_999, 'door-a')).toEqual({ pos: DOOR_POS_MAX, clip: 'door-a' });
    expect(parseSavedDoor(12.6, 'door-b')).toEqual({ pos: 13, clip: 'door-b' });
  });

  it('an airlock saves and restores whichever end is open (both ends)', () => {
    const o = newOccupancy();
    for (const [end, clip, phase] of [['A', 'door-a', AIRLOCK_OPEN_A], ['B', 'door-b', AIRLOCK_OPEN_B]] as const) {
      const a = newAirlockState();
      o.waitA = end === 'A';
      o.waitB = end === 'B';
      stepAirlock(a, o, 0, 0, DOOR_POWER_LEVELS);
      expect(a.phase).toBe(phase);
      const tick = 60; // a third of the way
      const saved = savedDoorOf(undefined, a, tick);
      expect(saved).toEqual({ pos: tick * DOOR_POWER_LEVELS, clip });
      const json = JSON.parse(JSON.stringify({ doorPos: saved!.pos, doorClip: saved!.clip })) as { doorPos: unknown; doorClip: unknown };
      const loaded = newAirlockState(parseSavedDoor(json.doorPos, json.doorClip));
      const openEnd = clip === 'door-a' ? loaded.doorA : loaded.doorB;
      const shutEnd = clip === 'door-a' ? loaded.doorB : loaded.doorA;
      expect(doorPosAt(openEnd.seg, 5000)).toBe(tick * DOOR_POWER_LEVELS);
      expect(doorPosAt(shutEnd.seg, 5000)).toBe(0);
      expect(loaded.phase).toBe(0); // target shut; the logic re-decides
      expect(savedDoorOf(undefined, loaded, 5000)).toEqual(saved);
    }
    // A gate's saved door never opens an airlock end (and vice versa).
    const wrong: SavedDoor = { pos: 500, clip: 'door' };
    expect(savedDoorOf(undefined, newAirlockState(wrong), 0)).toBeUndefined();
    expect(savedDoorOf(newGateState(0, { pos: 500, clip: 'door-a' }), undefined, 0)).toBeUndefined();
  });
});
