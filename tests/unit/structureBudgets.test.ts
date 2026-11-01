/**
 * Structure-network budgets stay internally consistent and inside the game's
 * existing ceilings (plan soft-leaping-truffle v2, A0). The cost budgets
 * themselves are enforced by the phase locks (A1 benches, A2 bandwidth).
 */
import { describe, expect, it } from 'vitest';
import * as B from '../../src/shared-types/structureBudgets.js';
import { MAX_ENTITIES } from '../../src/shared-types/sabLayout.js';
import { MAX_STEADY_EXTRA_BYTES_PER_SEC } from '../../src/shared-types/baseBudgets.js';
import { buildStructureLattice } from '../../src/core/structures/structureLattice.js';

describe('structure budgets', () => {
  it('base ≤ sector ≤ a fifth of the swarm slot pool', () => {
    expect(B.MAX_STRUCTURES_PER_BASE).toBeLessThanOrEqual(B.MAX_STRUCTURES_PER_SECTOR);
    expect(B.MAX_STRUCTURES_PER_SECTOR).toBeLessThanOrEqual(MAX_ENTITIES / 5);
  });

  it('steady structure traffic fits the bases steady-extra ceiling', () => {
    expect(B.STRUCTURE_PATCH_IDLE_MAX_BYTES_PER_SEC).toBeLessThanOrEqual(MAX_STEADY_EXTRA_BYTES_PER_SEC);
    expect(B.STRUCTURE_BINARY_MAX_BYTES_PER_SEC).toBeLessThanOrEqual(MAX_STEADY_EXTRA_BYTES_PER_SEC);
    expect(B.STRUCTURE_PATCH_IDLE_MAX_BYTES_PER_SEC).toBeLessThan(B.STRUCTURE_PATCH_COMBAT_MAX_BYTES_PER_SEC);
  });

  it('the sector-max lattice (measured working at 664 structures, phase V) reaches the sector budget it justifies', () => {
    const lat = buildStructureLattice({ n: 600, seed: 7, fence: true });
    expect(lat.placements.length).toBeGreaterThanOrEqual(B.MAX_STRUCTURES_PER_SECTOR);
  });
});
