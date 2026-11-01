/**
 * Blueprints (Living World P5, plan peppy-jumping-pinwheel).
 *
 * A blueprint is a rare, weightless loot item (`Hold.blueprints` carries ids).
 * Lifecycle: dropped by elites / world events → carried in a ship's hold →
 * banked in storage → INSTALLED onto the pilot's active ship at their storage →
 * lost when that ship is destroyed or abandoned.
 *
 * Installed blueprints live in a `fitted` hold keyed `fitted:<shipInstanceId>`,
 * so an install is ONE atomic hold move (storage → ship) — never minted,
 * never duplicated. Shared so the server's effect and the client's HUD agree
 * (#15): weapon gates, cargo capacity, hull.
 */
import { z } from 'zod';

export const BLUEPRINT_IDS = ['bp-missile-rack', 'bp-cargo-expander', 'bp-reinforced-hull'] as const;
export type BlueprintId = (typeof BLUEPRINT_IDS)[number];

export type BlueprintEffect =
  | { kind: 'weapon'; weaponId: 'heat-seeker' }
  | { kind: 'cargo'; mul: number }
  | { kind: 'hull'; mul: number };

export interface BlueprintDef {
  id: BlueprintId;
  displayName: string;
  description: string;
  effect: BlueprintEffect;
}

export const BLUEPRINTS: Readonly<Record<BlueprintId, BlueprintDef>> = {
  'bp-missile-rack': {
    id: 'bp-missile-rack',
    displayName: 'Missile Rack',
    description: 'Lets a spare hardpoint carry heat-seeking missiles.',
    effect: { kind: 'weapon', weaponId: 'heat-seeker' },
  },
  'bp-cargo-expander': {
    id: 'bp-cargo-expander',
    displayName: 'Cargo Expander',
    description: '+50% cargo capacity.',
    effect: { kind: 'cargo', mul: 1.5 },
  },
  'bp-reinforced-hull': {
    id: 'bp-reinforced-hull',
    displayName: 'Reinforced Hull',
    description: '+25% maximum hull.',
    effect: { kind: 'hull', mul: 1.25 },
  },
};

export function isBlueprintId(v: unknown): v is BlueprintId {
  return typeof v === 'string' && (BLUEPRINT_IDS as readonly string[]).includes(v);
}

/** The display name for a carried id (unknown ids read as a generic label). */
export function blueprintName(id: string): string {
  return isBlueprintId(id) ? BLUEPRINTS[id].displayName : 'Blueprint';
}

/** The fitted-blueprints hold for a ship instance. */
export function fittedUid(shipInstanceId: string): string {
  return `fitted:${shipInstanceId}`;
}

/** Weapons that need a blueprint before `activate_mount` will bind them. */
const WEAPON_GATES: Readonly<Record<string, BlueprintId>> = { 'heat-seeker': 'bp-missile-rack' };

/** True when `weaponId` may be fitted to a latent mount given `fitted`. */
export function weaponUnlocked(weaponId: string, fitted: readonly string[]): boolean {
  const need = WEAPON_GATES[weaponId];
  return need === undefined || fitted.includes(need);
}

/** The blueprint a gated weapon needs (null when it's free). */
export function weaponGate(weaponId: string): BlueprintId | null {
  return WEAPON_GATES[weaponId] ?? null;
}

/** Cargo-capacity multiplier from fitted blueprints. */
export function fittedCargoMul(fitted: readonly string[]): number {
  let m = 1;
  for (const id of fitted) {
    if (isBlueprintId(id)) {
      const e = BLUEPRINTS[id].effect;
      if (e.kind === 'cargo') m *= e.mul;
    }
  }
  return m;
}

/** Max-hull multiplier from fitted blueprints. */
export function fittedHullMul(fitted: readonly string[]): number {
  let m = 1;
  for (const id of fitted) {
    if (isBlueprintId(id)) {
      const e = BLUEPRINTS[id].effect;
      if (e.kind === 'hull') m *= e.mul;
    }
  }
  return m;
}

/** Roll a blueprint drop with probability `chance` (`rng` ∈ [0, 1)). */
export function rollBlueprint(rng: () => number, chance: number): BlueprintId | null {
  if (rng() >= chance) return null;
  return BLUEPRINT_IDS[Math.floor(rng() * BLUEPRINT_IDS.length)]!;
}

/** Drop chances. */
export const ELITE_BLUEPRINT_CHANCE = 0.4;
export const INCURSION_BLUEPRINT_CHANCE = 0.5;

/** Client → server: install `blueprintId` from my storage at `networkEntityId`
 *  onto my ACTIVE ship (which must be near that storage). */
export const InstallBlueprintSchema = z
  .object({
    networkEntityId: z.number().int().nonnegative(),
    blueprintId: z.enum(BLUEPRINT_IDS),
  })
  .strict();
export type InstallBlueprint = z.infer<typeof InstallBlueprintSchema>;

/** Server → client: the install verdict (accelerator; truth = the snapshot). */
export const BlueprintResultSchema = z
  .object({
    type: z.literal('blueprint_result'),
    ok: z.boolean(),
    message: z.string().max(200),
  })
  .strict();
export type BlueprintResult = z.infer<typeof BlueprintResultSchema>;
