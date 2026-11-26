/**
 * The growth generator's tally (`growBase.ts`): what a laid-out base draws,
 * its levels and the chain stages it runs. Shared by the row layout and the
 * deck layout (`growDeck.ts`), so both finish a base the same way.
 */
import { getStructureKind, type StructureKindId } from '../../shared-types/structureKinds.js';
import { RECIPES, recipesFor, type RecipeId } from '../../shared-types/recipes.js';
import { IDLE_DRAW_FRAC } from '../../shared-types/structurePower.js';
import type { BaseProfile } from './baseProfile.js';
import type { Builder, GrownPlacement } from './growBuilder.js';

export interface GrownBase {
  placements: GrownPlacement[];
  /** Index pairs into `placements`, in an order every `canConnect` passes. */
  edges: Array<readonly [number, number]>;
  /** Wealth actually spent. */
  spent: number;
  /** Net power with everything built. */
  netPower: number;
  fencePylons: number;
  fenceGates: number;
  /** Chain stages the base runs (0 raw … 3 end products). */
  stages: number[];
}

/**
 * Expected power draw of a structure on a typical day (user ruling
 * 2026-11-01): it draws full power only while active, a small idle trickle
 * otherwise (`structurePower.ts`), and no base runs everything at 100 %.
 * Processors are sized as busy ALL the time: an NPC base is stocked with
 * inputs, so its processors run back to back (sizing them at 60 % browned the
 * stronghold out every other pulse and dropped its fence — user report
 * 2026-11-02, `npcBasePowerStable.test.ts`). Drills 80 %, turrets 15 %;
 * shield emitters hold their walls on the trickle (a fence under fire is paid
 * from surplus and batteries). Generation is sized for this, not for peak.
 */
export const EXPECTED_ACTIVE: Readonly<Partial<Record<StructureKindId, number>>> = Object.freeze({
  miner: 0.8, gas_collector: 0.8, deep_core_rig: 0.8,
  reclaimer: 1, smelter: 1, refinery: 1, silicon_works: 1, hydroponics: 1,
  fabricator: 1, munitions_works: 1, ore_processing_complex: 1, assembly_plant: 1,
  turret: 0.15, laser_bolt_turret: 0.15, missile_turret: 0.15, autocannon_turret: 0.15,
  // Coastal defences: guns draw full power only while engaged, like turrets.
  aa_quad_40mm: 0.15, dp_mount_5in: 0.15, coastal_casemate_8in: 0.15, coastal_turret_11in: 0.15,
  coastal_barbette_16in: 0.15, coastal_lindemann: 0.15, siege_gun_80cm: 0.15,
  // A mine layer lays only until its field is full.
  mine_layer: 0.2,
  // D3 — residents live there around the clock.
  habitat_module: 0.9, tower_module: 0.9,
});

export function expectedDraw(kind: StructureKindId): number {
  const cons = getStructureKind(kind).powerConsumption;
  const u = EXPECTED_ACTIVE[kind] ?? 0;
  return cons * (u + (1 - u) * IDLE_DRAW_FRAC);
}

/** Stage each processor kind's main output belongs to (for the coverage rule). */
function stageOf(kind: StructureKindId, recipe: RecipeId | undefined): number | null {
  if (kind === 'miner' || kind === 'gas_collector' || kind === 'deep_core_rig') return 0;
  if (recipe === undefined) return null;
  const o = RECIPES[recipe].outputs[0];
  if (!o || !('good' in o)) return null;
  const g = o.good;
  if (g === 'alloy' || g === 'fuel' || g === 'polymer' || g === 'silicon' || g === 'provisions' || g === 'minerals') return 1;
  if (g === 'components' || g === 'electronics' || g === 'munitions') return 2;
  return 3;
}

/** Finish a laid-out base: levels (from `rnd`, after the layout's own
 *  draws), net power and chain stages. */
export function summariseGrown(B: Builder, profile: BaseProfile, rnd: () => number, spent: number, fencePylons: number, fenceGates: number): GrownBase {
  // Levels: wealthy bases upgrade processors and turrets up to their level cap.
  const upgradeable = new Set<StructureKindId>(['turret', 'smelter', 'refinery', 'fabricator', 'miner', 'solar']);
  for (const p of B.placements) {
    if (upgradeable.has(p.kind) && profile.levelCap > 1) p.level = 1 + Math.floor(rnd() * profile.levelCap);
  }

  let netPower = 0;
  for (const p of B.placements) {
    const k = getStructureKind(p.kind);
    netPower += k.powerOutput - expectedDraw(p.kind);
  }
  const stages = new Set<number>();
  for (const p of B.placements) {
    const s = stageOf(p.kind, p.recipe ?? (recipesFor as (k: string) => RecipeId[])(p.kind)?.[0]);
    if (s !== null) stages.add(s);
  }
  return {
    placements: B.placements,
    edges: B.edges,
    spent,
    netPower: Math.round(netPower),
    fencePylons,
    fenceGates,
    stages: [...stages].sort(),
  };
}
