/**
 * Structure kinds — coastal defences. Family file of the structure catalogue
 * (barrel: `../structureKinds.ts`). A new kind's record goes in its family
 * file AND is APPENDED to `catalogueOrder.ts` (invariant #11).
 */
import { navalGunEngageReach } from '../combat/navalGuns.js';
import type { StructureKind, StructureKindId } from './types.js';

// ── Coastal defences (plan coastal-defences) ───────────────────────────────
// Static guns in line with the capital ships' WW2 batteries: the same mount
// sizes, weapons, traverse rates and fire control (core/combat/mountFireControl
// + mountTargeting), so a 16" barbette fights like a battleship's 16" turret.
// Research: docs/research/ww2-coastal-defences.md. A gun's engage reach is its
// shell's (`weaponRange` is derived from the gun via `navalGunEngageReach`, for
// the range ring and the defence check; the AA mount repeats its autocannon;
// locked by tests/unit/coastalDefences.test.ts), and `fireRateMs` /
// `weaponDamage` repeat the weapon's reload and damage, so the structure turret
// path and the ship path agree. Each mount salvo fires one shell per barrel;
// quad AA fires its barrels in turn. Casemates train only through their
// embrasure (`arcMin`/`arcMax` about the structure's facing, rotation 0 = +y).
// Footprints are the emplacement; long barrels overhang it, as on a ship.

const DEG = Math.PI / 180;

/** Quad 40 mm Bofors: the anti-fighter screen. Fast traverse, short reach. */
export const AA_QUAD_40MM: StructureKind = {
  id: 'aa_quad_40mm',
  displayName: 'Quad 40 mm AA',
  description: 'A quad Bofors mount. Fast-training anti-fighter fire; prefers small craft. Uses munitions. A leaf node.',
  radius: 107, // bounding circle of the 150×150 footprint
  footprint: { w: 150, h: 150 },
  maxHealth: 1200,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 14,
  storageCapacity: 0,
  constructionCost: 500,
  color: 0xb8b09a,
  weaponRange: 1071,
  fireRateMs: 250,
  weaponDamage: 12,
  mounts: [
    { id: 'aa', localX: 0, localY: 0, baseAngle: 0, arcMin: -Math.PI, arcMax: Math.PI, rotationSpeed: 0.45, weaponId: 'autocannon', size: 'AA', barrels: 4 },
  ],
};

/** Twin 5"/38 dual-purpose mount, standalone (the battleship secondary). */
export const DP_MOUNT_5IN: StructureKind = {
  id: 'dp_mount_5in',
  displayName: '5" DP Mount',
  description: 'A twin 5"/38 dual-purpose mount. Prefers gunships and light capitals. Uses munitions. A leaf node.',
  radius: 142, // bounding circle of the 200×200 footprint
  footprint: { w: 200, h: 200 },
  maxHealth: 1800,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 20,
  storageCapacity: 0,
  constructionCost: 900,
  color: 0x9aa4ad,
  weaponRange: navalGunEngageReach('naval_s'),
  fireRateMs: 4000,
  weaponDamage: 60,
  mounts: [
    { id: 'dp', localX: 0, localY: 0, baseAngle: 0, arcMin: -Math.PI, arcMax: Math.PI, rotationSpeed: 0.26, weaponId: 'naval_s', size: 'S', barrels: 2 },
  ],
};

/** Single 8" gun in a concrete casemate (Batterie Hamburg's 24 cm). */
export const COASTAL_CASEMATE_8IN: StructureKind = {
  id: 'coastal_casemate_8in',
  displayName: '8" Casemate',
  description: 'A heavy gun in a concrete casemate. Fires only through its embrasure (120°). Uses munitions. A leaf node.',
  radius: 235, // bounding circle of the 360×300 footprint
  footprint: { w: 360, h: 300 },
  maxHealth: 4000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 30,
  storageCapacity: 0,
  constructionCost: 2000,
  color: 0x8f8a7e,
  weaponRange: navalGunEngageReach('naval_m'),
  fireRateMs: 10_000,
  weaponDamage: 350,
  mounts: [
    { id: 'main', localX: 0, localY: 0, baseAngle: 0, arcMin: -60 * DEG, arcMax: 60 * DEG, rotationSpeed: 0.14, weaponId: 'naval_m', size: 'M', barrels: 1 },
  ],
};

/** A battleship's triple turret on a concrete ring (Austrått's 28 cm, taken
 *  from Gneisenau). Trains all round. */
export const COASTAL_TURRET_11IN: StructureKind = {
  id: 'coastal_turret_11in',
  displayName: '11" Triple Turret',
  description: 'A capital-ship triple turret set in concrete. Trains all round; prefers capitals. Uses munitions. A leaf node.',
  radius: 297, // bounding circle of the 420×420 footprint
  footprint: { w: 420, h: 420 },
  maxHealth: 4500,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 45,
  storageCapacity: 0,
  constructionCost: 3500,
  color: 0x868c90,
  weaponRange: navalGunEngageReach('naval_l'),
  fireRateMs: 22_000,
  weaponDamage: 800,
  mounts: [
    { id: 'main', localX: 0, localY: 0, baseAngle: 0, arcMin: -Math.PI, arcMax: Math.PI, rotationSpeed: 0.087, weaponId: 'naval_l', size: 'L', barrels: 3 },
  ],
};

/** Twin 16"/50 in a casemated barbette (US Battery Townsley, 145° of fire). */
export const COASTAL_BARBETTE_16IN: StructureKind = {
  id: 'coastal_barbette_16in',
  displayName: '16" Barbette',
  description: 'Twin battleship guns under a casemate (145° of fire). Out-ranges most ships. Uses munitions. A leaf node.',
  radius: 368, // bounding circle of the 520×520 footprint
  footprint: { w: 520, h: 520 },
  maxHealth: 6000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 60,
  storageCapacity: 0,
  constructionCost: 5000,
  color: 0x7e8588,
  weaponRange: navalGunEngageReach('naval_xl'),
  fireRateMs: 30_000,
  weaponDamage: 1400,
  mounts: [
    { id: 'main', localX: 0, localY: 0, baseAngle: 0, arcMin: -72 * DEG, arcMax: 72 * DEG, rotationSpeed: 0.07, weaponId: 'naval_xl', size: 'XL', barrels: 2 },
  ],
};

/** Batterie Lindemann's 40.6 cm in its giant casemate: outranges every ship. */
export const COASTAL_LINDEMANN: StructureKind = {
  id: 'coastal_lindemann',
  displayName: '40.6 cm Super Battery',
  description: 'One enormous coast gun in a fortress casemate (120°). Outranges every ship afloat. Uses munitions. A leaf node.',
  radius: 426, // bounding circle of the 640×560 footprint
  footprint: { w: 640, h: 560 },
  maxHealth: 9000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 80,
  storageCapacity: 0,
  constructionCost: 8000,
  color: 0x77756e,
  weaponRange: navalGunEngageReach('naval_xxl'),
  fireRateMs: 30_000,
  weaponDamage: 1200,
  mounts: [
    { id: 'main', localX: 0, localY: 0, baseAngle: 0, arcMin: -60 * DEG, arcMax: 60 * DEG, rotationSpeed: 0.05, weaponId: 'naval_xxl', size: 'XL', barrels: 1, turretScale: 1.15 },
  ],
};

/** Schwerer Gustav's 80 cm on its rail carriage: one shell every two minutes,
 *  with a blast. Trains only a little either side of its track. */
export const SIEGE_GUN_80CM: StructureKind = {
  id: 'siege_gun_80cm',
  displayName: '80 cm Siege Gun',
  description: 'The largest gun ever built, on a rail carriage. One shell every two minutes, with a huge blast (60° of fire). Uses munitions. A leaf node.',
  radius: 475, // bounding circle of the 300×900 footprint
  footprint: { w: 300, h: 900 },
  maxHealth: 7000,
  maxConnections: 1,
  isHub: false,
  powerOutput: 0,
  powerConsumption: 100,
  storageCapacity: 0,
  constructionCost: 12_000,
  color: 0x6f6c63,
  weaponRange: navalGunEngageReach('naval_siege'),
  fireRateMs: 120_000,
  weaponDamage: 4200,
  mounts: [
    { id: 'main', localX: 0, localY: 0, baseAngle: 0, arcMin: -30 * DEG, arcMax: 30 * DEG, rotationSpeed: 0.03, weaponId: 'naval_siege', size: 'XL', barrels: 1, turretScale: 1.6 },
  ],
};

/** Every defence kind in the coastal-defences catalogue, smallest first. */
export const COASTAL_DEFENCE_KINDS = [
  'aa_quad_40mm', 'dp_mount_5in', 'coastal_casemate_8in', 'coastal_turret_11in',
  'coastal_barbette_16in', 'coastal_lindemann', 'siege_gun_80cm',
] as const satisfies readonly StructureKindId[];
