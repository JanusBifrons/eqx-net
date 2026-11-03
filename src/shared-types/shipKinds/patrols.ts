/**
 * A military patrol fighter (plan soft-leaping-truffle v4, phase M2). A
 * garrison flies a squad of these round its approaches.
 *
 * Its allegiance is `traders`: no one is hostile to it on sight and it is
 * hostile to no one on sight, except robots, who attack everything. It engages
 * only pilots the room marks hostile to its owner (a hostile act against the
 * base, or standing below the owner's threshold). The owner's faction rides
 * the snapshot (`drones[].fac`), so clients tint it in the faction's colour.
 *
 * NPC-only and `shedImmune` (a patrol belongs to its base, and the room
 * respawns it; the load shedder must not quietly delete one). APPEND-ONLY in
 * `catalogueOrder.ts` (invariant #11).
 */
import { ShipKindSchema, LEGACY_FORWARD_MOUNT, LEGACY_PRIMARY_SLOT, type ShipKind } from './types.js';

export const PATROL_FIGHTER: ShipKind = ShipKindSchema.parse({
  id: 'patrol-fighter',
  displayName: 'Patrol Fighter',
  description: "A garrison's patrol craft. Leaves you alone unless you're hostile to its owner.",
  allegiance: 'traders',
  npcOnly: true,
  shedImmune: true,
  thrustImpulse: 2.0,
  reverseFactor: 0.5,
  boostMultiplier: 2.0,
  maxAngvel: 2.0,
  maxSpeed: 850,
  linearDamping: 0.3,
  angularDamping: 0,
  lateralGrip: 0.025,
  radius: 13,
  maxHealth: 220,
  shieldMax: 180,
  shieldRegenDelayTicks: 300,
  shieldRegenRate: 180 / 120,
  energyMax: 150,
  energyRegenRate: 0.25,
  ai: { thrust: 0.9, turnKp: 6.0, maxTorque: 3.0 },
  shape: {
    kind: 'polygon',
    // A neutral steel; clients tint it with its owner faction's colour.
    color: 0xb8c4d0,
    scale: 1,
    // A forward-swept dart with stubby wings.
    points: [
      [0, -18],
      [-6, -2],
      [-12, 10],
      [-4, 7],
      [0, 12],
      [4, 7],
      [12, 10],
      [6, -2],
    ],
  },
  mounts: [{ ...LEGACY_FORWARD_MOUNT, weaponId: 'laser' }],
  slots: [LEGACY_PRIMARY_SLOT],
});
