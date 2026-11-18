/**
 * Structure kinds — habitation modules, plus the Mine Layer, teleporters and the world-placed gates. Family file of the structure catalogue
 * (barrel: `../structureKinds.ts`). A new kind's record goes in its family
 * file AND is APPENDED to `catalogueOrder.ts` (invariant #11).
 */
import type { StructureKind } from './types.js';

// ── Habitation modules (plan soft-leaping-truffle v3, D3) ───────────────────
// Habitat stations are the production chain's main consumers: their residents
// use up provisions and consumer goods from base storage and pay their owner
// taxes. (Bases are space stations; the connector spines are their roads.)

/** Housing: uses provisions and a little consumer goods; pays taxes. */
export const HABITAT_MODULE: StructureKind = {
  id: 'habitat_module',
  displayName: 'Habitat Module',
  description: 'Housing. Its residents use provisions and consumer goods from base storage and pay you taxes. A leaf node.',
  radius: 217, // bounding circle of the 360×240 footprint
  footprint: { w: 360, h: 240 },
  maxHealth: 1500,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 20,
  storageCapacity: 0,
  constructionCost: 600,
  color: 0xf2c46b,
};

/** A residential spire: wealthier residents, more consumer goods, more taxes. */
export const TOWER_MODULE: StructureKind = {
  id: 'tower_module',
  displayName: 'Residential Spire',
  description: 'A residential spire. Wealthier residents use more consumer goods from base storage and pay more taxes. A leaf node.',
  radius: 170, // bounding circle of the 240×240 footprint
  footprint: { w: 240, h: 240 },
  maxHealth: 2200,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 30,
  storageCapacity: 0,
  constructionCost: 1200,
  color: 0xe8a3ff,
};

/** Lays proximity mines on a ring around itself (`shared-types/mines.ts`),
 *  paid in munitions from base storage. A leaf node. */
export const MINE_LAYER: StructureKind = {
  id: 'mine_layer',
  displayName: 'Mine Layer',
  description: 'Lays proximity mines around itself from munitions in base storage. Mines go off on ships hostile to you. A leaf node.',
  radius: 156, // bounding circle of the 220×220 footprint
  footprint: { w: 220, h: 220 },
  maxHealth: 1400,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 25,
  storageCapacity: 0,
  constructionCost: 900,
  color: 0xff8a3d,
};

/**
 * Teleporter (plan soft-leaping-truffle v4, T1): a pad ringed by four posts.
 * It pairs with one partner, and a jump swaps whatever sits on each pad. Its
 * capacitor fills from the grid's spare power. Pad sizes and the jump cycle
 * live in `shared-types/teleport.ts`.
 */
export const TELEPORTER: StructureKind = {
  id: 'teleporter',
  displayName: 'Teleporter',
  description:
    'A pad paired with one partner. A jump swaps whatever sits on both pads (ships and cargo). Charges from spare power; the charge depends on distance.',
  radius: 566, // bounding circle of the 800×800 footprint
  footprint: { w: 800, h: 800 },
  maxHealth: 2500,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 10,
  storageCapacity: 0,
  constructionCost: 2400,
  color: 0x9b7bff,
};

/** Large Teleporter: the same, sized for capital ships to come. */
export const TELEPORTER_LARGE: StructureKind = {
  id: 'teleporter_large',
  displayName: 'Large Teleporter',
  description:
    'A massive pad paired with one partner, sized for the largest hulls. A jump swaps whatever sits on both pads. Charges from spare power.',
  radius: 1500, // bounding circle of the 2120×2120 footprint
  footprint: { w: 2120, h: 2120 },
  maxHealth: 8000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 25,
  storageCapacity: 0,
  constructionCost: 9000,
  color: 0xb59bff,
};

/**
 * Alien gate (plan soft-leaping-truffle v4, phase A): the Ancients' border
 * gate. One sits on every sector edge that faces a neighbour, twinned with the
 * gate just across the border. It works like a teleporter but is bigger,
 * quicker and free, jumps on a fixed timetable, never joins a structure
 * network, can't be damaged, and disables anyone who attacks it. Nobody
 * builds one (`UNBUILDABLE_STRUCTURE_KINDS`).
 */
export const ALIEN_GATE: StructureKind = {
  id: 'alien_gate',
  displayName: 'Alien Gate',
  description:
    'An ancient gate twinned with one across the border. It jumps on its own every minute, free, and disables anyone who attacks it.',
  radius: 1132, // bounding circle of the 1600×1600 footprint
  footprint: { w: 1600, h: 1600 },
  maxHealth: 1_000_000,
  maxConnections: 0,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: 0,
  color: 0x3fe0c5,
};

/**
 * Transit pad (wrap-up plan W1b, solar-system sectors): a free, safe, instant
 * hop between two pockets of a system, for pilots who'd rather not cross open
 * space (user, 2026-11-08: "instant and safe for starters", but rarer than
 * warp: only a seeded few systems have a pair, home to one other pocket). Like
 * an alien gate it costs nothing and can't be damaged, but it jumps when a
 * ship boards rather than on a timetable. Nobody builds one.
 */
export const POCKET_PAD: StructureKind = {
  id: 'pocket_pad',
  displayName: 'Transit Pad',
  description:
    'A free pad linked to another pocket of this system. Fly onto it and it jumps you across, instantly and safely.',
  radius: 566, // bounding circle of the 800×800 footprint
  footprint: { w: 800, h: 800 },
  maxHealth: 1_000_000,
  maxConnections: 0,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: 0,
  color: 0x5ad7ff,
};
