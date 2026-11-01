/**
 * Robot allegiance kinds (plan peppy-jumping-pinwheel). Simple geometric hulls —
 * the robots are an AI third party hostile to players, drones and traders.
 *
 * NPC-only (`npcOnly: true`): never a player ship, never in the random drone
 * pickers. APPEND-ONLY in `catalogueOrder.ts` (invariant #11).
 *
 * P0 ships the T1 square so the allegiance framework has a real cross-side kind
 * to test against; P1b appends the circle (T2) + hexagon (T3) + the director.
 */

import {
  ShipKindSchema,
  LEGACY_FORWARD_MOUNT,
  LEGACY_PRIMARY_SLOT,
  type ShipKind,
} from './types.js';

/** Robot palette — violet family so robots read as a distinct side at a glance. */
export const ROBOT_COLOR_T1 = 0xc070ff;

export const ROBOT_SQUARE: ShipKind = ShipKindSchema.parse({
  id: 'robot-square',
  displayName: 'Robot Cube',
  description: 'Tier-1 robot drone. A simple, relentless square.',
  allegiance: 'robots',
  npcOnly: true,
  thrustImpulse: 2.0,
  reverseFactor: 0.5,
  boostMultiplier: 1.5,
  maxAngvel: 2.2,
  maxSpeed: 700,
  linearDamping: 0.35,
  angularDamping: 0,
  lateralGrip: 0.03,
  radius: 12,
  maxHealth: 120,
  shieldMax: 80,
  shieldRegenDelayTicks: 360,
  shieldRegenRate: 80 / 120,
  energyMax: 150,
  energyRegenRate: 0.25,
  ai: { thrust: 0.85, turnKp: 6.0, maxTorque: 3.0 },
  shape: {
    kind: 'polygon',
    color: ROBOT_COLOR_T1,
    scale: 1,
    points: [
      [-10, -10],
      [10, -10],
      [10, 10],
      [-10, 10],
    ],
  },
  mounts: [{ ...LEGACY_FORWARD_MOUNT, weaponId: 'laser' }],
  slots: [LEGACY_PRIMARY_SLOT],
});

/** Regular N-gon outline (Pixi-up local space) — robots are pure geometry. */
function ngon(n: number, r: number, phase = 0): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const a = phase + (i / n) * Math.PI * 2;
    pts.push([Math.round(Math.cos(a) * r * 100) / 100, Math.round(Math.sin(a) * r * 100) / 100]);
  }
  return pts;
}

export const ROBOT_COLOR_T2 = 0x9a6bff;
export const ROBOT_COLOR_T3 = 0x6f4bff;

/** T2 — the circle (a 12-gon). Tougher; fires a continuous beam (P1b). */
export const ROBOT_CIRCLE: ShipKind = ShipKindSchema.parse({
  id: 'robot-circle',
  displayName: 'Robot Orb',
  description: 'Tier-2 robot drone. A rolling orb with a cutting beam.',
  allegiance: 'robots',
  npcOnly: true,
  thrustImpulse: 2.2,
  reverseFactor: 0.5,
  boostMultiplier: 1.5,
  maxAngvel: 2.6,
  maxSpeed: 650,
  linearDamping: 0.35,
  angularDamping: 0,
  lateralGrip: 0.03,
  radius: 15,
  maxHealth: 220,
  shieldMax: 140,
  shieldRegenDelayTicks: 360,
  shieldRegenRate: 140 / 120,
  energyMax: 200,
  energyRegenRate: 0.3,
  ai: { thrust: 0.8, turnKp: 6.5, maxTorque: 3.5 },
  shape: { kind: 'polygon', color: ROBOT_COLOR_T2, scale: 1, points: ngon(12, 13) },
  mounts: [{ ...LEGACY_FORWARD_MOUNT, weaponId: 'hitscan' }],
  slots: [LEGACY_PRIMARY_SLOT],
});

export const ROBOT_COLOR_NEXUS = 0x4b2bd6;

/**
 * Living World P3 — the robot NEXUS. A huge stationary octagon that anchors a
 * robot territory: while it lives, killed robots respawn AT the nexus instead
 * of entering from the galaxy edge (the robots-only ingress exception), and its
 * sector counts heavily toward robot control. It fires slow pulse orbs, never
 * moves (token thrust, 5 u/s cap, heavy damping), is never load-shed, and drops
 * the richest loot in the game when destroyed.
 */
export const ROBOT_NEXUS: ShipKind = ShipKindSchema.parse({
  id: 'robot-nexus',
  displayName: 'Robot Nexus',
  description: 'The heart of a robot territory. Reinforcements spawn here.',
  allegiance: 'robots',
  npcOnly: true,
  shedImmune: true,
  thrustImpulse: 0.01,
  reverseFactor: 0.5,
  boostMultiplier: 1,
  maxAngvel: 0.4,
  maxSpeed: 5,
  linearDamping: 3,
  angularDamping: 0,
  lateralGrip: 0.03,
  radius: 55,
  maxHealth: 6000,
  shieldMax: 2500,
  shieldRegenDelayTicks: 600,
  shieldRegenRate: 2500 / 600,
  energyMax: 400,
  energyRegenRate: 0.5,
  ai: { thrust: 0.01, turnKp: 2.0, maxTorque: 20.0 },
  shape: { kind: 'polygon', color: ROBOT_COLOR_NEXUS, scale: 1, points: ngon(8, 52, Math.PI / 8) },
  mounts: [{ ...LEGACY_FORWARD_MOUNT, weaponId: 'pulse-orb' }],
  slots: [LEGACY_PRIMARY_SLOT],
});

export const ROBOT_COLOR_HARVESTER = 0xd9a441;

/**
 * Living World P3b — the robot HARVESTER. Scoops up loot pods (the same atomic
 * pickup path players use), carries them in its own hold, and banks them into
 * the nexus. A killed harvester spills its cargo. Lightly armed; never squad-
 * flocked (the RobotTerritory steers it).
 */
export const ROBOT_HARVESTER: ShipKind = ShipKindSchema.parse({
  id: 'robot-harvester',
  displayName: 'Robot Harvester',
  description: 'A robot scavenger. Collects loot and hoards it at the nexus.',
  allegiance: 'robots',
  npcOnly: true,
  thrustImpulse: 2.4,
  reverseFactor: 0.5,
  boostMultiplier: 1.4,
  maxAngvel: 2.0,
  maxSpeed: 560,
  linearDamping: 0.4,
  angularDamping: 0,
  lateralGrip: 0.03,
  radius: 18,
  maxHealth: 300,
  shieldMax: 150,
  shieldRegenDelayTicks: 360,
  shieldRegenRate: 150 / 150,
  energyMax: 150,
  energyRegenRate: 0.25,
  ai: { thrust: 0.9, turnKp: 6.0, maxTorque: 4.0 },
  shape: {
    kind: 'polygon',
    color: ROBOT_COLOR_HARVESTER,
    scale: 1,
    // A wide scoop at the bow, narrow at the stern.
    points: [
      [-18, 16],
      [-8, 6],
      [8, 6],
      [18, 16],
      [12, -14],
      [-12, -14],
    ],
  },
  mounts: [{ ...LEGACY_FORWARD_MOUNT, weaponId: 'laser' }],
  slots: [LEGACY_PRIMARY_SLOT],
});

/** T3 — the hexagon. Heavy and slow; launches homing missiles (P1b). */
export const ROBOT_HEXAGON: ShipKind = ShipKindSchema.parse({
  id: 'robot-hexagon',
  displayName: 'Robot Hex',
  description: 'Tier-3 robot drone. A slow hexagonal missile launcher.',
  allegiance: 'robots',
  npcOnly: true,
  thrustImpulse: 3.0,
  reverseFactor: 0.5,
  boostMultiplier: 1.4,
  maxAngvel: 1.6,
  maxSpeed: 520,
  linearDamping: 0.4,
  angularDamping: 0,
  lateralGrip: 0.03,
  radius: 22,
  maxHealth: 420,
  shieldMax: 260,
  shieldRegenDelayTicks: 420,
  shieldRegenRate: 260 / 150,
  energyMax: 260,
  energyRegenRate: 0.35,
  ai: { thrust: 0.7, turnKp: 5.0, maxTorque: 5.0 },
  shape: { kind: 'polygon', color: ROBOT_COLOR_T3, scale: 1, points: ngon(6, 20, Math.PI / 6) },
  mounts: [{ ...LEGACY_FORWARD_MOUNT, weaponId: 'heat-seeker' }],
  slots: [LEGACY_PRIMARY_SLOT],
});
