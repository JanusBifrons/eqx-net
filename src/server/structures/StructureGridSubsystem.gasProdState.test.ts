/**
 * Gas Collector work state on the room row (`prodState`), read by the client's
 * work glow: running while it collects (nebula + powered), starved when
 * powered but there is no nebula (nothing to collect), unpowered without power.
 */
import { describe, it, expect } from 'vitest';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { PROD_STATE } from '../../shared-types/production.js';

const OWNER = 'player-1';

function gasBase() {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  let counter = 0;
  let nebula = true;
  const deposits: number[] = [];
  const placement = new StructurePlacementSubsystem({
    spawnStructure: () => true,
    seedHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    clamp: (x, y) => ({ x, y }),
    nextId: () => `s${counter++}`,
    registry,
  });
  const grid = new StructureGridSubsystem({
    registry,
    getHealth: (id) => health.get(id) ?? 0,
    setHealth: (id, hp) => health.set(id, hp),
    despawn: (id) => { health.delete(id); },
    findNearestAsteroid: () => null,
    findNearestDrone: () => null,
    applyDamage: () => {},
    broadcastBeam: () => {},
    sectorHasNebula: () => nebula,
    depositGoods: (_rec, _good, n) => { deposits.push(n); return n; },
  });
  placement.place(OWNER, 'capital', 0, 0, { rot: 180 });
  const relay = placement.place(OWNER, 'connector', 0, 350)!;
  const r = registry.get(relay)!;
  r.isConstructed = true;
  r.constructionProgress = r.constructionCost;
  health.set(relay, getStructureKind('connector').maxHealth);
  registry.topologyDirty = true;
  placement.place(OWNER, 'solar', 450, 500);
  const gas = placement.place(OWNER, 'gas_collector', -200, 450)!;
  let now = 0;
  const pulse = () => grid.pulse(now += 1000);
  for (let i = 0; i < 120; i++) pulse();
  const rec = registry.get(gas)!;
  expect(rec.isConstructed).toBe(true);
  return { grid, rec, deposits, pulse, setNebula: (v: boolean) => { nebula = v; } };
}

describe('Gas Collector prodState (work glow)', () => {
  it('running in a nebula with power', () => {
    const b = gasBase();
    b.pulse();
    expect(b.rec.prodState).toBe(PROD_STATE.running);
    expect(b.deposits.length).toBeGreaterThan(0);
  });

  it('starved when powered but not in a nebula', () => {
    const b = gasBase();
    b.setNebula(false);
    const before = b.deposits.length;
    b.pulse();
    expect(b.rec.prodState).toBe(PROD_STATE.starved);
    expect(b.deposits.length).toBe(before);
  });

  it('unpowered when switched off; written only on change', () => {
    const b = gasBase();
    expect(b.grid.setSwitchedOn(b.rec, false)).toBe(true);
    b.pulse();
    expect(b.rec.prodState).toBe(PROD_STATE.unpowered);
    let writes = 0;
    let state = b.rec.prodState;
    Object.defineProperty(b.rec, 'prodState', { get: () => state, set: (v) => { state = v; writes++; } });
    b.pulse();
    b.pulse();
    expect(writes).toBe(0);
    expect(b.grid.setSwitchedOn(b.rec, true)).toBe(true);
    b.pulse();
    expect(b.rec.prodState).toBe(PROD_STATE.running);
    expect(writes).toBe(1);
  });
});
