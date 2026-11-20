/**
 * Base loop — the owner's On/Off switch on a structure. Off feeds the grid's
 * one active-power switch (`setActive` / the draw): the structure draws
 * nothing and reads unpowered to every subsystem, so a turret holds fire.
 * On restores its draw. The `set_structure_power` message is owner-only.
 */
import { describe, it, expect } from 'vitest';
import type { Client } from 'colyseus';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { IDLE_DRAW_FRAC } from '../../shared-types/structurePower.js';
import { registerStructureSettingMessages, type StructureSettingMessageHost } from '../rooms/features/structureSettingMessages.js';

const OWNER = 'player-1';

/** A built, powered base: Capital → relay → Solar + Turret, a drone in range
 *  (the layout of the Phase 5 turret test, footprint units). */
function poweredTurretBase() {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  const damage: string[] = [];
  let counter = 0;
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${counter++}`,
    registry,
  });
  const drone = { id: 'swarm-3', entityId: 3, x: -130, y: 900 };
  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    findNearestAsteroid: () => null,
    findNearestDrone: (x, y, range) =>
      Math.hypot(drone.x - x, drone.y - y) > range ? null : { id: drone.id, entityId: drone.entityId, x: drone.x, y: drone.y },
    applyDamage: (targetId) => damage.push(targetId),
    broadcastBeam: () => {},
  });
  grid.setInstantTurretLocks(true);
  placement.place(OWNER, 'capital', 0, 0, { rot: 180 });
  const relay = placement.place(OWNER, 'connector', 0, 350)!;
  const r = registry.get(relay)!;
  r.isConstructed = true;
  r.constructionProgress = r.constructionCost;
  health.set(relay, getStructureKind('connector').maxHealth);
  registry.topologyDirty = true;
  placement.place(OWNER, 'solar', 450, 500);
  const turret = placement.place(OWNER, 'turret', -130, 400)!;
  let now = 0;
  for (let i = 0; i < 120; i++) grid.pulse(now += 1000);
  expect(registry.get(turret)!.isConstructed).toBe(true);
  return { registry, grid, damage, turret, pulse: () => grid.pulse(now += 1000) };
}

describe('structure On/Off switch', () => {
  it('an Off turret draws nothing and holds fire', () => {
    const b = poweredTurretBase();
    const rec = b.registry.get(b.turret)!;
    b.grid.tickTurrets(10_000);
    expect(b.damage.length).toBe(1); // On: it fires (and draws full)
    expect(rec.drawFull).toBe(true);
    const netOn = b.grid.powerSummaryFor(b.turret).netPower;

    expect(b.grid.setSwitchedOn(rec, false)).toBe(true);
    expect(rec.switchedOff).toBe(true);
    expect(rec.drawFull).toBe(false);
    // The whole full draw comes back to the grid: Off draws nothing at all.
    const cons = getStructureKind('turret').powerConsumption;
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netOn + cons, 6);
    expect(b.grid.powerSummaryFor(b.turret).powered).toBe(false);

    for (let t = 11_000; t < 14_000; t += 50) b.grid.tickTurrets(t);
    expect(b.damage.length).toBe(1); // held fire
    expect(rec.turretTargetEntityId).toBeUndefined();
    // A subsystem asking it to work cannot override the owner's Off.
    b.grid.setActive(rec, true);
    expect(rec.drawFull).toBe(false);
    // A topology rebuild agrees with the O(1) adjustment.
    b.registry.topologyDirty = true;
    b.pulse();
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netOn + cons, 6);
  });

  it('On restores power draw', () => {
    const b = poweredTurretBase();
    const rec = b.registry.get(b.turret)!;
    const cons = getStructureKind('turret').powerConsumption;
    const netIdle = b.grid.powerSummaryFor(b.turret).netPower; // idle trickle, no tick yet
    b.grid.setSwitchedOn(rec, false);
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netIdle + cons * IDLE_DRAW_FRAC, 6);

    expect(b.grid.setSwitchedOn(rec, true)).toBe(true);
    expect(rec.switchedOff).toBeUndefined();
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netIdle, 6);
    expect(b.grid.powerSummaryFor(b.turret).powered).toBe(true);
    b.grid.tickTurrets(20_000);
    expect(b.damage.length).toBe(1); // fires again, at full draw
    expect(rec.drawFull).toBe(true);
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netIdle - cons * (1 - IDLE_DRAW_FRAC), 6);
  });

  it('a kind that draws no power has no Off', () => {
    const b = poweredTurretBase();
    const solar = b.registry.all().find((r) => r.kind === 'solar')!;
    expect(b.grid.setSwitchedOn(solar, false)).toBe(false);
    expect(solar.switchedOff).toBeUndefined();
  });

  it('only the owner can switch it', () => {
    const b = poweredTurretBase();
    const rec = b.registry.get(b.turret)!;
    const handlers = new Map<string, (client: Client, raw: unknown) => void>();
    let rebuilds = 0;
    const host: StructureSettingMessageHost = {
      onMessage: (type, fn) => { handlers.set(type, fn); },
      malformed: { record: () => {} },
      sessionToPlayer: () => new Map([['sess-owner', OWNER], ['sess-other', 'player-2']]),
      swarmRegistry: { getByEntityId: (eid: number) => (eid === 42 ? { id: b.turret } : undefined) } as never,
      structureRegistry: b.registry,
      sectorKey: () => null,
      production: () => ({ setRecipe: () => false }),
      storage: () => ({ flushDirty: () => {}, refine: () => 0 }),
      rebuildStructuresSlice: () => { rebuilds++; },
      structureGrid: () => b.grid,
    };
    registerStructureSettingMessages(host);
    const send = handlers.get('set_structure_power')!;
    const msg = { type: 'set_structure_power', entityId: 42, on: false };

    send({ sessionId: 'sess-other' } as Client, msg);
    expect(rec.switchedOff).toBeUndefined();
    expect(rebuilds).toBe(0);

    send({ sessionId: 'sess-owner' } as Client, msg);
    expect(rec.switchedOff).toBe(true);
    expect(rebuilds).toBe(1);

    send({ sessionId: 'sess-other' } as Client, { ...msg, on: true });
    expect(rec.switchedOff).toBe(true);
    send({ sessionId: 'sess-owner' } as Client, { ...msg, on: true });
    expect(rec.switchedOff).toBeUndefined();
    expect(rebuilds).toBe(2);
  });
});
