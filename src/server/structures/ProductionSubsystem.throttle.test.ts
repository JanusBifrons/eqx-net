/**
 * The owner throttle scales WORK SPEED through the one shared helper
 * `structureWorkRate`: every processor (Refinery, Shipyard, …) multiplies its
 * per-pulse progress step by it, so 50% takes twice as long and 0% does no
 * work while the structure still reads powered. The default is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { ProductionSubsystem } from './ProductionSubsystem.js';
import type { StructureRecord, StructureRegistry } from './StructureRegistry.js';
import { PROD_STATE } from '../../shared-types/production.js';
import { RECIPES } from '../../shared-types/recipes.js';
import { structureWorkRate } from '../../shared-types/structurePower.js';
import type { BlueprintItem } from '../../shared-types/items.js';

function rec(id: string, kind: StructureRecord['kind'], over: Partial<StructureRecord> = {}): StructureRecord {
  return {
    id, owner: 'alice', kind, subtypeIndex: 0, x: 0, y: 0, radius: 10,
    isConstructed: true, constructionProgress: 0, constructionCost: 0,
    isDeconstructing: false, minerals: 0, storedPower: 0, ...over,
  };
}

/** Pulses until `done()` holds (capped). */
function pulsesUntil(recs: StructureRecord[], done: () => boolean, cap = 1000): number {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const ids = recs.map((r) => r.id);
  const registry = { all: () => byId.values(), get: (id: string) => byId.get(id) } as unknown as StructureRegistry;
  const prod = new ProductionSubsystem({ registry, powered: () => true, componentOf: () => ids });
  let n = 0;
  while (!done() && n < cap) { prod.pulse(); n++; }
  return n;
}

const GAS = RECIPES.refine_gas.cyclePulses;
const YARD = RECIPES.build_interceptor.cyclePulses;

function refinery(throttle?: number) {
  const bay = rec('bay', 'cargo_bay', { hold: { goods: { gas: 40 }, blueprints: [] } });
  const r = rec('r', 'refinery', { recipe: 'refine_gas', ...(throttle !== undefined ? { throttle } : {}) });
  return { recs: [bay, r], fuel: () => bay.hold!.goods.fuel ?? 0, r };
}

function shipyard(throttle?: number) {
  const bill = RECIPES.build_interceptor.inputs;
  const capital = rec('c', 'capital', { minerals: bill.minerals! });
  const bay = rec('bay', 'cargo_bay', { hold: { goods: {}, blueprints: [] } });
  const blueprint: BlueprintItem = { uid: 'bp1', product: 'hull:interceptor', kind: 'bpo', runs: null, material: 0, output: 0, research: 0 };
  const yard = rec('y', 'shipyard', { recipe: 'build_interceptor', blueprint, ...(throttle !== undefined ? { throttle } : {}) });
  const built = () => [...(capital.hold?.packed ?? []), ...(bay.hold!.packed ?? [])].length > 0;
  return { recs: [capital, bay, yard], built };
}

describe('structureWorkRate', () => {
  it('is 1 at the default, the tenths when throttled, 0 when Off', () => {
    expect(structureWorkRate({})).toBe(1);
    expect(structureWorkRate({ throttle: 5 })).toBe(0.5);
    expect(structureWorkRate({ throttle: 0 })).toBe(0);
    expect(structureWorkRate({ switchedOff: true })).toBe(0);
    expect(structureWorkRate({ switchedOff: true, throttle: 5 })).toBe(0);
  });
});

describe('throttle scales production work speed', () => {
  it('the default is unchanged', () => {
    const w = refinery();
    expect(pulsesUntil(w.recs, () => w.fuel() >= 1)).toBe(GAS);
    const y = shipyard();
    expect(pulsesUntil(y.recs, y.built)).toBe(YARD);
  });

  it('a refinery at 50% takes twice as long', () => {
    const w = refinery(5);
    expect(pulsesUntil(w.recs, () => w.fuel() >= 1)).toBe(GAS * 2);
  });

  it('a shipyard build at 50% takes twice as long', () => {
    const y = shipyard(5);
    expect(pulsesUntil(y.recs, y.built)).toBe(YARD * 2);
  });

  it('tenths always add up to a whole cycle (30% ⇒ ceil(cycle / 0.3))', () => {
    const w = refinery(3);
    expect(pulsesUntil(w.recs, () => w.fuel() >= 1)).toBe(Math.ceil(GAS / 0.3 - 1e-9));
  });

  it('0% does no work, but the refinery still reads powered', () => {
    const w = refinery(0);
    expect(pulsesUntil(w.recs, () => w.fuel() >= 1, GAS * 10)).toBe(GAS * 10);
    expect(w.fuel()).toBe(0);
    expect(w.r.prodProgress ?? 0).toBe(0);
    expect(w.r.prodState).not.toBe(PROD_STATE.unpowered);
  });
});
