/**
 * Base loop — the owner's On/Off switch on a structure. Off feeds the grid's
 * one active-power switch (`setActive` / the draw): the structure draws
 * nothing and reads unpowered to every subsystem, so a turret holds fire.
 * On restores its draw. The `set_structure_power` message is owner-only.
 * The same message's optional `throttle` (tenths) scales the draw.
 */
import { describe, it, expect } from 'vitest';
import type { Client } from 'colyseus';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { IDLE_DRAW_FRAC, normalizeStructureThrottle, structureDraw } from '../../shared-types/structurePower.js';
import { decodeStructureThrottleFlags, encodeStructureThrottleFlags, STRUCTURE_FLAG_OFF } from '../../shared-types/structureStateWire.js';
import { SetStructurePowerSchema } from '../../shared-types/messages.js';
import { registerStructureSettingMessages, type StructureSettingMessageHost } from '../rooms/features/structureSettingMessages.js';
import { structureToGridNode } from './structureGridView.js';
import { SectorPersistence, type PersistableStructure } from '../rooms/SectorPersistence.js';
import type { SectorSnapshotPayload, SectorSnapshotStructure } from '../rooms/SectorSnapshot.js';
import type { Logger } from 'pino';

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
  const drone = { id: 'swarm-3', entityId: 3, x: -170, y: 920 };
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
  const relay = placement.place(OWNER, 'connector', 0, 380)!;
  const r = registry.get(relay)!;
  r.isConstructed = true;
  r.constructionProgress = r.constructionCost;
  health.set(relay, getStructureKind('connector').maxHealth);
  registry.topologyDirty = true;
  placement.place(OWNER, 'solar', 450, 500);
  const turret = placement.place(OWNER, 'turret', -170, 420)!;
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

/** The set_structure_power handler wired to a base's grid, two sessions. */
function powerMessages(b: ReturnType<typeof poweredTurretBase>) {
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
  return { send: (sessionId: string, raw: unknown) => send({ sessionId } as Client, raw), rebuilds: () => rebuilds };
}

describe('structure power throttle', () => {
  it('50% throttle halves the draw', () => {
    const b = poweredTurretBase();
    const rec = b.registry.get(b.turret)!;
    const cons = getStructureKind('turret').powerConsumption;
    b.grid.tickTurrets(10_000); // active: full draw
    expect(rec.drawFull).toBe(true);
    const netFull = b.grid.powerSummaryFor(b.turret).netPower;

    expect(b.grid.setThrottle(rec, 5)).toBe(true);
    expect(rec.throttle).toBe(5);
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netFull + cons / 2, 6);
    expect(structureToGridNode(rec).powerConsumption).toBeCloseTo(cons / 2, 6);
    expect(structureDraw(cons, false, false, 5)).toBeCloseTo((cons * IDLE_DRAW_FRAC) / 2, 6); // idle halves too
    // A topology rebuild agrees with the O(1) adjustment.
    b.registry.topologyDirty = true;
    b.pulse();
    b.grid.tickTurrets(11_000);
    expect(rec.drawFull).toBe(true);
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netFull + cons / 2, 6);
    // Active-power changes keep the throttle: idle is half the idle trickle.
    b.grid.setActive(rec, false);
    const netIdleHalf = netFull + cons - (cons * IDLE_DRAW_FRAC) / 2;
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netIdleHalf, 6);
    // Off still draws nothing, and On comes back throttled.
    b.grid.setSwitchedOn(rec, false);
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netFull + cons, 6);
    b.grid.setSwitchedOn(rec, true);
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(netIdleHalf, 6);
  });

  it('the default 100% is unchanged', () => {
    const b = poweredTurretBase();
    const rec = b.registry.get(b.turret)!;
    const cons = getStructureKind('turret').powerConsumption;
    expect(rec.throttle).toBeUndefined();
    expect(structureDraw(cons, true)).toBe(cons);
    expect(structureDraw(cons, true, false, 10)).toBe(cons);
    expect(structureDraw(cons, false, false, 10)).toBe(cons * IDLE_DRAW_FRAC);
    const net = b.grid.powerSummaryFor(b.turret).netPower;
    expect(b.grid.setThrottle(rec, 10)).toBe(false); // already 100%
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBe(net);
    // Back to 100% after a throttle clears the field (an unthrottled record carries nothing).
    b.grid.setThrottle(rec, 3);
    expect(b.grid.setThrottle(rec, 10)).toBe(true);
    expect(rec.throttle).toBeUndefined();
    expect(b.grid.powerSummaryFor(b.turret).netPower).toBeCloseTo(net, 6);
    // Wire: 100% sends no flag bits; the throttle bits sit clear of the named flags.
    expect(encodeStructureThrottleFlags(10)).toBe(0);
    expect(encodeStructureThrottleFlags(0) & (STRUCTURE_FLAG_OFF * 2 - 1)).toBe(0);
    expect(encodeStructureThrottleFlags(0)).toBeLessThan(1 << 16);
    for (let t = 0; t <= 10; t++) expect(decodeStructureThrottleFlags(encodeStructureThrottleFlags(t) | STRUCTURE_FLAG_OFF)).toBe(t);
    // A kind with no Off has no throttle either.
    const solar = b.registry.all().find((r) => r.kind === 'solar')!;
    expect(b.grid.setThrottle(solar, 5)).toBe(false);
    expect(solar.throttle).toBeUndefined();
  });

  it('only the owner can set it', () => {
    const b = poweredTurretBase();
    const rec = b.registry.get(b.turret)!;
    const m = powerMessages(b);
    const msg = { type: 'set_structure_power', entityId: 42, on: true, throttle: 5 };
    m.send('sess-other', msg);
    expect(rec.throttle).toBeUndefined();
    expect(m.rebuilds()).toBe(0);
    m.send('sess-owner', msg);
    expect(rec.throttle).toBe(5);
    expect(m.rebuilds()).toBe(1);
    m.send('sess-other', { ...msg, throttle: 0 });
    expect(rec.throttle).toBe(5);
    // Strict: out-of-range or fractional throttles are rejected.
    expect(SetStructurePowerSchema.safeParse({ ...msg, throttle: 11 }).success).toBe(false);
    expect(SetStructurePowerSchema.safeParse({ ...msg, throttle: 2.5 }).success).toBe(false);
    expect(SetStructurePowerSchema.safeParse({ type: 'set_structure_power', entityId: 42, on: true }).success).toBe(true);
    m.send('sess-owner', { ...msg, throttle: 11 });
    expect(rec.throttle).toBe(5);
  });

  it('it survives save and restore', () => {
    const b = poweredTurretBase();
    const rec = b.registry.get(b.turret)!;
    b.grid.setThrottle(rec, 3);
    let stored: { snapshot: string; created_at: number } | undefined;
    let restored: readonly SectorSnapshotStructure[] = [];
    const persistence = new SectorPersistence({
      sectorKey: () => 'galaxy-sol',
      sabF32: new Float32Array(64),
      swarmRegistry: { all: () => [], has: () => false },
      swarmHealth: new Map([[rec.id, 100]]),
      structures: () => [rec as PersistableStructure],
      restoreStructures: (rows) => { restored = rows; },
      scrapEntities: () => [],
      restoreScrap: () => undefined,
      lingeringHulls: () => [],
      restoreLingeringHulls: () => undefined,
      saveRow: (_key: string, payload: SectorSnapshotPayload) => { stored = { snapshot: JSON.stringify(payload), created_at: Date.now() }; },
      loadRow: () => stored,
      logger: { info: () => undefined, warn: () => undefined } as unknown as Logger,
    });
    persistence.persist();
    persistence.hydrate();
    const row = restored.find((r) => r.entityId === rec.id)!;
    expect(row.throttle).toBe(3);
    // SectorSnapshotRestore stores it through the same normaliser.
    expect(normalizeStructureThrottle(row.throttle)).toBe(3);
    expect(normalizeStructureThrottle(undefined)).toBeUndefined();
    expect(normalizeStructureThrottle(10)).toBeUndefined();
    expect(normalizeStructureThrottle(42)).toBeUndefined();
    expect(normalizeStructureThrottle(-1)).toBe(0);
  });
});

describe('structure throttle and work speed', () => {
  it("a turret's fire rate ignores throttle", () => {
    const full = poweredTurretBase();
    const throttled = poweredTurretBase();
    const rec = throttled.registry.get(throttled.turret)!;
    expect(throttled.grid.setThrottle(rec, 0)).toBe(true);
    expect(throttled.grid.powerSummaryFor(throttled.turret).powered).toBe(true);
    for (let t = 10_000; t <= 20_000; t += 100) {
      full.grid.tickTurrets(t);
      throttled.grid.tickTurrets(t);
    }
    expect(full.damage.length).toBeGreaterThan(1);
    expect(throttled.damage.length).toBe(full.damage.length);
  });
});
