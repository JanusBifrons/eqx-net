/**
 * Structure kinds — the base grid: the Capital, hubs, power, mining, the first defences and the gates. Family file of the structure catalogue
 * (barrel: `../structureKinds.ts`). A new kind's record goes in its family
 * file AND is APPENDED to `catalogueOrder.ts` (invariant #11).
 */
import type { StructureKind } from './types.js';

// ---------------------------------------------------------------------------
// Kind records. Values mirror eqx-peri's STRUCTURE_DEFINITIONS + The Space
// Game; see the plan's "Logistics mechanics reference" table.
// ---------------------------------------------------------------------------

/** The Core — pre-built root hub. Baseline power + the big mineral bank. */
export const CAPITAL: StructureKind = {
  id: 'capital',
  displayName: 'Capital',
  description: 'The Core. Pre-built root hub: baseline power output and the main mineral bank.',
  radius: 396, // bounding circle of the 560×560 footprint
  footprint: { w: 560, h: 560 },
  maxHealth: 5000,
  maxConnections: 4,
  isHub: true,
  // P3.2 — the Capital uses the SAME connection range as every other kind: no
  // per-kind override (the R2.10 shorter-reach was reverted — "everything has
  // the same range connectors"). With no kind setting `connectionRange`, every
  // pair uses the global CONNECTION_MAX_RANGE.
  powerOutput: 50,
  powerConsumption: 0,
  // P2e — the bank holds minerals at the goods scale (50k minerals = 5000 weight).
  storageCapacity: 50_000,
  // Living World P1a-2 — the Capital is the largest cargo hold.
  holdCapacity: 5_000,
  constructionCost: 0,
  color: 0xffcc44,
};

/** Living World P1a-2 — a cheap forward drop-off: a leaf storage structure you
 *  can build at an outpost so a long haul doesn't have to reach the Capital.
 *  Connected storage forms one network (deposit overflows across it). */
export const CARGO_BAY: StructureKind = {
  id: 'cargo_bay',
  displayName: 'Cargo Bay',
  description: 'A forward drop-off. Fly close to deposit loot; it joins your base storage network.',
  radius: 189, // bounding circle of the 320×200 footprint
  footprint: { w: 320, h: 200 },
  maxHealth: 900,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  holdCapacity: 2_000,
  constructionCost: 300,
  color: 0x5fd6c4,
};

/** The Relay — a cheap, low-HP pure hub node. The linking mechanism. */
export const CONNECTOR: StructureKind = {
  id: 'connector',
  displayName: 'Connector',
  description: 'A relay. Tiny pure hub (≤6 links) that lets power + minerals flow between structures.',
  // WS-6 (R2.11) — shrunk 24→10: a relay should read as a small node, not a
  // building. Floored well above the ~8 u collider/core-dot degeneracy point.
  radius: 46, // bounding circle of the 64×64 footprint
  footprint: { w: 64, h: 64 },
  maxHealth: 200,
  maxConnections: 6,
  isHub: true,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: 80,
  color: 0x66ccff,
};

/** Solar panel — the only power generator. A leaf node. */
export const SOLAR: StructureKind = {
  id: 'solar',
  displayName: 'Solar Panel',
  description: 'Power generator. Attaches to a hub and feeds the grid once built.',
  radius: 195, // bounding circle of the 360×150 footprint
  footprint: { w: 360, h: 150 },
  maxHealth: 300,
  maxConnections: 1,
  isHub: false,
  powerOutput: 30,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: 120,
  color: 0xffee66,
};

/** Mining tower — drills asteroids for minerals. A leaf node. */
export const MINER: StructureKind = {
  id: 'miner',
  displayName: 'Mining Tower',
  description: 'Drills asteroids in range for minerals (power-gated). A leaf node.',
  radius: 170, // bounding circle of the 240×240 footprint
  footprint: { w: 240, h: 240 },
  maxHealth: 2000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 60,
  // P2e — retuned to the goods scale: 20 minerals a pulse (was 1000, which
  // made minerals effectively unlimited), a 2000-mineral buffer.
  storageCapacity: 2_000,
  constructionCost: 400,
  color: 0xee8844,
  miningRate: 20,
  miningRange: 800,
  mounts: [
    {
      id: 'drill',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: -Math.PI,
      arcMax: Math.PI,
      rotationSpeed: 2,
      weaponId: 'laser',
    },
  ],
};

/** Defensive turret — targets hostile drones, power-gated firing. A leaf. */
export const TURRET: StructureKind = {
  id: 'turret',
  displayName: 'Turret',
  description: 'Defensive turret. Targets hostile drones in range (power-gated). A leaf node.',
  radius: 99, // bounding circle of the 140×140 footprint
  footprint: { w: 140, h: 140 },
  maxHealth: 600,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 15,
  storageCapacity: 0,
  constructionCost: 300,
  color: 0xff5555,
  weaponRange: 600,
  fireRateMs: 600,
  weaponDamage: 20,
  mounts: [
    {
      id: 'barrel',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: -Math.PI,
      arcMax: Math.PI,
      rotationSpeed: 3,
      weaponId: 'hitscan',
    },
  ],
};

/** Battery — stored-power buffer. A leaf node that produces/consumes no power
 *  itself; it charges from a powered grid's surplus and discharges to keep its
 *  component running through a deficit (turrets/miners/shield-walls draw on it
 *  when generation dips). The shield-wall damage model drains it first. */
export const BATTERY: StructureKind = {
  id: 'battery',
  displayName: 'Battery',
  description:
    'Stores surplus power and discharges to keep the grid running through a deficit. A leaf node.',
  radius: 135, // bounding circle of the 190×190 footprint
  footprint: { w: 190, h: 190 },
  maxHealth: 800,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 0,
  storageCapacity: 0,
  constructionCost: 600,
  color: 0xcc8844,
  powerStorageCapacity: 300,
};

/** Shield Pylon — pairs with another pylon to project a blocking shield wall in
 *  the span between them (the wall itself is a derived collider, NOT a catalogue
 *  kind). A HUB (so two pylons may connect directly under the hub rule), it draws
 *  power while it stands; the wall stuns when the grid browns out under fire.
 *  Hull-only — the wall, not the pylon, is the "shield" (grid-power-modelled). */
export const SHIELD_PYLON: StructureKind = {
  id: 'shield_pylon',
  displayName: 'Shield Pylon',
  description:
    'Pairs with another pylon to project a blocking shield wall between them. A powered hub.',
  // WS-6 (R2.18) — shrunk 30→12: the WALL SPAN is the visual, not the post; a
  // tiny pylon de-emphasises the node. The wall geometry is pose-to-pose
  // (ShieldWall.ts centre-to-centre), so a smaller post does NOT shrink the wall.
  radius: 51, // bounding circle of the 72×72 footprint
  footprint: { w: 72, h: 72 },
  maxHealth: 800,
  maxConnections: 3,
  isHub: true,
  powerOutput: 0,
  powerConsumption: 20,
  storageCapacity: 0,
  constructionCost: 500,
  color: 0x4488ff,
};

/** Bolt Turret (WS-8 / R2.15) — fires dodgeable PROJECTILE bolts (the existing
 *  `laser` weapon) at hostile drones, rather than the instant beam the hitscan
 *  `turret` uses. A leaf. Orange + square silhouette so it reads apart from the
 *  red triangle beam turret. Cadence/damage are the per-kind `fireRateMs` /
 *  `weaponDamage`; the bolt travels + collides via the projectile sim. */
export const LASER_BOLT_TURRET: StructureKind = {
  id: 'laser_bolt_turret',
  displayName: 'Bolt Turret',
  description: 'Fires travelling bolts at hostile drones in range (power-gated). A leaf node.',
  radius: 107, // bounding circle of the 150×150 footprint
  footprint: { w: 150, h: 150 },
  maxHealth: 600,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 18,
  storageCapacity: 0,
  constructionCost: 350,
  color: 0xff8844,
  weaponRange: 900,
  fireRateMs: 600,
  weaponDamage: 18,
  mounts: [
    {
      id: 'barrel',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: -Math.PI,
      arcMax: Math.PI,
      rotationSpeed: 3,
      weaponId: 'laser',
    },
  ],
};

/** Missile Turret (WS-8 / R2.15) — launches homing MISSILES (the existing
 *  `heat-seeker`) at hostile drones; slow salvo, heavy power draw, big splash
 *  (which CAN hit your own base — realistic, by user choice). A leaf. Teal +
 *  larger hexagon so it reads as a heavy emplacement. The missile homes via the
 *  shared MissileSimulation; a structure-owned missile locks onto DRONES ONLY
 *  (the server-fire path adds the pstruct-owner targeting branch). */
export const MISSILE_TURRET: StructureKind = {
  id: 'missile_turret',
  displayName: 'Missile Turret',
  description: 'Launches homing missiles at hostile drones in range (power-gated). A leaf node.',
  radius: 135, // bounding circle of the 190×190 footprint
  footprint: { w: 190, h: 190 },
  maxHealth: 800,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 30,
  storageCapacity: 0,
  constructionCost: 600,
  color: 0x66ccaa,
  weaponRange: 1200,
  fireRateMs: 1500,
  weaponDamage: 150,
  mounts: [
    {
      id: 'launcher',
      localX: 0,
      localY: 0,
      baseAngle: 0,
      arcMin: -Math.PI,
      arcMax: Math.PI,
      rotationSpeed: 2,
      weaponId: 'heat-seeker',
    },
  ],
};

/** Shield Gate — two posts placed as ONE structure, with a shield span between
 *  them that opens when a ship the gate admits approaches (per-gate access
 *  setting). Joins a fence like a pylon: a pylon-rule hub (one connector tap +
 *  fence links). Geometry, approach zones and the open/close logic live in
 *  `src/core/structures/gateGeometry.ts` + `gateLogic.ts`. */
export const SHIELD_GATE: StructureKind = {
  id: 'shield_gate',
  displayName: 'Shield Gate',
  description:
    'Two posts with a shield span between them. Opens for ships it admits, closes behind them. Joins a fence like a pylon.',
  radius: 164, // bounding circle of the 320×72 footprint
  footprint: { w: 320, h: 72 },
  maxHealth: 1200,
  maxConnections: 3,
  isHub: true,
  powerOutput: 0,
  powerConsumption: 30,
  storageCapacity: 0,
  constructionCost: 900,
  color: 0x4488ff,
};

/** Shield Airlock — a chamber with a Shield Gate span at each end. It opens one
 *  end or the other, never both, cycling a ship through. */
export const SHIELD_AIRLOCK: StructureKind = {
  id: 'shield_airlock',
  displayName: 'Shield Airlock',
  description:
    'A chamber with a shield span at each end. Opens one end or the other, never both, to cycle a ship through.',
  radius: 207, // bounding circle of the 320×260 footprint
  footprint: { w: 320, h: 260 },
  maxHealth: 1800,
  maxConnections: 3,
  isHub: true,
  powerOutput: 0,
  powerConsumption: 50,
  storageCapacity: 0,
  constructionCost: 1500,
  color: 0x4488ff,
};
