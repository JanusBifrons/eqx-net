/**
 * Structure kinds — consolidated kinds. Family file of the structure catalogue
 * (barrel: `../structureKinds.ts`). A new kind's record goes in its family
 * file AND is APPENDED to `catalogueOrder.ts` (invariant #11).
 */
import type { StructureKind } from './types.js';

// ── Consolidated kinds (plan soft-leaping-truffle v3, D1) ──────────────────
// Each replaces several standard units in one footprint and one link, priced
// ABOVE the units it replaces, so only wealthy bases have many.

/** ~8 Solars of power from one footprint, while it has fuel. */
export const REACTOR: StructureKind = {
  id: 'reactor',
  displayName: 'Reactor',
  description: 'Burns fuel from base storage for about eight Solars of power. No fuel, no power. A leaf node.',
  radius: 425, // bounding circle of the 600×600 footprint
  footprint: { w: 600, h: 600 },
  maxHealth: 3000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 960,
  powerConsumption: 0,
  storageCapacity: 0,
  fuelEveryPulses: 10,
  constructionCost: 4000,
  color: 0xff6f3c,
};

/** Ten Batteries of stored power in one footprint. */
export const BATTERY_BANK: StructureKind = {
  id: 'battery_bank',
  displayName: 'Battery Bank',
  description: 'Stores as much power as ten Batteries. A leaf node.',
  radius: 425, // bounding circle of the 600×600 footprint
  footprint: { w: 600, h: 600 },
  maxHealth: 2500,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  powerStorageCapacity: 3000,
  constructionCost: 9000,
  color: 0xc8e86a,
};

/** Eight Cargo Bays of hold in one footprint. */
export const STORAGE_VAULT: StructureKind = {
  id: 'storage_vault',
  displayName: 'Storage Vault',
  description: 'Holds as much as eight Cargo Bays; part of the base storage network. A leaf node.',
  radius: 289, // bounding circle of the 480×320 footprint
  footprint: { w: 480, h: 320 },
  maxHealth: 4000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  holdCapacity: 16_000,
  constructionCost: 3600,
  color: 0x3fa89a,
};

/** Economy v2 W5b — builds packed HULLS from a ship blueprint + goods; a
 *  packed hull is unpacked into your roster at your storage. */
export const SHIPYARD: StructureKind = {
  id: 'shipyard',
  displayName: 'Shipyard',
  description: 'A huge yard that builds packed ships from a ship blueprint and goods (needs power). A hub (4 links); rare.',
  radius: 567, // bounding circle of the 960×600 footprint
  footprint: { w: 960, h: 600 },
  maxHealth: 9000,
  maxConnections: 4,
  isHub: true,
  powerOutput: 0,
  // Base loop: 220 power / 6500 minerals cut so a starter base (Capital +
  // 2 Solar + Refinery + Cargo Bay + Miner + Shipyard) fits the 5,000-mineral
  // Capital bank with a Mining Skiff (~400) left over. Guarded by
  // tests/unit/starterBaseBudget.test.ts.
  powerConsumption: 180,
  storageCapacity: 0,
  constructionCost: 2000,
  color: 0x7ec8ff,
};
