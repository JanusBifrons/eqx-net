import { describe, it, expect } from 'vitest';
import { getStructureKind, type StructureKindId } from '../../src/shared-types/structureKinds.js';
import { CAPITAL_STARTING_MINERALS } from '../../src/core/structures/structureGridConstants.js';

// The base loop: a new pilot's Capital crate holds CAPITAL_STARTING_MINERALS.
// With that bank alone they build and power Refinery + Cargo Bay + Miner +
// Shipyard (plus the Solar panels the draw needs) and still afford one Mining
// Skiff at the yard. Sums the REAL catalogue numbers, so a price or power change
// that breaks the loop fails here.

/** Mining Skiff build price at the yard (owner brief: about 400 minerals). */
const MINING_SKIFF_MINERALS = 400;

const STARTER_BUILDINGS: readonly StructureKindId[] = ['refinery', 'cargo_bay', 'miner', 'shipyard'];

describe('starter base budget', () => {
  it('a starter base fits the 5,000 crate bank', () => {
    expect(CAPITAL_STARTING_MINERALS).toBe(5000);
    const capital = getStructureKind('capital');
    const solar = getStructureKind('solar');

    const draw = STARTER_BUILDINGS.reduce((s, id) => s + getStructureKind(id).powerConsumption, 0);
    // Solar is the cheap generator; buy as many as the draw needs past the Capital's own output.
    const solars = Math.max(0, Math.ceil((draw - capital.powerOutput) / solar.powerOutput));
    const supply = capital.powerOutput + solars * solar.powerOutput;
    expect(supply).toBeGreaterThanOrEqual(draw);

    const buildings = STARTER_BUILDINGS.reduce((s, id) => s + getStructureKind(id).constructionCost, 0);
    const total = buildings + solars * solar.constructionCost + capital.constructionCost;
    const left = CAPITAL_STARTING_MINERALS - total;
    expect(left).toBeGreaterThanOrEqual(MINING_SKIFF_MINERALS);
  });

  it('the Capital has the links for the starter base (yard is a hub for the rest)', () => {
    // Capital: refinery, cargo bay, miner, shipyard; the yard hub carries the solars.
    const capital = getStructureKind('capital');
    const yard = getStructureKind('shipyard');
    expect(capital.maxConnections).toBeGreaterThanOrEqual(STARTER_BUILDINGS.length);
    expect(yard.isHub).toBe(true);
    expect(yard.maxConnections - 1).toBeGreaterThanOrEqual(2);
  });
});
