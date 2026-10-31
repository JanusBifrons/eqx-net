/**
 * Loot pod (plan peppy-jumping-pinwheel P1a-1). NOT a flyable ship — a
 * catalogue entry so a pod can ride the existing SCRAP wire path (swarm kind 3)
 * with `parentShipKind = 'cargo-pod'` and `componentIndex` = the pod's GLOW
 * TIER. The client already draws a scrap piece by `(parentShipKind,
 * componentIndex)` from `shipScrapGroups`, so pods need ZERO wire change.
 *
 * One silhouette per tier, in tier order (component index == tier):
 *   0 grey (salvage / credits), 1 blue (alloy), 2 gold (core / blueprint),
 *   3 bright magenta (a dead PLAYER's spilled cargo — invites a scramble).
 *
 * npcOnly (never piloted, never a random drone). APPEND-ONLY (invariant #11).
 */
import { ShipKindSchema, type ShipKind } from './types.js';

/** Tier → glow colour (also used by the radar `loot` icon). */
export const POD_TIER_COLORS: readonly number[] = [0xb0b8c0, 0x4aa8ff, 0xffc83a, 0xff4fd8];
/** `componentIndex` of a dead player's spilled cargo. */
export const POD_TIER_SPILL = 3;

const DIAMOND: Array<[number, number]> = [[0, -9], [9, 0], [0, 9], [-9, 0]];

export const CARGO_POD: ShipKind = ShipKindSchema.parse({
  id: 'cargo-pod',
  displayName: 'Cargo Pod',
  description: 'Loot. Fly over it to collect.',
  npcOnly: true,
  thrustImpulse: 1,
  reverseFactor: 0,
  boostMultiplier: 1,
  maxAngvel: 1,
  maxSpeed: 200,
  linearDamping: 0.6,
  angularDamping: 0,
  lateralGrip: 0,
  radius: 9,
  maxHealth: 30,
  shieldMax: 1,
  shieldRegenDelayTicks: 600,
  shieldRegenRate: 0.01,
  ai: { thrust: 0.1, turnKp: 1, maxTorque: 0.1 },
  shape: {
    kind: 'composite',
    scale: 1,
    hull: DIAMOND,
    parts: POD_TIER_COLORS.map((color, tier) => ({
      points: DIAMOND,
      color,
      stroke: 0xffffff,
      strokeWidth: 1.5,
      offsetX: 0,
      offsetY: 0,
      role: `pod${tier}`,
      canScrap: true,
    })),
  },
});
