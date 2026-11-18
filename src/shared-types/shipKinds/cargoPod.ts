/**
 * Loot pod (plan peppy-jumping-pinwheel P1a-1). NOT a flyable ship — a
 * catalogue entry so a pod can ride the existing SCRAP wire path (swarm kind 3)
 * with `parentShipKind = 'cargo-pod'` and `componentIndex` = the pod's SIZE
 * and GLOW TIER (`podComponentIndex`). The client already draws a scrap
 * piece by `(parentShipKind, componentIndex)` from `shipScrapGroups`, so
 * pods need ZERO wire change.
 *
 * One silhouette per (size, tier), size-major: index = size * 4 + tier.
 * Every pod is a red box (owner 2026-11-17: "kind of like a black box"); a
 * beacon in its centre shows the best thing inside. Beacon tiers: 0 grey
 * (salvage / credits), 1 blue (alloy), 2 gold (core / blueprint), 3 bright
 * magenta (a dead PLAYER's spilled cargo). Sizes follow the dead ship (one
 * pod per ship, sized to it).
 *
 * npcOnly (never piloted, never a random drone). APPEND-ONLY (invariant #11).
 */
import { defineShipKind } from '../shipScale/defineShipKind.js';
import { type ShipKind } from './types.js';

/** Tier → beacon colour. */
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

/** The box body, its dark seam band and the beacon (pre-size-scale). */
const BOX: Array<[number, number]> = [[-9, -7], [9, -7], [9, 7], [-9, 7]];
const SEAM: Array<[number, number]> = [[-9, -1.2], [9, -1.2], [9, 1.2], [-9, 1.2]];
const BEACON: Array<[number, number]> = [[0, -3.6], [3.6, 0], [0, 3.6], [-3.6, 0]];
const BOX_RED = 0xc4302a;
const BOX_EDGE = 0x5a0e0b;
const SEAM_RED = 0x7c1712;

/** Silhouette role of a pod's (size, tier); details hang off `<role>-`.
 *  Size 0 keeps the original `pod<tier>` names; no role is a prefix of
 *  another's detail prefix. */
function podRole(size: number, tier: number): string {
  return size === 0 ? `pod${tier}` : `podS${size}T${tier}`;
}
const scaled = (pts: Array<[number, number]>, k: number): Array<[number, number]> => pts.map(([x, y]) => [x * k, y * k] as [number, number]);

export const CARGO_POD: ShipKind = defineShipKind({
  id: 'cargo-pod',
  displayName: 'Cargo Pod',
  description: 'A black box: select it and open it to take what is inside.',
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
    hull: BOX,
    parts: POD_SIZE_SCALES.flatMap((k, size) => POD_TIER_COLORS.flatMap((color, tier) => {
      const role = podRole(size, tier);
      return [
        { points: scaled(BOX, k), color: BOX_RED, stroke: BOX_EDGE, strokeWidth: 1.5, offsetX: 0, offsetY: 0, role, canScrap: true },
        { points: scaled(SEAM, k), color: SEAM_RED, offsetX: 0, offsetY: 0, role: `${role}-seam` },
        { points: scaled(BEACON, k), color, stroke: 0xffffff, strokeWidth: 1, offsetX: 0, offsetY: 0, role: `${role}-beacon` },
      ];
    })),
  },
});
