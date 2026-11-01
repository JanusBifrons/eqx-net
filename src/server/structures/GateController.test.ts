/**
 * Phase V gates — server orchestration over the pure gate logic:
 *   - GateController opens a gate for ships its access setting admits, and only
 *     for ACTIVE ships handed in by the room;
 *   - ShieldWallManager gives each built gate its own span walls (dropped while
 *     open) and anchors a fence wall on the gate post nearest the pylon.
 */
import { describe, expect, it } from 'vitest';
import { GateController, type GateShipBuffer } from './GateController.js';
import { ShieldWallManager } from './ShieldWallManager.js';
import { StructureRegistry, type StructureRecord } from './StructureRegistry.js';
import { CONNECTION_THROUGHPUT } from '../../core/structures/structureGridConstants.js';
import { GATE_OPEN_A } from '../../core/structures/gateLogic.js';
import { gateAccessIndex } from '../../shared-types/gateAccess.js';
import type { StructureKindId } from '../../shared-types/structureKinds.js';

function rec(id: string, kind: StructureKindId, x: number, y: number, owner = 'p1', built = true): StructureRecord {
  return {
    id, owner, kind, subtypeIndex: 0, x, y, radius: 100,
    isConstructed: built, constructionProgress: built ? 1 : 0, constructionCost: 1,
    isDeconstructing: false, minerals: 0, storedPower: 0, level: 1,
  };
}

function setup(ships: Array<{ id: string; x: number; y: number }>) {
  const registry = new StructureRegistry();
  const gates = new GateController({
    registry,
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
  const calls = { spawn: [] as Array<{ id: string; ax: number; ay: number; bx: number; by: number }>, active: new Map<string, boolean>() };
  const walls = new ShieldWallManager({
    registry,
    powerSummaryFor: () => ({ netPower: 50, powered: true }),
    componentBatteryCharge: () => 0,
    drainComponentBatteries: () => 0,
    spawnWall: (id, ax, ay, bx, by) => calls.spawn.push({ id, ax, ay, bx, by }),
    setWallActive: (id, active) => calls.active.set(id, active),
    removeWall: () => {},
    gateOpenMask: (id) => gates.maskFor(id),
  });
  return { registry, gates, walls, calls };
}

describe('GateController', () => {
  it('opens for its owner approaching, and the span wall stops blocking', () => {
    const ships = [{ id: 'p1', x: 0, y: -2000 }];
    const { registry, gates, walls, calls } = setup(ships);
    registry.add(rec('g', 'shield_gate', 0, 0));
    gates.update(0);
    walls.update(0);
    expect(gates.maskFor('g')).toBe(0);
    expect(calls.spawn.map((c) => c.id)).toEqual(['wall-gate-g-0']);
    ships[0]!.y = -200; // into the approach zone
    gates.update(100);
    walls.update(100);
    expect(gates.maskFor('g')).toBe(GATE_OPEN_A);
    expect(calls.active.get('wall-gate-g-0')).toBe(false);
    // An open span absorbs nothing.
    expect(walls.blockShot(0, -100, 0, 1, 500, 10, 100)).toBeNull();
  });

  it('owner+allies (default) and owner-only stay shut for a neutral pilot; "open" admits them', () => {
    const { registry, gates } = setup([{ id: 'stranger', x: 0, y: -100 }]);
    const g = rec('g', 'shield_gate', 0, 0);
    registry.add(g);
    gates.update(0);
    expect(gates.maskFor('g')).toBe(0);
    g.gateAccess = gateAccessIndex('owner');
    gates.update(100);
    expect(gates.maskFor('g')).toBe(0);
    g.gateAccess = gateAccessIndex('open');
    gates.update(200);
    expect(gates.maskFor('g')).toBe(GATE_OPEN_A);
  });

  it('a blueprint gate never opens', () => {
    const { registry, gates } = setup([{ id: 'p1', x: 0, y: -100 }]);
    registry.add(rec('g', 'shield_gate', 0, 0, 'p1', false));
    gates.update(0);
    expect(gates.maskFor('g')).toBe(0);
  });

  it('a rotated gate opens for a ship approaching along its rotated axis', () => {
    const { registry, gates } = setup([{ id: 'p1', x: -200, y: 0 }]);
    const g = rec('g', 'shield_gate', 0, 0);
    g.rot = 90; // span now runs along world y; the approach is along world x
    registry.add(g);
    gates.update(0);
    expect(gates.maskFor('g')).toBe(GATE_OPEN_A);
  });
});

describe('ShieldWallManager with gates', () => {
  it('a fence wall runs from the pylon to the NEAREST gate post', () => {
    const { registry, walls, calls } = setup([]);
    registry.add(rec('g', 'shield_gate', 0, 0));
    registry.add(rec('p', 'shield_pylon', 500, 0));
    registry.addConnection('g', 'p', CONNECTION_THROUGHPUT);
    walls.update(0);
    const fence = calls.spawn.find((c) => c.id === 'wall-g|p')!;
    expect(fence).toMatchObject({ ax: 124, ay: 0, bx: 500, by: 0 });
    expect(walls.wallsUpFor('g', 0)).toBe(true);
    expect(walls.wallsUpFor('p', 0)).toBe(true);
  });

  it('an airlock gets one span per end', () => {
    const { registry, walls, calls } = setup([]);
    registry.add(rec('a', 'shield_airlock', 0, 0));
    walls.update(0);
    expect(calls.spawn.map((c) => c.id).sort()).toEqual(['wall-gate-a-0', 'wall-gate-a-1']);
  });

  it('a lone pylon reports no walls up', () => {
    const { registry, walls } = setup([]);
    registry.add(rec('p', 'shield_pylon', 0, 0));
    walls.update(0);
    expect(walls.wallsUpFor('p', 0)).toBe(false);
  });
});
