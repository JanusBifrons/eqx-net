/**
 * A processor on a grid that can't carry its FULL draw (Pixel 7 film: a starter
 * base of Capital + Connector + Shipyard; the grid is +14 with the yard idle,
 * and the yard's full draw would sink it far below zero). It used to start,
 * black the grid out, stop, get power back and start again every pulse, so the
 * card flipped between "No power" and "UNPOWERED · Running". Now an idle
 * processor only starts when the grid can take its full draw: it holds a
 * steady "No power" (and its row reads unpowered) until the grid can cover it.
 * Real grid + real production, wired as the room wires them.
 */
import { describe, it, expect } from 'vitest';
import { StructureRegistry } from './StructureRegistry.js';
import { StructurePlacementSubsystem } from './StructurePlacementSubsystem.js';
import { StructureGridSubsystem } from './StructureGridSubsystem.js';
import { ProductionSubsystem } from './ProductionSubsystem.js';
import { canTakeFullDraw, structureReadsPowered } from './structurePowerSwitch.js';
import { getStructureKind } from '../../shared-types/structureKinds.js';
import { PROD_STATE } from '../../shared-types/production.js';
import { RECIPES } from '../../shared-types/recipes.js';
import type { BlueprintItem } from '../../shared-types/items.js';

const OWNER = 'player-1';

function starterBase(extra: Array<[string, number, number]> = []) {
  const registry = new StructureRegistry();
  const health = new Map<string, number>();
  let counter = 0;
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
  });
  const build = (id: string | null): string => {
    expect(id).not.toBeNull();
    const r = registry.get(id!)!;
    r.isConstructed = true;
    r.constructionProgress = r.constructionCost;
    health.set(id!, getStructureKind(r.kind).maxHealth);
    return id!;
  };
  const capital = placement.place(OWNER, 'capital', 0, 0)!;
  build(placement.place(OWNER, 'connector', 0, -350));
  const yardId = build(placement.place(OWNER, 'shipyard', 0, -760));
  for (const [kind, x, y] of extra) build(placement.place(OWNER, kind, x, y));
  registry.topologyDirty = true;
  // The yard's bill (many hulls' worth) in the Capital bank, a BPO in its slot.
  const bill = RECIPES.build_interceptor.inputs;
  registry.get(capital)!.minerals = (bill.minerals ?? 0) * 50;
  const yard = registry.get(yardId)!;
  const blueprint: BlueprintItem = { uid: 'bp1', product: 'hull:interceptor', kind: 'bpo', runs: null, material: 0, output: 0, research: 0 };
  yard.recipe = 'build_interceptor';
  yard.blueprint = blueprint;
  // As the room wires it (SectorRoom: production deps).
  const prod = new ProductionSubsystem({
    registry,
    powered: (id) => grid.powerSummaryFor(id).powered,
    canDrawFull: (rec) => { const s = grid.powerSummaryFor(rec.id); return canTakeFullDraw(rec, s.powered, s.netPower, grid.componentBatteryCharge(rec.id)); },
    componentOf: (id) => grid.componentMembersOf(id),
    setActive: (rec, active) => grid.setActive(rec, active),
  });
  let now = 0;
  /** One 1 Hz grid heartbeat, then production (structuresSlice.gridTick order). */
  const pulse = () => { grid.pulse(now += 1000); prod.pulse(); };
  /** What the client reads after the pulse: the work line and the PWR line. */
  const readout = () => ({
    prodState: yard.prodState,
    powered: structureReadsPowered(yard, grid.powerSummaryFor(yard.id).powered),
  });
  return { grid, yard, pulse, readout, registry, capital, build: (kind: string, x: number, y: number) => build(placement.place(OWNER, kind, x, y)) };
}

describe('a processor on a grid that cannot carry its full draw', () => {
  it('the starter base yard holds a steady "No power" for 10 s, never flips to Running', () => {
    const b = starterBase();
    b.pulse();
    const seen: Array<ReturnType<typeof b.readout>> = [];
    for (let i = 0; i < 10; i++) {
      b.pulse();
      seen.push(b.readout());
    }
    // Never flips: every second reads the same, steady "No power".
    expect(new Set(seen.map((r) => `${r.prodState}/${r.powered}`)).size).toBe(1);
    for (const r of seen) expect(r).toEqual({ prodState: PROD_STATE.unpowered, powered: false });
    expect(b.yard.drawFull ?? false).toBe(false);
    expect(b.yard.prodLoaded ?? false).toBe(false);
    // The idle yard leaves the grid in surplus: the rest of the base stays powered.
    expect(b.grid.powerSummaryFor(b.yard.id).netPower).toBeGreaterThan(0);
  });

  it('throttled down to what the grid can carry, it runs steadily (the owner throttle is the way in)', () => {
    const b = starterBase();
    expect(b.grid.setThrottle(b.yard, 2)).toBe(true);
    b.pulse();
    for (let i = 0; i < 10; i++) {
      b.pulse();
      expect(b.readout()).toEqual({ prodState: PROD_STATE.running, powered: true });
      expect(b.grid.powerSummaryFor(b.yard.id).netPower).toBeGreaterThanOrEqual(0);
    }
  });

  it('with Solars enough for its full draw, it runs steadily', () => {
    const b = starterBase([['connector', 450, -350], ['solar', 650, 0], ['connector', -450, -350], ['solar', -650, 0]]);
    b.pulse();
    for (let i = 0; i < 10; i++) {
      b.pulse();
      expect(b.readout()).toEqual({ prodState: PROD_STATE.running, powered: true });
    }
  });
});

describe('a Refinery on a starter base (base-loop take F7: the card read UNPOWERED and RUNNING together)', () => {
  it('holds a steady "No power" its PWR line agrees with, never swinging the grid', () => {
    const b = starterBase();
    b.yard.recipe = undefined; // just the Refinery working
    b.build('connector', 450, -350);
    const refinery = b.registry.get(b.build('refinery', 900, -350))!;
    b.registry.topologyDirty = true;
    refinery.recipe = 'refine_ice_fuel';
    b.registry.get(b.capital)!.hold = { goods: { ice: 200 }, blueprints: [] };
    for (let i = 0; i < 12; i++) {
      b.pulse();
      const powered = structureReadsPowered(refinery, b.grid.powerSummaryFor(refinery.id).powered);
      // Never "UNPOWERED" beside "Running", nor a powered row beside "No power".
      expect(refinery.prodState === PROD_STATE.unpowered).toBe(!powered);
      // And it holds steady: no start, black-out, stop, restart swing (was +5 / -139).
      expect(refinery.prodState).toBe(PROD_STATE.unpowered);
      expect(b.grid.powerSummaryFor(refinery.id).netPower).toBeGreaterThan(0);
    }
  });
});
