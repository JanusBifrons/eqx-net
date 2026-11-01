/**
 * Trader allegiance kinds (plan peppy-jumping-pinwheel P2). The neutral side
 * that carries out trade deals: a hauler flies to a player's base, docks, and
 * leaves. Robots raid them; players may pirate them (at a reputation cost).
 *
 * NPC-only, and `shedImmune` — a hauler carries escrowed value, so the load
 * shedder must never quietly delete one. APPEND-ONLY in `catalogueOrder.ts`
 * (invariant #11).
 */
import { ShipKindSchema, LEGACY_FORWARD_MOUNT, LEGACY_PRIMARY_SLOT, type ShipKind } from './types.js';

export const TRADER_COLOR = 0x7fd6a8;

export const TRADER_HAULER: ShipKind = ShipKindSchema.parse({
  id: 'trader-hauler',
  displayName: 'Trade Hauler',
  description: 'A slow, armoured trader freighter. Carries deal cargo.',
  allegiance: 'traders',
  npcOnly: true,
  shedImmune: true,
  thrustImpulse: 4.0,
  reverseFactor: 0.4,
  boostMultiplier: 1.3,
  maxAngvel: 1.1,
  maxSpeed: 420,
  linearDamping: 0.45,
  angularDamping: 0,
  lateralGrip: 0.04,
  radius: 30,
  maxHealth: 900,
  shieldMax: 500,
  shieldRegenDelayTicks: 480,
  shieldRegenRate: 500 / 240,
  energyMax: 200,
  energyRegenRate: 0.25,
  ai: { thrust: 0.6, turnKp: 4.0, maxTorque: 8.0 },
  shape: {
    kind: 'polygon',
    color: TRADER_COLOR,
    scale: 1,
    // A long, boxy freighter: blunt bow, wide cargo midsection.
    points: [
      [-10, 34],
      [10, 34],
      [22, 18],
      [22, -26],
      [12, -34],
      [-12, -34],
      [-22, -26],
      [-22, 18],
    ],
  },
  mounts: [{ ...LEGACY_FORWARD_MOUNT, weaponId: 'laser' }],
  slots: [LEGACY_PRIMARY_SLOT],
});
