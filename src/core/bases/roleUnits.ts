/** The role's production units of a generated base (`growBase.ts`, step 1:
 *  "Plan"): what a builder adds for each base role. Pure. */
import type { StructureKindId } from '../../shared-types/structureKinds.js';
import type { RecipeId } from '../../shared-types/recipes.js';
import type { BaseProfile } from './baseProfile.js';
import type { SectorFeature } from '../galaxy/galaxy.js';

export interface Want {
  kind: StructureKindId;
  recipe?: RecipeId;
  /** v4 H — the transit link a teleporter ends. */
  link?: string;
}

/** The role's production units, in the order a builder adds them. */
export function roleUnits(profile: BaseProfile, features: readonly SectorFeature[], rnd: () => number): Want[] {
  const nebula = features.includes('nebula');
  const big = profile.tier === 'stronghold' || profile.tier === 'citadel';
  switch (profile.role) {
    case 'mining': {
      const out: Want[] = [{ kind: 'miner' }];
      if (nebula) out.push({ kind: 'gas_collector' });
      if (big) out.unshift({ kind: 'deep_core_rig' });
      return out;
    }
    case 'refinery': {
      const out: Want[] = [{ kind: 'smelter', recipe: 'smelt_alloy' }, { kind: 'refinery', recipe: nebula ? 'refine_gas' : 'refine_ice_fuel' }];
      if (features.includes('minerals') || features.includes('blackhole')) out.push({ kind: 'silicon_works', recipe: 'make_silicon' });
      out.push({ kind: 'reclaimer', recipe: 'reclaim_salvage' });
      if (big) out.unshift({ kind: 'ore_processing_complex', recipe: 'opc_alloy' });
      return out;
    }
    case 'workshop': {
      // Two adjacent stages of one chain, ending in a product it sells.
      const chains: Want[][] = [
        [{ kind: 'refinery', recipe: 'refine_ice_fuel' }, { kind: 'hydroponics', recipe: 'grow_provisions' }],
        [{ kind: 'smelter', recipe: 'smelt_alloy' }, { kind: 'fabricator', recipe: 'fab_components' }],
        [{ kind: 'refinery', recipe: nebula ? 'refine_gas' : 'refine_ice_fuel' }, { kind: 'munitions_works', recipe: 'make_munitions' }],
      ];
      return chains[Math.floor(rnd() * chains.length)]!;
    }
    case 'manufactory':
      return [
        { kind: 'fabricator', recipe: 'fab_components' },
        { kind: 'fabricator', recipe: 'fab_electronics' },
        { kind: 'munitions_works', recipe: 'make_munitions' },
      ];
    case 'assembly':
      return [
        { kind: 'assembly_plant', recipe: rnd() < 0.5 ? 'assemble_machinery' : 'assemble_consumer_goods' },
        { kind: 'fabricator', recipe: 'fab_components' },
        { kind: 'fabricator', recipe: 'fab_electronics' },
      ];
    case 'trade':
      return [{ kind: 'cargo_bay' }];
    case 'transit':
      // A hub's business is its teleporters (one per link, added below).
      return [{ kind: 'cargo_bay' }];
    case 'military':
      // v4 M — turret-heavy: every kind of gun, repeated while wealth lasts
      // (a fenced base puts them on bastions outside the fence). Coastal
      // defences: the AA screen, 5" mounts and the medium coastal guns too.
      return [
        { kind: 'laser_bolt_turret' }, { kind: 'autocannon_turret' }, { kind: 'missile_turret' }, { kind: 'turret' },
        { kind: 'aa_quad_40mm' }, { kind: 'dp_mount_5in' }, { kind: 'coastal_casemate_8in' }, { kind: 'coastal_turret_11in' },
      ];
    case 'colony': {
      // A habitat station: housing first, spires once it's a settlement or bigger, and
      // hydroponics to grow part of its own provisions.
      const out: Want[] = [
        { kind: 'habitat_module', recipe: 'habitat_upkeep' },
        { kind: 'habitat_module', recipe: 'habitat_upkeep' },
      ];
      if (profile.tier !== 'outpost') {
        out.push({ kind: 'tower_module', recipe: 'tower_upkeep' }, { kind: 'hydroponics', recipe: 'grow_provisions' });
      }
      return out;
    }
  }
}
