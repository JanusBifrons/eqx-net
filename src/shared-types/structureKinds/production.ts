/**
 * Structure kinds — production chains. Family file of the structure catalogue
 * (barrel: `../structureKinds.ts`). A new kind's record goes in its family
 * file AND is APPENDED to `catalogueOrder.ts` (invariant #11).
 */
import type { StructureKind } from './types.js';

// ── Production chains (plan soft-leaping-truffle v3, P2a) ─────────────────
// Processors, extraction and logistics. What each one runs is in
// `recipes.ts`; the processing step lands in P2b. Huge kinds are hubs with 4
// links so smaller processors cluster around them.

export const GAS_COLLECTOR: StructureKind = {
  id: 'gas_collector',
  displayName: 'Gas Collector',
  description: 'Collects gas from a nebula (nebula sectors only; power-gated). A leaf node.',
  radius: 213, // bounding circle of the 300×300 footprint
  footprint: { w: 300, h: 300 },
  maxHealth: 1500,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 40,
  storageCapacity: 0,
  gasRate: 20,
  constructionCost: 450,
  color: 0x88ddcc,
};

export const RECLAIMER: StructureKind = {
  id: 'reclaimer',
  displayName: 'Reclaimer',
  description: 'Breaks salvage down into minerals, with some alloy. A leaf node.',
  radius: 157, // bounding circle of the 240×200 footprint
  footprint: { w: 240, h: 200 },
  maxHealth: 1200,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 20,
  storageCapacity: 0,
  constructionCost: 300,
  color: 0xa7aeb8,
};

export const SMELTER: StructureKind = {
  id: 'smelter',
  displayName: 'Smelter',
  description: 'Smelts minerals into alloy. A leaf node.',
  radius: 223, // bounding circle of the 360×260 footprint
  footprint: { w: 360, h: 260 },
  maxHealth: 1800,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 40,
  storageCapacity: 0,
  constructionCost: 500,
  color: 0xff8844,
};

export const REFINERY: StructureKind = {
  id: 'refinery',
  displayName: 'Refinery',
  description: 'Refines ice into fuel, or cracks gas into fuel and polymer. A leaf node.',
  radius: 243, // bounding circle of the 380×300 footprint
  footprint: { w: 380, h: 300 },
  maxHealth: 1800,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 45,
  storageCapacity: 0,
  constructionCost: 600,
  color: 0x66aaee,
};

export const SILICON_WORKS: StructureKind = {
  id: 'silicon_works',
  displayName: 'Silicon Works',
  description: 'Grows silicon from crystal and minerals. A leaf node.',
  radius: 227, // bounding circle of the 320×320 footprint
  footprint: { w: 320, h: 320 },
  maxHealth: 1600,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 50,
  storageCapacity: 0,
  constructionCost: 700,
  color: 0xb48cff,
};

export const HYDROPONICS: StructureKind = {
  id: 'hydroponics',
  displayName: 'Hydroponics Bay',
  description: 'Grows provisions from ice and power. A leaf node.',
  radius: 233, // bounding circle of the 420×200 footprint
  footprint: { w: 420, h: 200 },
  maxHealth: 1200,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 35,
  storageCapacity: 0,
  constructionCost: 450,
  color: 0x77dd66,
};

export const FABRICATOR: StructureKind = {
  id: 'fabricator',
  displayName: 'Fabricator',
  description: 'Fabricates components or electronics (needs a blueprint). A leaf node.',
  radius: 300, // bounding circle of the 480×360 footprint
  footprint: { w: 480, h: 360 },
  maxHealth: 2200,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 60,
  storageCapacity: 0,
  constructionCost: 900,
  color: 0xffbb44,
};

export const MUNITIONS_WORKS: StructureKind = {
  id: 'munitions_works',
  displayName: 'Munitions Works',
  description: 'Makes munitions from alloy and fuel (needs a blueprint). A leaf node.',
  radius: 250, // bounding circle of the 400×300 footprint
  footprint: { w: 400, h: 300 },
  maxHealth: 2000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 50,
  storageCapacity: 0,
  constructionCost: 800,
  color: 0xdd5544,
};

export const FREIGHT_DOCK: StructureKind = {
  id: 'freight_dock',
  displayName: 'Freight Dock',
  description: 'Where trade convoys dock; holds cargo and sets import and export orders. A leaf node.',
  radius: 287, // bounding circle of the 520×240 footprint
  footprint: { w: 520, h: 240 },
  maxHealth: 2500,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 15,
  storageCapacity: 0,
  holdCapacity: 3_000,
  constructionCost: 700,
  color: 0x44bbaa,
};

export const DEEP_CORE_RIG: StructureKind = {
  id: 'deep_core_rig',
  displayName: 'Deep Core Rig',
  description: 'A huge mining platform: drills a large asteroid for minerals and crystal. A hub (4 links); rare.',
  radius: 538, // bounding circle of the 760×760 footprint
  footprint: { w: 760, h: 760 },
  maxHealth: 8000,
  maxConnections: 4,
  isHub: true,
  powerOutput: 0,
  powerConsumption: 150,
  storageCapacity: 6_000,
  miningRate: 120,
  miningRange: 1000,
  mounts: [
    {
      id: 'drill',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: -Math.PI,
      arcMax: Math.PI,
      rotationSpeed: 1.2,
      weaponId: 'laser',
    },
  ],
  constructionCost: 4000,
  color: 0xcc7733,
};

export const ORE_PROCESSING_COMPLEX: StructureKind = {
  id: 'ore_processing_complex',
  displayName: 'Ore Processing Complex',
  description: 'A huge refinery: smelts alloy and grows silicon in bulk, with better yields. A hub (4 links); rare.',
  radius: 517, // bounding circle of the 840×600 footprint
  footprint: { w: 840, h: 600 },
  maxHealth: 9000,
  maxConnections: 4,
  isHub: true,
  powerOutput: 0,
  powerConsumption: 160,
  storageCapacity: 0,
  constructionCost: 5000,
  color: 0xff9955,
};

export const ASSEMBLY_PLANT: StructureKind = {
  id: 'assembly_plant',
  displayName: 'Assembly Plant',
  description: 'A huge plant that assembles machinery or consumer goods (needs a blueprint). A hub (4 links); rare.',
  radius: 553, // bounding circle of the 900×640 footprint
  footprint: { w: 900, h: 640 },
  maxHealth: 10000,
  maxConnections: 4,
  isHub: true,
  powerOutput: 0,
  powerConsumption: 200,
  storageCapacity: 0,
  constructionCost: 6000,
  color: 0xffd166,
};

export const RESEARCH_LAB: StructureKind = {
  id: 'research_lab',
  displayName: 'Research Lab',
  description: 'Researches, copies and combines blueprints held in your base storage (needs power). A leaf node.',
  radius: 250, // bounding circle of the 400×300 footprint
  footprint: { w: 400, h: 300 },
  maxHealth: 1800,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 80,
  storageCapacity: 0,
  constructionCost: 1500,
  color: 0x9b7bff,
};

/** P2d — a kinetic gun turret: fast, short-ranged shells that spend MUNITIONS
 *  (one unit = `AMMO_SHOTS_PER_UNIT` bursts). A leaf node. */
export const AUTOCANNON_TURRET: StructureKind = {
  id: 'autocannon_turret',
  displayName: 'Autocannon Turret',
  description: 'Fires kinetic shells at hostiles in range. Uses munitions from base storage. A leaf node.',
  radius: 114, // bounding circle of the 160×160 footprint
  footprint: { w: 160, h: 160 },
  maxHealth: 1400,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 12,
  storageCapacity: 0,
  constructionCost: 450,
  color: 0xc9b18a,
  weaponRange: 700,
  fireRateMs: 250,
  weaponDamage: 10,
  mounts: [
    {
      id: 'barrel',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: -Math.PI,
      arcMax: Math.PI,
      rotationSpeed: 4,
      weaponId: 'autocannon',
    },
  ],
};
