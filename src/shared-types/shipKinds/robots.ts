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
