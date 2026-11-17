/**
 * Loot pod (plan peppy-jumping-pinwheel P1a-1). NOT a flyable ship — a
 * catalogue entry so a pod can ride the existing SCRAP wire path (swarm kind 3)
 * with `parentShipKind = 'cargo-pod'` and `componentIndex` = the pod's SIZE
 * and GLOW TIER (`podComponentIndex`). The client already draws a scrap
 * piece by `(parentShipKind, componentIndex)` from `shipScrapGroups`, so
 * pods need ZERO wire change.
 *
 * One silhouette per (size, tier), size-major: index = size * 4 + tier.
 * Tiers: 0 grey (salvage / credits), 1 blue (alloy), 2 gold (core /
 * blueprint), 3 bright magenta (a dead PLAYER's spilled cargo). Sizes follow
 * the dead ship (owner 2026-11-17: one pod per ship, sized to it).
 *
 * npcOnly (never piloted, never a random drone). APPEND-ONLY (invariant #11).
 */
import { defineShipKind } from '../shipScale/defineShipKind.js';
import { type ShipKind } from './types.js';

/** Tier → glow colour (also used by the radar `loot` icon). */
export const POD_TIER_COLORS: readonly number[] = [0xb0b8c0, 0x4aa8ff, 0xffc83a, 0xff4fd8];
/** Tier of a dead player's spilled cargo. */
export const POD_TIER_SPILL = 3;
/** Tiers per size class (the stride of `podComponentIndex`). */
export const POD_TIERS = 4;

/** Pod size classes: drawn scale per class, smallest first. */
export const POD_SIZE_SCALES: readonly number[] = [1, 1.6, 2.5, 4];
/** Upper ship radius (world units) of each size class but the last: a fighter
 *  or drone, a frigate or hauler, a big robot or carrier, a capital. */
const POD_SIZE_MAX_SHIP_RADIUS: readonly number[] = [32, 64, 300];

/** The pod size class for a dead ship of hull radius `shipRadius`. */
export function podSizeClass(shipRadius: number): number {
  for (let i = 0; i < POD_SIZE_MAX_SHIP_RADIUS.length; i++) if (shipRadius <= POD_SIZE_MAX_SHIP_RADIUS[i]!) return i;
  return POD_SIZE_MAX_SHIP_RADIUS.length;
}

/** The wire `componentIndex` of a pod: size class and glow tier. */
export function podComponentIndex(size: number, tier: number): number {
  return size * POD_TIERS + tier;
}
/** The glow tier of a pod's `componentIndex`. */
export function podTierOf(componentIndex: number): number {
  return componentIndex % POD_TIERS;
}
/** The size class of a pod's `componentIndex`. */
export function podSizeOf(componentIndex: number): number {
  return Math.floor(componentIndex / POD_TIERS);
}

const DIAMOND: Array<[number, number]> = [[0, -9], [9, 0], [0, 9], [-9, 0]];

export const CARGO_POD: ShipKind = defineShipKind({
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
  ai: { thrust: 0.1 },
  aiRole: 'civilian',
  shape: {
    kind: 'composite',
    scale: 1,
    hull: DIAMOND,
    parts: POD_SIZE_SCALES.flatMap((k, size) => POD_TIER_COLORS.map((color, tier) => ({
      points: DIAMOND.map(([x, y]) => [x * k, y * k] as [number, number]),
      color,
      stroke: 0xffffff,
      strokeWidth: 1.5,
      offsetX: 0,
      offsetY: 0,
      role: size === 0 ? `pod${tier}` : `pod${size}-${tier}`,
      canScrap: true,
    }))),
  },
});
